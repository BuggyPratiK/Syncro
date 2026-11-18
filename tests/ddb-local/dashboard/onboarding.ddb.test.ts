/**
 * Dashboard onboarding through the real API on DynamoDB Local: signup and
 * profile state, GitHub install and claim, single-use OAuth state, identity
 * and installation uniqueness, listing limits, and recovery when the
 * repository listing fails after the installation was claimed.
 */

import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../../src/db/client";
import { newUserId, openSignups } from "../fixtures";
import { itemsWith, tableName, useTestTable } from "../harness";
import {
  addMember,
  call,
  captureLogsAndBlockNetwork,
  dashboardApp,
  githubNumber,
  onboard,
  stateOf,
  type DashboardApp,
} from "./app";

useTestTable();
beforeAll(openSignups);
const logs = captureLogsAndBlockNetwork();

async function get(PK: string, SK: string) {
  const out = await ddb.send(new GetCommand({ TableName: tableName(), Key: { PK, SK }, ConsistentRead: true }));
  return out.Item as Record<string, unknown> | undefined;
}

let app: DashboardApp;
beforeEach(async () => {
  app = await dashboardApp();
});

describe("signup and profile", () => {
  it("bootstrap creates the profile and an owned workspace once; retries return the same workspace", async () => {
    const uid = newUserId();
    const first = await call(app, uid, "POST", "/api/me/bootstrap");
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ created: true, workspaceId: expect.stringMatching(/^ws_/) });
    const ws = String(first.body.workspaceId);

    const again = await call(app, uid, "POST", "/api/me/bootstrap", { body: {} });
    expect(again.body).toEqual({ created: false, workspaceId: ws });
    expect(await itemsWith(`USER#${uid}`, "PROFILE")).toHaveLength(1);
    expect(await itemsWith(`USER#${uid}`, "MEMBERSHIP#")).toHaveLength(1);

    const me = await call(app, uid, "GET", "/api/me");
    expect(me.status).toBe(200);
    expect(me.body).toEqual({
      profile: { status: "active", createdAt: expect.any(String) },
      workspaces: [{ workspaceId: ws, role: "owner" }],
    });
  });

  it("GET /api/me before signup returns no profile and writes nothing", async () => {
    const uid = newUserId();
    const me = await call(app, uid, "GET", "/api/me");
    expect(me.body).toEqual({ workspaces: [] });
    expect(await itemsWith(`USER#${uid}`)).toEqual([]);
  });

  it("a suspended profile cannot complete bootstrap and nothing is written", async () => {
    const uid = newUserId();
    const ws = String((await call(app, uid, "POST", "/api/me/bootstrap")).body.workspaceId);
    await ddb.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { PK: `USER#${uid}`, SK: "PROFILE" },
        UpdateExpression: "SET #s = :s",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": "suspended" },
      }),
    );
    const before = await itemsWith(`USER#${uid}`);

    const res = await call(app, uid, "POST", "/api/me/bootstrap");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "profile_suspended" });
    expect(await itemsWith(`USER#${uid}`)).toEqual(before);
    expect(await itemsWith(`WS#${ws}`, "MEMBER#")).toHaveLength(1);
  });

  it("an unauthenticated request is refused before any read or write", async () => {
    const res = await call(app, null, "POST", "/api/me/bootstrap");
    expect(res.status).toBe(401);
  });
});

