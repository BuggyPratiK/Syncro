/**
 * The workspace webhook path end to end, against DynamoDB Local: the real
 * Lambda handler, a fake Discord `fetch`, a fake SSM reader for destination
 * URLs, and the mocked GitHub App for enrichment. No AWS or network access.
 */

import { createHmac } from "crypto";
import { APIGatewayProxyEvent, Context } from "aws-lambda";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { handler } from "../../src/handler";
import { ddb } from "../../src/db/client";
import { setParameterReaderForTests } from "../../src/config/secrets";
import { setDestinationSecretReaderForTests } from "../../src/notifications/engine";
import { claimInstallation } from "../../src/db/operations/installation.ops";
import { saveVerifiedListing } from "../../src/db/operations/listing.ops";
import { registerRepo, updateRepo } from "../../src/db/operations/tenant-repository.ops";
import { createDestination } from "../../src/db/operations/tenant-destination.ops";
import {
  DeliveryChildrenIncompleteError,
  getDeliveryChildren,
  listDeliveries,
  setCommitScanLimitsForTests,
} from "../../src/db/operations/history.ops";
import { markDeliveryFailed, markDeliveryProcessed } from "../../src/db/operations/delivery.ops";
import { DestinationSecretError } from "../../src/secrets/destination-secrets";
import type { WorkspaceContext } from "../../src/contracts";
import { VALID_WEBHOOK, fakeWriter, ghId, newOwner, openSignups, verifiedInstallation, verifiedListing } from "./fixtures";
import { tableName, useTestTable } from "./harness";

useTestTable();

const SECRET = "ddb-webhook-secret";
const context = { awsRequestId: "ddb-req", getRemainingTimeInMillis: () => 15_000 } as unknown as Context;
const sends: string[] = [];
let readerMode: "ok" | "secret_unavailable" = "ok";

/** A workspace with a claimed installation, a destination and one registered repo. */
interface World {
  ctx: WorkspaceContext;
  installationId: string;
  repoId: string;
  destinationId: string;
}

async function world(opts: { withDestination?: boolean } = {}): Promise<World> {
  const ctx = await newOwner();
  const gid = ghId();
  const installationId = ghId();
  const repoId = ghId();
  await claimInstallation(ctx, verifiedInstallation({ installationId, githubUserId: gid }));
  const snap = await saveVerifiedListing(ctx, verifiedListing({ installationId, githubUserId: gid, repos: [{ repoId }] }));
  const dest = await createDestination(ctx, { displayName: "Alerts", webhookUrl: VALID_WEBHOOK }, fakeWriter());
  await registerRepo(ctx, {
    listingId: snap.listingId,
    repoId,
    ...(opts.withDestination === false ? {} : { destinationId: dest.destinationId }),
  });
  return { ctx, installationId, repoId, destinationId: dest.destinationId };
}

function pushBody(w: { repoId: string; installationId: string | number }, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ref: "refs/heads/main",
    before: "0".repeat(40),
    after: "b".repeat(40),
    compare: "https://github.com/acme/r/compare/a...b",
    deleted: false,
    forced: false,
    created: false,
    head_commit: null,
    pusher: { name: "pratik", email: "p@example.com" },
    sender: { login: "pratik", id: 1 },
    repository: { id: Number(w.repoId), full_name: "acme/r", name: "r", owner: { login: "acme", id: 1 }, html_url: "https://github.com/acme/r" },
    installation: { id: Number(w.installationId) },
    commits: [
      {
        id: "b".repeat(40),
        tree_id: "t",
        distinct: true,
        message: "feat: ship it",
        timestamp: "2026-11-15T00:00:00Z",
        url: "https://github.com/acme/r/commit/b",
        author: { name: "P", email: "p@example.com" },
        committer: { name: "P", email: "p@example.com" },
        added: ["a.ts"],
        removed: [],
        modified: [],
      },
    ],
    ...extra,
  });
}

let deliveryCounter = 0;
async function deliver(body: string, deliveryId = `d-${Date.now()}-${++deliveryCounter}`) {
  const event = {
    httpMethod: "POST",
    path: "/webhooks/github",
    body,
    isBase64Encoded: false,
    headers: {
      "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
      "x-github-event": "push",
      "x-github-delivery": deliveryId,
    },
  } as unknown as APIGatewayProxyEvent;
  const res = await handler(event, context);
  return { status: res.statusCode, deliveryId };
}

async function delivery(id: string) {
  const out = await ddb.send(new GetCommand({ TableName: tableName(), Key: { PK: `DELIVERY#${id}`, SK: `DELIVERY#${id}` }, ConsistentRead: true }));
  return out.Item as Record<string, unknown> | undefined;
}

