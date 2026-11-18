/**
 * Repositories and destinations through the real API on DynamoDB Local:
 * registration and updates, destination secrets (write-only, derived names,
 * version references, rollback), owner-only writes, limits and
 * cross-workspace isolation. SSM is the fake writer from the shared fixtures.
 */

import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../../src/db/client";
import { WORKSPACE_LIMITS } from "../../../src/contracts";
import { deriveDestinationParamName } from "../../../src/secrets/param-names";
import { VALID_WEBHOOK, fakeWriter, newUserId, openSignups } from "../fixtures";
import { itemsWith, tableName, useTestTable } from "../harness";
import { addMember, call, captureLogsAndBlockNetwork, dashboardApp, onboard, type DashboardApp, type Onboarded } from "./app";

useTestTable();
beforeAll(openSignups);
const logs = captureLogsAndBlockNetwork();

const WEBHOOK_TOKEN = "AbCdEf-secret_token";
const REPLACEMENT = "https://discord.com/api/webhooks/223456789012345678/Replaced-secret_token2";

async function get(PK: string, SK: string) {
  const out = await ddb.send(new GetCommand({ TableName: tableName(), Key: { PK, SK }, ConsistentRead: true }));
  return out.Item as Record<string, unknown> | undefined;
}

async function resetGlobalDestinationCounter() {
  await ddb.send(new PutCommand({ TableName: tableName(), Item: { PK: "SYSTEM#COUNTERS", SK: "SSM_DEST_PARAMS", count: 0 } }));
}

let app: DashboardApp;
let w: Onboarded;
beforeEach(async () => {
  await resetGlobalDestinationCounter();
  app = await dashboardApp();
  w = await onboard(app, newUserId());
});

async function createDestination(a: DashboardApp, o: Onboarded, displayName = "Alerts", webhookUrl = VALID_WEBHOOK) {
  return call(a, o.uid, "POST", `${o.base}/destinations`, { body: { displayName, webhookUrl } });
}

