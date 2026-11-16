/**
 * Two-workspace isolation matrix against DynamoDB Local: workspace B attempts
 * every data operation on workspace A's resources, and replays A's cursor on
 * every list operation. Every attempt must behave as "not found" (or be
 * refused), write nothing to A's data, and leave A's resources usable.
 */

import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../src/db/client";
import { resolveWorkspaceContext } from "../../src/tenancy/context";
import { consumeGitHubState, createGitHubState } from "../../src/db/operations/github-state.ops";
import { claimInstallation, getInstallation, listInstallations } from "../../src/db/operations/installation.ops";
import { getVerifiedListing, saveVerifiedListing } from "../../src/db/operations/listing.ops";
import { getRepo, listRepos, registerRepo, updateRepo } from "../../src/db/operations/tenant-repository.ops";
import {
  createDestination,
  getDestination,
  listDestinations,
  replaceDestinationWebhook,
  updateDestination,
} from "../../src/db/operations/tenant-destination.ops";
import { getDeliveryChildren, listDeliveries } from "../../src/db/operations/history.ops";
import { markDeliveryProcessed } from "../../src/db/operations/delivery.ops";
import { ContractError, type WorkspaceContext } from "../../src/contracts";
import { VALID_WEBHOOK, fakeWriter, ghId, newOwner, openSignups, verifiedInstallation, verifiedListing } from "./fixtures";
import { scanAll, tableName, useTestTable } from "./harness";

useTestTable();

interface Tenant {
  ctx: WorkspaceContext;
  gid: string;
  installationId: string;
  repoId: string;
  listingId: string;
  destinationId: string;
  deliveryId: string;
}

async function tenant(): Promise<Tenant> {
  const ctx = await newOwner();
  const gid = ghId();
  const installationId = ghId();
  const repoId = ghId();
  await claimInstallation(ctx, verifiedInstallation({ installationId, githubUserId: gid }));
  const { listingId } = await saveVerifiedListing(ctx, verifiedListing({ installationId, githubUserId: gid, repos: [{ repoId }] }));
  const { destinationId } = await createDestination(ctx, { displayName: "Alerts", webhookUrl: VALID_WEBHOOK }, fakeWriter());
  await registerRepo(ctx, { listingId, repoId, destinationId });

  const deliveryId = `iso-${repoId}`;
  await ddb.send(
    new PutCommand({
      TableName: tableName(),
      Item: { PK: `DELIVERY#${deliveryId}`, SK: `DELIVERY#${deliveryId}`, status: "processing", event_type: "push", github_repo_id: repoId, received_at: new Date().toISOString() },
    }),
  );
  await markDeliveryProcessed(deliveryId, { workspaceId: ctx.workspaceId, summary: { repo_full_name: "a/b", event_type: "push" } });
  return { ctx, gid, installationId, repoId, listingId, destinationId, deliveryId };
}

async function code(p: Promise<unknown>): Promise<string> {
  const e = await p.then(() => "resolved", (err: unknown) => err);
  return e instanceof ContractError ? e.code : String(e);
}

let a: Tenant;
let b: Tenant;
let aSnapshot: string;

/** A's own items (workspace partition plus records that carry A's workspace ID). */
async function aItems(): Promise<string> {
  const items = (await scanAll())
    .filter((i) => i.PK === `WS#${a.ctx.workspaceId}` || i.workspace_id === a.ctx.workspaceId)
    .map((i) => ({ ...i, updated_at: undefined }) as Record<string, unknown>);
  return JSON.stringify(items.sort((x, y) => `${x.PK}${x.SK}`.localeCompare(`${y.PK}${y.SK}`)));
}

beforeAll(async () => {
  await openSignups();
  a = await tenant();
  b = await tenant();
  aSnapshot = await aItems();
});