beforeAll(async () => {
  await openSignups();
  setParameterReaderForTests(async (name) => (name.endsWith("/sender/github-webhook-secret") ? SECRET : "dummy-private-key"));
  setDestinationSecretReaderForTests({
    read: async (ref, expectedName) => {
      if (ref.name !== expectedName) throw new DestinationSecretError("secret_unavailable");
      if (readerMode !== "ok") throw new DestinationSecretError(readerMode);
      return VALID_WEBHOOK;
    },
  });
  global.fetch = jest.fn(async (url: unknown) => {
    sends.push(String(url));
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
});

beforeEach(() => {
  sends.length = 0;
  readerMode = "ok";
});

describe("workspace delivery path", () => {
  it("sends once, stamps the delivery into the workspace's history, and tags children", async () => {
    const w = await world();
    const { status, deliveryId } = await deliver(pushBody(w));

    expect(status).toBe(200);
    expect(sends).toEqual([VALID_WEBHOOK.replace(/\?.*$/, "")]);

    const d = await delivery(deliveryId);
    expect(d).toMatchObject({
      status: "processed",
      workspace_id: w.ctx.workspaceId,
      GSI1PK: `WS#${w.ctx.workspaceId}#DELIVERY`,
      summary: { repo_full_name: "acme/r", event_type: "push", branch: "main", commit_count: 1, head_short_sha: "bbbbbbb" },
    });
    expect(d?.created_at).toBe(d?.received_at); // created_at taken from received_at

    const history = await listDeliveries(w.ctx, { limit: 10 });
    expect(history.items.map((i) => i.deliveryId)).toEqual([deliveryId]);
    expect(history.items[0]).toMatchObject({ status: "processed", summary: { repoFullName: "acme/r", commitCount: 1 } });

    const children = await getDeliveryChildren(w.ctx, deliveryId);
    expect(children?.notifications).toEqual([expect.objectContaining({ channel: "discord", destinationId: w.destinationId, status: "sent" })]);
    expect(children?.commits).toEqual([expect.objectContaining({ sha: "b".repeat(40), message: "feat: ship it" })]);
  });

  it("a redelivery of the same GitHub delivery sends nothing more", async () => {
    const w = await world();
    const body = pushBody(w);
    const first = await deliver(body);
    const second = await deliver(body, first.deliveryId);
    expect(second.status).toBe(200);
    expect(sends).toHaveLength(1);
  });

  it("another workspace never sees the delivery or its children", async () => {
    const a = await world();
    const b = await world();
    const { deliveryId } = await deliver(pushBody(a));

    expect((await listDeliveries(b.ctx, { limit: 50 })).items.map((i) => i.deliveryId)).not.toContain(deliveryId);
    expect(await getDeliveryChildren(b.ctx, deliveryId)).toBeNull();
  });

  it("ignores a suspended workspace: no send, no stamp, not in history", async () => {
    const w = await world();
    await ddb.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { PK: `WS#${w.ctx.workspaceId}`, SK: "META" },
        UpdateExpression: "SET #s = :s",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": "suspended" },
      }),
    );
    const { status, deliveryId } = await deliver(pushBody(w));

    expect(status).toBe(200);
    expect(sends).toHaveLength(0);
    const d = await delivery(deliveryId);
    expect(d).toMatchObject({ status: "ignored", error_message: "workspace_not_active" });
    expect(d).not.toHaveProperty("workspace_id");
    expect(d).not.toHaveProperty("GSI1PK");
  });

  it("ignores a repository record without a workspace as repo_not_tenant, even with a stored URL", async () => {
    const repoId = ghId();
    await ddb.send(
      new PutCommand({
        TableName: tableName(),
        Item: {
          PK: `REPO#${repoId}`,
          SK: "CONFIG",
          github_repo_id: repoId,
          is_active: true,
          watched_branch: "main",
          discord_webhook_url: "https://discord.com/api/webhooks/1/legacy-token",
        },
      }),
    );
    const { status, deliveryId } = await deliver(pushBody({ repoId, installationId: ghId() }));

    expect(status).toBe(200);
    expect(sends).toHaveLength(0);
    expect(await delivery(deliveryId)).toMatchObject({ status: "ignored", error_message: "repo_not_tenant" });
  });

  it("ignores a payload from a different installation than the repo was registered under", async () => {
    const w = await world();
    const { deliveryId } = await deliver(pushBody({ repoId: w.repoId, installationId: ghId() }));
    expect(sends).toHaveLength(0);
    expect(await delivery(deliveryId)).toMatchObject({ status: "ignored", error_message: "installation_mismatch" });
  });

  it("ignores an inactive repository and an unwatched branch", async () => {
    const w = await world();
    const { deliveryId } = await deliver(pushBody(w, { ref: "refs/heads/feature/x" }));
    expect(await delivery(deliveryId)).toMatchObject({ status: "ignored", error_message: "branch_not_watched" });

    await updateRepo(w.ctx, w.repoId, { isActive: false });
    const second = await deliver(pushBody(w));
    expect(await delivery(second.deliveryId)).toMatchObject({ status: "ignored", error_message: "repo_inactive" });
    expect(sends).toHaveLength(0);
  });

  it("a repo without a destination is processed and stamped with zero targets", async () => {
    const w = await world({ withDestination: false });
    const { deliveryId } = await deliver(pushBody(w));
    expect(sends).toHaveLength(0);
    expect(await delivery(deliveryId)).toMatchObject({ status: "processed", workspace_id: w.ctx.workspaceId });
    expect((await getDeliveryChildren(w.ctx, deliveryId))?.notifications).toEqual([]);
  });

  it("a destination still pending its secret is never a target", async () => {
    const w = await world();
    await ddb.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { PK: `WS#${w.ctx.workspaceId}`, SK: `DEST#${w.destinationId}` },
        UpdateExpression: "SET #s = :p REMOVE secret_ref",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":p": "pending_secret" },
      }),
    );
    await deliver(pushBody(w));
    expect(sends).toHaveLength(0);
  });

  it("when the URL cannot be read, records the notification as failed and sends nothing", async () => {
    const w = await world();
    readerMode = "secret_unavailable";
    const { deliveryId } = await deliver(pushBody(w));

    expect(sends).toHaveLength(0);
    const children = await getDeliveryChildren(w.ctx, deliveryId);
    expect(children?.notifications).toEqual([expect.objectContaining({ status: "failed", errorMessage: "secret_unavailable" })]);
  });
});

