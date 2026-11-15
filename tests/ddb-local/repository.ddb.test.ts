/**
 * Listing snapshots and repository registration against DynamoDB Local:
 * snapshot validity, the admin requirement, ownership conflicts, the
 * active-repository limit with deactivate/reactivate, destination assignment
 * and clearing (REMOVE, never null), and workspace isolation.
 */

import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../src/db/client";
import { claimInstallation } from "../../src/db/operations/installation.ops";
import { getVerifiedListing, saveVerifiedListing } from "../../src/db/operations/listing.ops";
import { getRepo, listRepos, registerRepo, updateRepo } from "../../src/db/operations/tenant-repository.ops";
import { createDestination, updateDestination } from "../../src/db/operations/tenant-destination.ops";
import { ContractError, WORKSPACE_LIMITS, type WorkspaceContext } from "../../src/contracts";
import { VALID_WEBHOOK, fakeWriter, ghId, newOwner, openSignups, verifiedInstallation, verifiedListing } from "./fixtures";
import { itemsWith, tableName, useTestTable } from "./harness";

useTestTable();
beforeAll(openSignups);

async function code(p: Promise<unknown>): Promise<string> {
  const e = await p.then(() => undefined, (err: unknown) => err);
  return e instanceof ContractError ? e.code : `not a ContractError: ${String(e)}`;
}

/** A workspace with one claimed installation, ready to save listings. */
async function setup() {
  const ctx = await newOwner();
  const gid = ghId();
  const iid = ghId();
  await claimInstallation(ctx, verifiedInstallation({ installationId: iid, githubUserId: gid }));
  const listing = async (repos: Array<{ repoId: string; admin?: boolean }>, verifiedAt?: string) =>
    saveVerifiedListing(ctx, verifiedListing({ installationId: iid, githubUserId: gid, repos, verifiedAt }), verifiedAt ? Date.parse(verifiedAt) : Date.now());
  return { ctx, gid, iid, listing };
}

async function activeRepoCount(ctx: WorkspaceContext): Promise<number | undefined> {
  const out = await ddb.send(new GetCommand({ TableName: tableName(), Key: { PK: `WS#${ctx.workspaceId}`, SK: "META" }, ConsistentRead: true }));
  return out.Item?.active_repo_count as number | undefined;
}

describe("listing snapshots", () => {
  it("stores the repos for 15 minutes, bound to workspace, installation and GitHub account, with no token", async () => {
    const { ctx, gid, iid, listing } = await setup();
    const snap = await listing([{ repoId: "101" }, { repoId: "102", admin: false }]);

    const [item] = await itemsWith(`GHLISTING#${snap.listingId}`);
    expect(item).toMatchObject({ workspace_id: ctx.workspaceId, installation_id: iid, github_user_id: gid });
    expect(Object.keys(item).sort()).toEqual(
      ["PK", "SK", "listing_id", "workspace_id", "installation_id", "github_user_id", "repos", "verified_at", "ttl"].sort(),
    );
    expect(JSON.stringify(item)).not.toMatch(/gh[pousr]_|token/i);
    expect(Number(item.ttl) - Math.floor(Date.parse(String(item.verified_at)) / 1000)).toBe(900);
  });

  it("is refused for an installation this workspace has not claimed", async () => {
    const { ctx, gid } = await setup();
    expect(await code(saveVerifiedListing(ctx, verifiedListing({ installationId: ghId(), githubUserId: gid, repos: [] })))).toBe(
      "not_installation_owner",
    );
  });

  it("is refused for a GitHub account other than the workspace's", async () => {
    const { ctx, iid } = await setup();
    expect(await code(saveVerifiedListing(ctx, verifiedListing({ installationId: iid, githubUserId: ghId(), repos: [] })))).toBe(
      "github_identity_mismatch",
    );
  });

  it("an expired snapshot is not returned", async () => {
    const { ctx, listing } = await setup();
    const snap = await listing([{ repoId: "201" }]);
    expect(await getVerifiedListing(ctx, snap.listingId)).not.toBeNull();
    expect(await getVerifiedListing(ctx, snap.listingId, Date.now() + 15 * 60_000 + 1000)).toBeNull();
  });

  it("another workspace's snapshot is not returned", async () => {
    const a = await setup();
    const b = await setup();
    const snap = await a.listing([{ repoId: "301" }]);
    expect(await getVerifiedListing(b.ctx, snap.listingId)).toBeNull();
  });
});