describe("destinations", () => {
  it("stores the URL only through the writer, under the derived name, and keeps just a reference", async () => {
    const res = await createDestination(app, w);
    expect(res.status).toBe(200);
    const id = String(res.body.destinationId);
    expect(Object.keys(res.body).sort()).toEqual(
      ["createdAt", "destinationId", "displayName", "provider", "status", "updatedAt", "webhookUrlMasked"].sort(),
    );
    expect(res.body).toMatchObject({ status: "active", provider: "discord", webhookUrlMasked: "discord.com/api/webhooks/123456789012345678/••••" });

    const name = deriveDestinationParamName(w.workspaceId, id, "/syncro/prod");
    expect(app.writer.calls).toEqual([{ name, value: VALID_WEBHOOK, overwrite: false }]);
    const item = await get(`WS#${w.workspaceId}`, `DEST#${id}`);
    expect(item).toMatchObject({ status: "active", secret_ref: { name, version: 1 }, webhook_id: "123456789012345678" });
    expect(JSON.stringify(item)).not.toContain(WEBHOOK_TOKEN);
    expect(await get(`WS#${w.workspaceId}`, "META")).toMatchObject({ active_destination_count: 1 });
  });

  it("never returns or logs the webhook URL or its token", async () => {
    const created = await createDestination(app, w);
    const id = String(created.body.destinationId);
    const responses = [
      created.raw,
      (await call(app, w.uid, "GET", `${w.base}/destinations`)).raw,
      (await call(app, w.uid, "PATCH", `${w.base}/destinations/${id}`, { body: { displayName: "Renamed" } })).raw,
      (await call(app, w.uid, "PUT", `${w.base}/destinations/${id}/webhook`, { body: { webhookUrl: REPLACEMENT } })).raw,
    ];
    const everything = responses.join("\n") + logs.lines.join("\n");
    for (const secret of [WEBHOOK_TOKEN, "Replaced-secret_token2", "secret_ref", "discord-webhook-url"]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("replacing the URL writes a new version and points the destination at it", async () => {
    const id = String((await createDestination(app, w)).body.destinationId);
    const res = await call(app, w.uid, "PUT", `${w.base}/destinations/${id}/webhook`, { body: { webhookUrl: REPLACEMENT } });
    expect(res.status).toBe(200);
    expect(res.body.webhookUrlMasked).toBe("discord.com/api/webhooks/223456789012345678/••••");
    const name = deriveDestinationParamName(w.workspaceId, id, "/syncro/prod");
    expect(app.writer.calls[1]).toEqual({ name, value: REPLACEMENT, overwrite: true });
    expect(await get(`WS#${w.workspaceId}`, `DEST#${id}`)).toMatchObject({ secret_ref: { name, version: 2 }, webhook_id: "223456789012345678" });
  });

  it("an invalid URL is refused before anything is reserved or written", async () => {
    const res = await createDestination(app, w, "Bad", "https://evil.example/api/webhooks/1/x");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_webhook_url" });
    expect(res.raw).not.toContain("evil.example");
    expect(app.writer.calls).toEqual([]);
    expect(await itemsWith(`WS#${w.workspaceId}`, "DEST#")).toEqual([]);
  });

  it.each(["secret_store_busy", "secret_unavailable"] as const)(
    "a %s failure while storing the URL rolls the reservation back",
    async (failure) => {
      const failing = await dashboardApp({ writer: fakeWriter({ failWith: failure }), github: app.github });
      const res = await createDestination(failing, w);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: failure });
      expect(await itemsWith(`WS#${w.workspaceId}`, "DEST#")).toEqual([]);
      expect((await get(`WS#${w.workspaceId}`, "META"))?.active_destination_count ?? 0).toBe(0);
      expect(await get("SYSTEM#COUNTERS", "SSM_DEST_PARAMS")).toMatchObject({ count: 0 });

      // A retry with a working store succeeds normally.
      expect((await createDestination(app, w)).status).toBe(200);
    },
  );

  it("a failed URL replacement keeps the previous version referenced", async () => {
    const id = String((await createDestination(app, w)).body.destinationId);
    const failing = await dashboardApp({ writer: fakeWriter({ failWith: "secret_store_busy" }), github: app.github });
    const res = await call(failing, w.uid, "PUT", `${w.base}/destinations/${id}/webhook`, { body: { webhookUrl: REPLACEMENT } });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "secret_store_busy" });
    expect(await get(`WS#${w.workspaceId}`, `DEST#${id}`)).toMatchObject({ secret_ref: { version: 1 }, webhook_id: "123456789012345678" });
  });

  it("a destination whose stored reference does not match its derived name is never rewritten", async () => {
    const id = String((await createDestination(app, w)).body.destinationId);
    await ddb.send(
      new PutCommand({
        TableName: tableName(),
        Item: { ...(await get(`WS#${w.workspaceId}`, `DEST#${id}`)), secret_ref: { name: "/syncro/prod/ws/other/dest/x/discord-webhook-url", version: 1 } },
      }),
    );
    const before = app.writer.calls.length;
    const res = await call(app, w.uid, "PUT", `${w.base}/destinations/${id}/webhook`, { body: { webhookUrl: REPLACEMENT } });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "secret_unavailable" });
    expect(app.writer.calls.length).toBe(before);
  });

  it("deactivating frees a slot, and an inactive destination cannot be assigned or rewritten", async () => {
    const id = String((await createDestination(app, w)).body.destinationId);
    const off = await call(app, w.uid, "PATCH", `${w.base}/destinations/${id}`, { body: { isActive: false } });
    expect(off.body.status).toBe("inactive");
    expect(await get(`WS#${w.workspaceId}`, "META")).toMatchObject({ active_destination_count: 0 });

    const assign = await call(app, w.uid, "POST", `${w.base}/repos`, {
      body: { listingId: w.listingId, repoId: String(w.repoIds[0]), destinationId: id },
    });
    expect(assign.status).toBe(409);
    expect(assign.body).toEqual({ error: "destination_not_active" });
    const replace = await call(app, w.uid, "PUT", `${w.base}/destinations/${id}/webhook`, { body: { webhookUrl: REPLACEMENT } });
    expect(replace.body).toEqual({ error: "destination_not_active" });
  });

  it(`refuses the ${WORKSPACE_LIMITS.activeDestinations + 1}th active destination`, async () => {
    for (let i = 0; i < WORKSPACE_LIMITS.activeDestinations; i++) {
      expect((await createDestination(app, w, `D${i}`)).status).toBe(200);
    }
    const over = await createDestination(app, w, "One too many");
    expect(over.status).toBe(409);
    expect(over.body).toEqual({ error: "destination_limit_reached" });
    expect(await itemsWith(`WS#${w.workspaceId}`, "DEST#")).toHaveLength(WORKSPACE_LIMITS.activeDestinations);
    expect(app.writer.calls).toHaveLength(WORKSPACE_LIMITS.activeDestinations);
  });
});