describe("workspace B acting on workspace A", () => {
  it("cannot resolve a context in A", async () => {
    await expect(resolveWorkspaceContext(b.ctx.userId, a.ctx.workspaceId)).resolves.toBeNull();
  });

  it("installations: get → null; list excludes; claim → installation_claimed", async () => {
    expect(await getInstallation(b.ctx, a.installationId)).toBeNull();
    expect((await listInstallations(b.ctx, { limit: 50 })).items.map((i) => i.installationId)).not.toContain(a.installationId);
    expect(await code(claimInstallation(b.ctx, verifiedInstallation({ installationId: a.installationId, githubUserId: b.gid })))).toBe(
      "installation_claimed",
    );
  });

  it("listings: save for A's installation → not_installation_owner; get A's snapshot → null", async () => {
    expect(await code(saveVerifiedListing(b.ctx, verifiedListing({ installationId: a.installationId, githubUserId: b.gid, repos: [] })))).toBe(
      "not_installation_owner",
    );
    expect(await getVerifiedListing(b.ctx, a.listingId)).toBeNull();
  });

  it("repositories: register from A's snapshot → listing_invalid; get → null; list excludes; update → not_found", async () => {
    expect(await code(registerRepo(b.ctx, { listingId: a.listingId, repoId: a.repoId }))).toBe("listing_invalid");
    expect(await getRepo(b.ctx, a.repoId)).toBeNull();
    expect((await listRepos(b.ctx, { limit: 50 })).items.map((r) => r.repoId)).not.toContain(a.repoId);
    expect(await code(updateRepo(b.ctx, a.repoId, { isActive: false }))).toBe("not_found");
  });

  it("destinations: get → null; list excludes; update / replace → not_found with no SSM write; cannot be assigned", async () => {
    expect(await getDestination(b.ctx, a.destinationId)).toBeNull();
    expect((await listDestinations(b.ctx, { limit: 50 })).items.map((d) => d.destinationId)).not.toContain(a.destinationId);
    expect(await code(updateDestination(b.ctx, a.destinationId, { displayName: "hijack" }))).toBe("not_found");
    const writer = fakeWriter();
    expect(await code(replaceDestinationWebhook(b.ctx, a.destinationId, VALID_WEBHOOK, writer))).toBe("not_found");
    expect(writer.calls).toHaveLength(0);
    expect(await code(updateRepo(b.ctx, b.repoId, { destinationId: a.destinationId }))).toBe("not_found");
  });

  it("history: list excludes A's delivery; children → null; re-stamping for B is refused", async () => {
    expect((await listDeliveries(b.ctx, { limit: 50 })).items.map((d) => d.deliveryId)).not.toContain(a.deliveryId);
    expect(await getDeliveryChildren(b.ctx, a.deliveryId)).toBeNull();
    await expect(
      markDeliveryProcessed(a.deliveryId, { workspaceId: b.ctx.workspaceId, summary: { repo_full_name: "x", event_type: "push" } }),
    ).rejects.toMatchObject({ name: "ConditionalCheckFailedException" });
  });

  it("OAuth state: B cannot consume A's state, and A still can", async () => {
    const { state } = await createGitHubState(a.ctx, "install");
    await expect(consumeGitHubState(b.ctx, state, "install")).resolves.toEqual({ ok: false, reason: "binding_mismatch" });
    await expect(consumeGitHubState(a.ctx, state, "install")).resolves.toEqual({ ok: true, purpose: "install" });
  });

  it("left every A item exactly as it was", async () => {
    expect(await aItems()).toBe(aSnapshot);
    const repo = await ddb.send(new GetCommand({ TableName: tableName(), Key: { PK: `REPO#${a.repoId}`, SK: "CONFIG" }, ConsistentRead: true }));
    expect(repo.Item).toMatchObject({ workspace_id: a.ctx.workspaceId, is_active: true, discord_destination_id: a.destinationId });
  });
});

describe("cursors never cross workspaces", () => {
  it.each([
    ["installations", (ctx: WorkspaceContext, cursor?: string) => listInstallations(ctx, { limit: 1, cursor })],
    ["repositories", (ctx: WorkspaceContext, cursor?: string) => listRepos(ctx, { limit: 1, cursor })],
    ["destinations", (ctx: WorkspaceContext, cursor?: string) => listDestinations(ctx, { limit: 1, cursor })],
    ["deliveries", (ctx: WorkspaceContext, cursor?: string) => listDeliveries(ctx, { limit: 1, cursor })],
  ])("A's %s cursor is invalid_request for B", async (_label, list) => {
    const page = await list(a.ctx);
    expect(page.nextCursor).toBeDefined(); // DynamoDB returns a key when the limit is reached
    expect(await code(list(b.ctx, page.nextCursor))).toBe("invalid_request");
    await expect(list(a.ctx, page.nextCursor)).resolves.toBeDefined(); // still valid for A
  });
});