describe("registerRepo", () => {
  it("registers an admin repo from a fresh snapshot", async () => {
    const { ctx, iid, listing } = await setup();
    const snap = await listing([{ repoId: "1001" }]);

    const repo = await registerRepo(ctx, { listingId: snap.listingId, repoId: "1001", watchedBranch: "develop" });

    expect(repo).toMatchObject({ repoId: "1001", workspaceId: ctx.workspaceId, installationId: iid, watchedBranch: "develop", isActive: true });
    const [item] = await itemsWith("REPO#1001", "CONFIG");
    expect(item).toMatchObject({ GSI1PK: `WS#${ctx.workspaceId}#REPO`, ownership_verified_at: snap.verifiedAt });
    expect(item).not.toHaveProperty("discord_webhook_url");
    expect(item).not.toHaveProperty("discord_destination_id");
    expect(await activeRepoCount(ctx)).toBe(1);
  });

  it.each([
    ["an expired snapshot", "listing_invalid", true],
    ["a repo missing from the snapshot", "repo_not_verified", false],
  ])("refuses %s", async (_label, expected, expire) => {
    const { ctx, listing } = await setup();
    const snap = await listing([{ repoId: "1101" }]);
    const now = expire ? Date.now() + 16 * 60_000 : Date.now();
    expect(await code(registerRepo(ctx, { listingId: snap.listingId, repoId: expire ? "1101" : "9999" }, now))).toBe(expected);
  });

  it("refuses a repo where the user is not an admin", async () => {
    const { ctx, listing } = await setup();
    const snap = await listing([{ repoId: "1201", admin: false }]);
    expect(await code(registerRepo(ctx, { listingId: snap.listingId, repoId: "1201" }))).toBe("repo_not_verified");
    expect(await itemsWith("REPO#1201")).toHaveLength(0);
  });

  it("refuses another workspace's snapshot", async () => {
    const a = await setup();
    const b = await setup();
    const snap = await a.listing([{ repoId: "1301" }]);
    expect(await code(registerRepo(b.ctx, { listingId: snap.listingId, repoId: "1301" }))).toBe("listing_invalid");
  });

  it("refuses a repo already registered to another workspace", async () => {
    const a = await setup();
    const b = await setup();
    await registerRepo(a.ctx, { listingId: (await a.listing([{ repoId: "1401" }])).listingId, repoId: "1401" });
    expect(await code(registerRepo(b.ctx, { listingId: (await b.listing([{ repoId: "1401" }])).listingId, repoId: "1401" }))).toBe(
      "repo_claimed",
    );
    expect(await activeRepoCount(b.ctx)).toBeUndefined();
  });

  it("can never take over an existing repo record that has no workspace", async () => {
    await ddb.send(new PutCommand({ TableName: tableName(), Item: { PK: "REPO#1501", SK: "CONFIG", github_repo_id: "1501", is_active: true } }));
    const { ctx, listing } = await setup();
    expect(await code(registerRepo(ctx, { listingId: (await listing([{ repoId: "1501" }])).listingId, repoId: "1501" }))).toBe(
      "repo_claimed",
    );
  });

  it("re-registering an active repo is idempotent and does not count twice", async () => {
    const { ctx, listing } = await setup();
    const snap = await listing([{ repoId: "1601" }]);
    await registerRepo(ctx, { listingId: snap.listingId, repoId: "1601" });
    await registerRepo(ctx, { listingId: snap.listingId, repoId: "1601" });
    expect(await activeRepoCount(ctx)).toBe(1);
  });

  it(`enforces ${WORKSPACE_LIMITS.activeRepos} active repos, including deactivate and reactivate`, async () => {
    const { ctx, listing } = await setup();
    const ids = Array.from({ length: WORKSPACE_LIMITS.activeRepos + 1 }, (_, i) => String(20_000 + i));
    const snap = await listing(ids.map((repoId) => ({ repoId })));

    for (const id of ids.slice(0, WORKSPACE_LIMITS.activeRepos)) await registerRepo(ctx, { listingId: snap.listingId, repoId: id });
    expect(await activeRepoCount(ctx)).toBe(WORKSPACE_LIMITS.activeRepos);

    const extra = ids[WORKSPACE_LIMITS.activeRepos];
    expect(await code(registerRepo(ctx, { listingId: snap.listingId, repoId: extra }))).toBe("repo_limit_reached");
    expect(await itemsWith(`REPO#${extra}`)).toHaveLength(0);

    await updateRepo(ctx, ids[0], { isActive: false });
    expect(await activeRepoCount(ctx)).toBe(WORKSPACE_LIMITS.activeRepos - 1);
    await registerRepo(ctx, { listingId: snap.listingId, repoId: extra });

    expect(await code(updateRepo(ctx, ids[0], { isActive: true }))).toBe("repo_limit_reached");
    await updateRepo(ctx, ids[1], { isActive: false });
    await expect(updateRepo(ctx, ids[0], { isActive: true })).resolves.toMatchObject({ isActive: true });
    expect(await activeRepoCount(ctx)).toBe(WORKSPACE_LIMITS.activeRepos);

    // Repeating a state change does not move the counter.
    await updateRepo(ctx, ids[0], { isActive: true });
    await updateRepo(ctx, ids[1], { isActive: false });
    expect(await activeRepoCount(ctx)).toBe(WORKSPACE_LIMITS.activeRepos);
  }, 60_000);

  it("concurrent registrations never exceed the limit", async () => {
    const { ctx, listing } = await setup();
    const ids = Array.from({ length: WORKSPACE_LIMITS.activeRepos + 10 }, (_, i) => String(40_000 + i));
    const snap = await listing(ids.map((repoId) => ({ repoId })));
    const results = await Promise.allSettled(ids.map((id) => registerRepo(ctx, { listingId: snap.listingId, repoId: id })));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBeLessThanOrEqual(WORKSPACE_LIMITS.activeRepos);
    expect(await activeRepoCount(ctx)).toBe(ok);
  }, 60_000);
});