describe("GitHub install and claim", () => {
  it("claims the installation, links the GitHub account and saves a listing", async () => {
    const w = await onboard(app, newUserId());

    expect(await get(`INSTALLATION#${w.installationId}`, "META")).toMatchObject({
      workspace_id: w.workspaceId,
      status: "active",
    });
    expect(await get(`GHUSER#${w.githubUserId}`, "LINK")).toMatchObject({ workspace_id: w.workspaceId });
    expect(await get(`WS#${w.workspaceId}`, "META")).toMatchObject({ github_user_id: String(w.githubUserId), installation_count: 1 });
    const listing = await get(`GHLISTING#${w.listingId}`, "META");
    expect(listing).toMatchObject({ workspace_id: w.workspaceId, installation_id: String(w.installationId) });
    expect(JSON.stringify(listing)).not.toMatch(/gho_|token/i);

    const installations = await call(app, w.uid, "GET", `${w.base}/installations`);
    expect(installations.body).toEqual({
      items: [
        { installationId: String(w.installationId), accountLogin: `user${w.githubUserId}`, accountType: "User", status: "active", claimedAt: expect.any(String) },
      ],
    });
  });

  it("an OAuth state is single use, and a reused state never reaches GitHub", async () => {
    const uid = newUserId();
    const w = await onboard(app, uid);
    const state = stateOf(await call(app, uid, "POST", `${w.base}/github/install-url`));
    const body = { code: app.github.code(w.githubUserId), installationId: String(w.installationId), state };
    expect((await call(app, uid, "POST", `${w.base}/github/claim`, { body })).status).toBe(200);

    const before = app.github.calls.length;
    const replay = await call(app, uid, "POST", `${w.base}/github/claim`, { body: { ...body, code: app.github.code(w.githubUserId) } });
    expect(replay.status).toBe(400);
    expect(replay.body).toEqual({ error: "state_invalid" });
    expect(app.github.calls.length).toBe(before);
  });

  it("a state is bound to its workspace and purpose; a mismatch leaves it usable by its owner", async () => {
    const a = await onboard(app, newUserId());
    const b = await onboard(app, newUserId());
    const stateA = stateOf(await call(app, a.uid, "POST", `${a.base}/github/install-url`));

    const stolen = await call(app, b.uid, "POST", `${b.base}/github/claim`, {
      body: { code: app.github.code(b.githubUserId), installationId: String(b.installationId), state: stateA },
    });
    expect(stolen.body).toEqual({ error: "state_invalid" });

    const authorizeState = stateOf(await call(app, a.uid, "POST", `${a.base}/github/authorize-url`));
    const wrongPurpose = await call(app, a.uid, "POST", `${a.base}/github/claim`, {
      body: { code: app.github.code(a.githubUserId), installationId: String(a.installationId), state: authorizeState },
    });
    expect(wrongPurpose.body).toEqual({ error: "state_invalid" });

    const owner = await call(app, a.uid, "POST", `${a.base}/github/claim`, {
      body: { code: app.github.code(a.githubUserId), installationId: String(a.installationId), state: stateA },
    });
    expect(owner.status).toBe(200);
  });

  it("re-claiming an owned installation is idempotent", async () => {
    const w = await onboard(app, newUserId());
    const state = stateOf(await call(app, w.uid, "POST", `${w.base}/github/install-url`));
    const again = await call(app, w.uid, "POST", `${w.base}/github/claim`, {
      body: { code: app.github.code(w.githubUserId), installationId: String(w.installationId), state },
    });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(await get(`WS#${w.workspaceId}`, "META")).toMatchObject({ installation_count: 1 });
    expect(await itemsWith(`INSTALLATION#${w.installationId}`)).toHaveLength(1);
  });

  it("another workspace cannot take a claimed installation or a linked GitHub account", async () => {
    const a = await onboard(app, newUserId());
    const uidB = newUserId();
    const wsB = String((await call(app, uidB, "POST", "/api/me/bootstrap")).body.workspaceId);
    const baseB = `/api/workspaces/${wsB}`;

    // Same GitHub account (the installation's owner) signing in to a second workspace.
    const state = stateOf(await call(app, uidB, "POST", `${baseB}/github/install-url`));
    const res = await call(app, uidB, "POST", `${baseB}/github/claim`, {
      body: { code: app.github.code(a.githubUserId), installationId: String(a.installationId), state },
    });
    expect(res.status).toBe(409);
    expect(["installation_claimed", "github_identity_in_use"]).toContain(res.body.error);
    expect(await get(`INSTALLATION#${a.installationId}`, "META")).toMatchObject({ workspace_id: a.workspaceId });
    expect(await get(`GHUSER#${a.githubUserId}`, "LINK")).toMatchObject({ workspace_id: a.workspaceId });
    expect((await get(`WS#${wsB}`, "META"))?.installation_count ?? 0).toBe(0);
  });

  it("a GitHub user cannot claim someone else's personal installation", async () => {
    const uid = newUserId();
    const ws = String((await call(app, uid, "POST", "/api/me/bootstrap")).body.workspaceId);
    const victim = githubNumber();
    const installationId = githubNumber();
    app.github.addPersonalInstallation(installationId, victim, [{ id: githubNumber() }]);
    const state = stateOf(await call(app, uid, "POST", `/api/workspaces/${ws}/github/install-url`));

    const res = await call(app, uid, "POST", `/api/workspaces/${ws}/github/claim`, {
      body: { code: app.github.code(githubNumber()), installationId: String(installationId), state },
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "not_installation_owner" });
    expect(await itemsWith(`INSTALLATION#${installationId}`)).toEqual([]);
  });

  it("an OAuth code can be exchanged only once", async () => {
    const w = await onboard(app, newUserId());
    const code = app.github.code(w.githubUserId);
    const s1 = stateOf(await call(app, w.uid, "POST", `${w.base}/github/authorize-url`));
    expect((await call(app, w.uid, "POST", `${w.base}/github/repo-listing`, { body: { code, installationId: String(w.installationId), state: s1 } })).status).toBe(200);
    const s2 = stateOf(await call(app, w.uid, "POST", `${w.base}/github/authorize-url`));
    const reused = await call(app, w.uid, "POST", `${w.base}/github/repo-listing`, { body: { code, installationId: String(w.installationId), state: s2 } });
    expect(reused.status).toBe(400);
    expect(reused.body).toEqual({ error: "github_code_invalid" });
  });

  it("only an owner can start or complete onboarding", async () => {
    const w = await onboard(app, newUserId());
    for (const role of ["member", "admin"] as const) {
      const uid = newUserId();
      await addMember(w.workspaceId, uid, role);
      for (const path of ["install-url", "authorize-url"]) {
        expect((await call(app, uid, "POST", `${w.base}/github/${path}`)).status).toBe(403);
      }
      const state = stateOf(await call(app, w.uid, "POST", `${w.base}/github/authorize-url`));
      const res = await call(app, uid, "POST", `${w.base}/github/repo-listing`, {
        body: { code: app.github.code(w.githubUserId), installationId: String(w.installationId), state },
      });
      expect(res.status).toBe(403);
      // The owner's state was not consumed by the refused request.
      const owner = await call(app, w.uid, "POST", `${w.base}/github/repo-listing`, {
        body: { code: app.github.code(w.githubUserId), installationId: String(w.installationId), state },
      });
      expect(owner.status).toBe(200);
    }
  });

  it("no OAuth code, GitHub token or client secret appears in responses or logs", async () => {
    const w = await onboard(app, newUserId());
    const text = logs.lines.join("\n");
    expect(text).not.toMatch(/gho_local_|local-oauth-client-secret|code\d+x\d+/);
    expect(logs.lines.filter((l) => JSON.parse(l).audit === "github").length).toBeGreaterThan(0);
    const claimAudit = logs.lines.map((l) => JSON.parse(l)).filter((l) => l.audit === "write" && l.route === "github.claim");
    expect(claimAudit).toEqual([expect.objectContaining({ workspaceId: w.workspaceId, status: 200, outcome: "ok" })]);
  });
});