describe("repositories", () => {
  it("registers from the listing with a destination, idempotently", async () => {
    const dest = String((await createDestination(app, w)).body.destinationId);
    const body = { listingId: w.listingId, repoId: String(w.repoIds[0]), destinationId: dest, watchedBranch: "release" };
    const res = await call(app, w.uid, "POST", `${w.base}/repos`, { body });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      repoId: String(w.repoIds[0]),
      fullName: `user${w.githubUserId}/repo-${w.repoIds[0]}`,
      installationId: String(w.installationId),
      watchedBranch: "release",
      isActive: true,
      destinationId: dest,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(await get(`REPO#${w.repoIds[0]}`, "CONFIG")).toMatchObject({
      workspace_id: w.workspaceId,
      installation_id: String(w.installationId),
      discord_destination_id: dest,
      is_active: true,
    });

    const again = await call(app, w.uid, "POST", `${w.base}/repos`, { body });
    expect(again.status).toBe(200);
    expect(await itemsWith(`REPO#${w.repoIds[0]}`)).toHaveLength(1);
    expect(await get(`WS#${w.workspaceId}`, "META")).toMatchObject({ active_repo_count: 1 });
  });

  it("refuses a repository that is not in the listing or not administered by the user", async () => {
    const notListed = await call(app, w.uid, "POST", `${w.base}/repos`, { body: { listingId: w.listingId, repoId: "999999999" } });
    expect(notListed.status).toBe(403);
    expect(notListed.body).toEqual({ error: "repo_not_verified" });

    // A fresh listing in which GitHub reports the user is not an admin of one repository.
    app.github.repos.get(w.installationId)!.push({ id: 123123123, full_name: `user${w.githubUserId}/read-only`, admin: false });
    const state = new URL(String((await call(app, w.uid, "POST", `${w.base}/github/authorize-url`)).body.url)).searchParams.get("state");
    const listing = await call(app, w.uid, "POST", `${w.base}/github/repo-listing`, {
      body: { code: app.github.code(w.githubUserId), installationId: String(w.installationId), state },
    });
    expect(listing.body.repos).toContainEqual({ repoId: "123123123", fullName: `user${w.githubUserId}/read-only`, admin: false });
    const readOnly = await call(app, w.uid, "POST", `${w.base}/repos`, { body: { listingId: listing.body.listingId, repoId: "123123123" } });
    expect(readOnly.status).toBe(403);
    expect(readOnly.body).toEqual({ error: "repo_not_verified" });
    expect(await itemsWith("REPO#123123123")).toEqual([]);
  });

  it("updates the branch, clears the destination and deactivates", async () => {
    const dest = String((await createDestination(app, w)).body.destinationId);
    const repoId = String(w.repoIds[0]);
    await call(app, w.uid, "POST", `${w.base}/repos`, { body: { listingId: w.listingId, repoId, destinationId: dest } });

    const cleared = await call(app, w.uid, "PATCH", `${w.base}/repos/${repoId}`, { body: { destinationId: null, watchedBranch: "dev" } });
    expect(cleared.status).toBe(200);
    expect(cleared.body).not.toHaveProperty("destinationId");
    const item = await get(`REPO#${repoId}`, "CONFIG");
    expect(item).not.toHaveProperty("discord_destination_id");
    expect(item).toMatchObject({ watched_branch: "dev" });

    const off = await call(app, w.uid, "PATCH", `${w.base}/repos/${repoId}`, { body: { isActive: false } });
    expect(off.body.isActive).toBe(false);
    expect(await get(`WS#${w.workspaceId}`, "META")).toMatchObject({ active_repo_count: 0 });
  });

  it("an expired or foreign listing cannot be used", async () => {
    const other = await onboard(app, newUserId());
    const foreign = await call(app, w.uid, "POST", `${w.base}/repos`, { body: { listingId: other.listingId, repoId: String(other.repoIds[0]) } });
    expect(foreign.status).toBe(400);
    expect(foreign.body).toEqual({ error: "listing_invalid" });
    expect(await itemsWith(`REPO#${other.repoIds[0]}`)).toEqual([]);
  });

  it("a repository registered by one workspace cannot be taken by another", async () => {
    const repoId = String(w.repoIds[0]);
    await call(app, w.uid, "POST", `${w.base}/repos`, { body: { listingId: w.listingId, repoId } });
    // Give a second workspace a listing that (wrongly) also contains the repository.
    const other = await onboard(app, newUserId());
    await ddb.send(
      new PutCommand({
        TableName: tableName(),
        Item: {
          ...(await get(`GHLISTING#${other.listingId}`, "META")),
          repos: [{ id: repoId, full_name: `user${w.githubUserId}/repo-${repoId}`, admin: true }],
        },
      }),
    );
    const res = await call(app, other.uid, "POST", `${other.base}/repos`, { body: { listingId: other.listingId, repoId } });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "repo_claimed" });
    expect(await get(`REPO#${repoId}`, "CONFIG")).toMatchObject({ workspace_id: w.workspaceId });
  });
});