describe("repo destinations", () => {
  it("assigns an active destination of this workspace and clears it with REMOVE", async () => {
    const { ctx, listing } = await setup();
    const dest = await createDestination(ctx, { displayName: "Alerts", webhookUrl: VALID_WEBHOOK }, fakeWriter());
    const snap = await listing([{ repoId: "5001" }]);

    await registerRepo(ctx, { listingId: snap.listingId, repoId: "5001", destinationId: dest.destinationId });
    expect((await itemsWith("REPO#5001"))[0]).toMatchObject({ discord_destination_id: dest.destinationId });

    await expect(updateRepo(ctx, "5001", { destinationId: null })).resolves.not.toHaveProperty("destinationId");
    const [item] = await itemsWith("REPO#5001");
    expect(item).not.toHaveProperty("discord_destination_id"); // removed, not null
  });

  it("refuses an inactive destination and another workspace's destination", async () => {
    const a = await setup();
    const b = await setup();
    const inactive = await createDestination(a.ctx, { displayName: "Old", webhookUrl: VALID_WEBHOOK }, fakeWriter());
    await updateDestination(a.ctx, inactive.destinationId, { isActive: false });
    const foreign = await createDestination(b.ctx, { displayName: "B", webhookUrl: VALID_WEBHOOK }, fakeWriter());
    const snap = await a.listing([{ repoId: "5101" }, { repoId: "5102" }]);

    expect(await code(registerRepo(a.ctx, { listingId: snap.listingId, repoId: "5101", destinationId: inactive.destinationId }))).toBe(
      "destination_not_active",
    );
    expect(await code(registerRepo(a.ctx, { listingId: snap.listingId, repoId: "5102", destinationId: foreign.destinationId }))).toBe(
      "not_found",
    );
    await registerRepo(a.ctx, { listingId: snap.listingId, repoId: "5101" });
    expect(await code(updateRepo(a.ctx, "5101", { destinationId: foreign.destinationId }))).toBe("not_found");
  });
});

describe("repository isolation", () => {
  it("get, list, update and cursors never cross workspaces", async () => {
    const a = await setup();
    const b = await setup();
    const snap = await a.listing([{ repoId: "6001" }, { repoId: "6002" }, { repoId: "6003" }]);
    for (const id of ["6001", "6002", "6003"]) await registerRepo(a.ctx, { listingId: snap.listingId, repoId: id });

    expect(await getRepo(b.ctx, "6001")).toBeNull();
    expect(await code(updateRepo(b.ctx, "6001", { watchedBranch: "x" }))).toBe("not_found");
    expect((await listRepos(b.ctx, { limit: 50 })).items).toHaveLength(0);

    const p1 = await listRepos(a.ctx, { limit: 2 });
    const p2 = await listRepos(a.ctx, { limit: 2, cursor: p1.nextCursor });
    expect([...p1.items, ...p2.items].map((r) => r.repoId).sort()).toEqual(["6001", "6002", "6003"]);
    expect(await code(listRepos(b.ctx, { limit: 2, cursor: p1.nextCursor }))).toBe("invalid_request");
  });
});