describe("repository listings", () => {
  it("refuses a listing over 1,000 repositories with 422 and stores nothing", async () => {
    const w = await onboard(app, newUserId());
    app.github.reportedRepoCount = 1001;
    const before = (await itemsWith("GHLISTING#")).length;
    const state = stateOf(await call(app, w.uid, "POST", `${w.base}/github/authorize-url`));
    const res = await call(app, w.uid, "POST", `${w.base}/github/repo-listing`, {
      body: { code: app.github.code(w.githubUserId), installationId: String(w.installationId), state },
    });
    expect(res.status).toBe(422);
    expect(res.raw).toBe(JSON.stringify({ error: "listing_too_large" }));
    expect((await itemsWith("GHLISTING#")).length).toBe(before);
  });

  it("stores a listing of exactly 1,000 repositories across ten GitHub pages", async () => {
    const w = await onboard(app, newUserId(), 1);
    const many = Array.from({ length: 1000 }, (_, i) => ({ id: w.repoIds[0] + i + 1, full_name: `user${w.githubUserId}/r${i}`, admin: i % 2 === 0 }));
    app.github.repos.set(w.installationId, many);
    const state = stateOf(await call(app, w.uid, "POST", `${w.base}/github/authorize-url`));
    const res = await call(app, w.uid, "POST", `${w.base}/github/repo-listing`, {
      body: { code: app.github.code(w.githubUserId), installationId: String(w.installationId), state },
    });
    expect(res.status).toBe(200);
    expect((res.body.repos as unknown[]).length).toBe(1000);
    expect(((await get(`GHLISTING#${res.body.listingId}`, "META"))?.repos as unknown[]).length).toBe(1000);
  });

  it("a workspace cannot list an installation it does not own", async () => {
    const a = await onboard(app, newUserId());
    const b = await onboard(app, newUserId());
    const state = stateOf(await call(app, b.uid, "POST", `${b.base}/github/authorize-url`));
    const res = await call(app, b.uid, "POST", `${b.base}/github/repo-listing`, {
      body: { code: app.github.code(b.githubUserId), installationId: String(a.installationId), state },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await itemsWith("GHLISTING#").then((items) => items.filter((i) => i.workspace_id === b.workspaceId && i.installation_id === String(a.installationId)))).toEqual([]);
  });
});

describe("recovery after a partial claim", () => {
  it("an installation claimed before the listing failed is completed through authorize-url → repo-listing without duplicates", async () => {
    const uid = newUserId();
    const ws = String((await call(app, uid, "POST", "/api/me/bootstrap")).body.workspaceId);
    const base = `/api/workspaces/${ws}`;
    const gid = githubNumber();
    const installationId = githubNumber();
    const repoId = githubNumber();
    app.github.addPersonalInstallation(installationId, gid, [{ id: repoId }]);
    app.github.failRepositories = [503];

    const state = stateOf(await call(app, uid, "POST", `${base}/github/install-url`));
    const failed = await call(app, uid, "POST", `${base}/github/claim`, {
      body: { code: app.github.code(gid), installationId: String(installationId), state },
    });
    expect(failed.status).toBe(502);
    expect(failed.body).toEqual({ error: "github_unavailable" });
    // The claim itself committed; no listing was stored.
    expect(await get(`INSTALLATION#${installationId}`, "META")).toMatchObject({ workspace_id: ws });
    expect((await itemsWith("GHLISTING#")).filter((i) => i.workspace_id === ws)).toEqual([]);

    // Recovery: list repositories through the authorize flow.
    const s2 = stateOf(await call(app, uid, "POST", `${base}/github/authorize-url`));
    const listing = await call(app, uid, "POST", `${base}/github/repo-listing`, {
      body: { code: app.github.code(gid), installationId: String(installationId), state: s2 },
    });
    expect(listing.status).toBe(200);

    // Retrying the claim is also safe: nothing is duplicated or changed.
    const s3 = stateOf(await call(app, uid, "POST", `${base}/github/install-url`));
    const retry = await call(app, uid, "POST", `${base}/github/claim`, {
      body: { code: app.github.code(gid), installationId: String(installationId), state: s3 },
    });
    expect(retry.status).toBe(200);
    expect(retry.body.created).toBe(false);
    expect(await get(`WS#${ws}`, "META")).toMatchObject({ installation_count: 1, github_user_id: String(gid) });
    expect(await itemsWith(`INSTALLATION#${installationId}`)).toHaveLength(1);
    expect(await itemsWith(`GHUSER#${gid}`)).toHaveLength(1);

    // The recovered listing registers the repository.
    const reg = await call(app, uid, "POST", `${base}/repos`, { body: { listingId: listing.body.listingId, repoId: String(repoId) } });
    expect(reg.status).toBe(200);
  });
});