describe("workspace isolation and roles", () => {
  it("another workspace's owner gets 404 for every route on this workspace and changes nothing", async () => {
    const dest = String((await createDestination(app, w)).body.destinationId);
    const repoId = String(w.repoIds[0]);
    await call(app, w.uid, "POST", `${w.base}/repos`, { body: { listingId: w.listingId, repoId, destinationId: dest } });
    const outsider = await onboard(app, newUserId());
    const writesBefore = app.writer.calls.length;

    const attempts: Array<[string, string, unknown?]> = [
      ["GET", `${w.base}/repos`],
      ["GET", `${w.base}/destinations`],
      ["GET", `${w.base}/installations`],
      ["GET", `${w.base}/deliveries`],
      ["POST", `${w.base}/destinations`, { displayName: "x", webhookUrl: VALID_WEBHOOK }],
      ["PATCH", `${w.base}/destinations/${dest}`, { displayName: "pwned" }],
      ["PUT", `${w.base}/destinations/${dest}/webhook`, { webhookUrl: REPLACEMENT }],
      ["PATCH", `${w.base}/repos/${repoId}`, { isActive: false }],
      ["POST", `${w.base}/repos`, { listingId: w.listingId, repoId: String(w.repoIds[1]) }],
      ["POST", `${w.base}/github/install-url`],
    ];
    for (const [method, path, body] of attempts) {
      const res = await call(app, outsider.uid, method as "GET", path, body === undefined ? {} : { body });
      expect([method, path, res.status]).toEqual([method, path, 404]);
    }
    expect(app.writer.calls.length).toBe(writesBefore);
    expect(await get(`WS#${w.workspaceId}`, `DEST#${dest}`)).toMatchObject({ display_name: "Alerts", secret_ref: { version: 1 } });
    expect(await get(`REPO#${repoId}`, "CONFIG")).toMatchObject({ is_active: true });
  });

  it("this workspace's resources are invisible through another workspace's path (IDOR)", async () => {
    const dest = String((await createDestination(app, w)).body.destinationId);
    const repoId = String(w.repoIds[0]);
    await call(app, w.uid, "POST", `${w.base}/repos`, { body: { listingId: w.listingId, repoId } });
    const outsider = await onboard(app, newUserId());

    const viaOwnPath = [
      await call(app, outsider.uid, "PATCH", `${outsider.base}/destinations/${dest}`, { body: { displayName: "pwned" } }),
      await call(app, outsider.uid, "PUT", `${outsider.base}/destinations/${dest}/webhook`, { body: { webhookUrl: REPLACEMENT } }),
      await call(app, outsider.uid, "PATCH", `${outsider.base}/repos/${repoId}`, { body: { isActive: false } }),
    ];
    for (const res of viaOwnPath) expect(res.body).toEqual({ error: "not_found" });
    expect((await call(app, outsider.uid, "GET", `${outsider.base}/destinations`)).body).toEqual({ items: [] });
    expect((await call(app, outsider.uid, "GET", `${outsider.base}/repos`)).body).toEqual({ items: [] });
    expect(await get(`WS#${w.workspaceId}`, `DEST#${dest}`)).toMatchObject({ display_name: "Alerts" });
  });

  it("members and admins can read but not write", async () => {
    const dest = String((await createDestination(app, w)).body.destinationId);
    for (const role of ["member", "admin"] as const) {
      const uid = newUserId();
      await addMember(w.workspaceId, uid, role);
      expect((await call(app, uid, "GET", `${w.base}/destinations`)).status).toBe(200);
      expect((await call(app, uid, "GET", `${w.base}/repos`)).status).toBe(200);
      for (const [method, path, body] of [
        ["POST", `${w.base}/destinations`, { displayName: "x", webhookUrl: VALID_WEBHOOK }],
        ["PATCH", `${w.base}/destinations/${dest}`, { isActive: false }],
        ["PUT", `${w.base}/destinations/${dest}/webhook`, { webhookUrl: REPLACEMENT }],
        ["POST", `${w.base}/repos`, { listingId: w.listingId, repoId: String(w.repoIds[0]) }],
      ] as const) {
        expect((await call(app, uid, method, path, { body })).status).toBe(403);
      }
    }
    expect(app.writer.calls).toHaveLength(1);
    expect(await get(`WS#${w.workspaceId}`, `DEST#${dest}`)).toMatchObject({ status: "active" });
  });

  it("a removed member loses access on the next request", async () => {
    const uid = newUserId();
    await addMember(w.workspaceId, uid, "member");
    expect((await call(app, uid, "GET", `${w.base}/repos`)).status).toBe(200);
    await ddb.send(
      new PutCommand({
        TableName: tableName(),
        Item: { ...(await get(`WS#${w.workspaceId}`, `MEMBER#${uid}`)), status: "removed" },
      }),
    );
    expect((await call(app, uid, "GET", `${w.base}/repos`)).status).toBe(404);
  });

  it("a suspended workspace answers 404 on every route, even to its owner", async () => {
    await ddb.send(new PutCommand({ TableName: tableName(), Item: { ...(await get(`WS#${w.workspaceId}`, "META")), status: "suspended" } }));
    for (const path of ["repos", "destinations", "installations", "deliveries"]) {
      expect((await call(app, w.uid, "GET", `${w.base}/${path}`)).status).toBe(404);
    }
    expect((await createDestination(app, w)).status).toBe(404);
    expect(app.writer.calls).toEqual([]);
  });

  it("write audit lines carry the workspace and outcome, including refusals", async () => {
    const outsider = await onboard(app, newUserId());
    logs.lines.length = 0;
    await createDestination(app, w);
    await createDestination(app, outsider, "x");
    await call(app, outsider.uid, "POST", `${w.base}/destinations`, { body: { displayName: "x", webhookUrl: VALID_WEBHOOK } });
    const audits = logs.lines.map((l) => JSON.parse(l)).filter((l) => l.audit === "write");
    expect(audits).toEqual([
      expect.objectContaining({ route: "destinations.create", workspaceId: w.workspaceId, status: 200, outcome: "ok" }),
      expect.objectContaining({ route: "destinations.create", workspaceId: outsider.workspaceId, status: 200, outcome: "ok" }),
      expect.objectContaining({ route: "destinations.create", userId: outsider.uid, status: 404, outcome: "not_found" }),
    ]);
    expect(logs.lines.join("\n")).not.toContain(WEBHOOK_TOKEN);
  });
});