describe("delivery children: bounded commit scan", () => {
  afterEach(() => setCommitScanLimitsForTests(undefined));

  async function seedOtherCommits(repoId: string, ws: string, n: number) {
    for (let i = 0; i < n; i++) {
      await ddb.send(
        new PutCommand({
          TableName: tableName(),
          Item: { PK: `REPO#${repoId}`, SK: `COMMIT#other${String(i).padStart(36, "0")}`, delivery_id: "other-delivery", workspace_id: ws, sha: `other${i}` },
        }),
      );
    }
  }

  it("returns the complete list when the scan finishes within its bound", async () => {
    const w = await world();
    const { deliveryId } = await deliver(pushBody(w));
    await seedOtherCommits(w.repoId, w.ctx.workspaceId, 4); // 5 commits in the partition
    setCommitScanLimitsForTests({ pageSize: 2, maxPages: 3 }); // room for 6

    const children = await getDeliveryChildren(w.ctx, deliveryId);
    expect(children?.commits.map((c) => c.sha)).toEqual(["b".repeat(40)]);
  });

  it("fails closed instead of returning a partial list when commits remain after the last allowed page", async () => {
    const w = await world();
    const { deliveryId } = await deliver(pushBody(w));
    await seedOtherCommits(w.repoId, w.ctx.workspaceId, 4); // 5 commits in the partition
    setCommitScanLimitsForTests({ pageSize: 2, maxPages: 2 }); // room for only 4

    await expect(getDeliveryChildren(w.ctx, deliveryId)).rejects.toBeInstanceOf(DeliveryChildrenIncompleteError);
  });
});

describe("delivery stamping", () => {
  it("a failed delivery is stamped and listed as failed with a masked error", async () => {
    const w = await world();
    const id = `stamp-fail-${Date.now()}`;
    await ddb.send(new PutCommand({ TableName: tableName(), Item: { PK: `DELIVERY#${id}`, SK: `DELIVERY#${id}`, status: "processing", event_type: "push", received_at: "2026-11-15T01:00:00.000Z", github_repo_id: w.repoId } }));

    await markDeliveryFailed(id, "post to https://discord.com/api/webhooks/1/tok-secret failed", {
      workspaceId: w.ctx.workspaceId,
      summary: { repo_full_name: "acme/r", event_type: "push" },
    });

    const listed = (await listDeliveries(w.ctx, { limit: 50 })).items.find((i) => i.deliveryId === id);
    expect(listed).toMatchObject({ status: "failed", receivedAt: "2026-11-15T01:00:00.000Z" });
    expect(listed?.errorMessage).not.toContain("tok-secret");
  });

  it("a delivery stamped for one workspace can never be re-stamped for another", async () => {
    const a = await world();
    const b = await world();
    const { deliveryId } = await deliver(pushBody(a));

    await expect(
      markDeliveryProcessed(deliveryId, { workspaceId: b.ctx.workspaceId, summary: { repo_full_name: "x", event_type: "push" } }),
    ).rejects.toMatchObject({ name: "ConditionalCheckFailedException" });
    expect(await delivery(deliveryId)).toMatchObject({ workspace_id: a.ctx.workspaceId });
  });

  it("lists newest first and pages with a workspace-bound cursor", async () => {
    const w = await world();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await deliver(pushBody(w))).deliveryId);
      await new Promise((r) => setTimeout(r, 15)); // distinct received_at
    }
    const p1 = await listDeliveries(w.ctx, { limit: 2 });
    const p2 = await listDeliveries(w.ctx, { limit: 2, cursor: p1.nextCursor });
    expect([...p1.items, ...p2.items].map((i) => i.deliveryId)).toEqual([...ids].reverse());

    const other = await world();
    await expect(listDeliveries(other.ctx, { limit: 2, cursor: p1.nextCursor })).rejects.toMatchObject({ code: "invalid_request" });
  });
});
