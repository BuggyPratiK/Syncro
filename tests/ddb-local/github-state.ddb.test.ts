/**
 * Single-use OAuth state against DynamoDB Local.
 *
 * Each case runs the order the dashboard must follow: consume the state
 * first, and exchange the OAuth code only if that succeeded. A fake GitHub
 * transport records token calls, proving every rejection happens before any
 * code exchange.
 */

import { PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../src/db/client";
import { consumeGitHubState, createGitHubState } from "../../src/db/operations/github-state.ops";
import type { GitHubStatePurpose, WorkspaceContext } from "../../src/contracts";
import { newOwner, openSignups } from "./fixtures";
import { tableName, useTestTable } from "./harness";

useTestTable();

let alice: WorkspaceContext;
let bob: WorkspaceContext;

beforeAll(async () => {
  await openSignups();
  alice = await newOwner();
  bob = await newOwner();
});

/** Fake GitHub token endpoint: counts code exchanges. */
const tokenCalls: string[] = [];
async function callbackFlow(ctx: WorkspaceContext, state: string | undefined, purpose: GitHubStatePurpose, nowMs?: number) {
  const consumed = await consumeGitHubState(ctx, state, purpose, nowMs);
  if (!consumed.ok) return { error: "state_invalid" as const, reason: consumed.reason };
  tokenCalls.push("POST /login/oauth/access_token");
  return { exchanged: true };
}

beforeEach(() => {
  tokenCalls.length = 0;
});

describe("createGitHubState", () => {
  it("stores exactly user, workspace, purpose and a 10-minute ttl under an unguessable nonce", async () => {
    const now = Date.UTC(2026, 10, 15, 10, 0, 0);
    const { state, expiresAt } = await createGitHubState(alice, "install", now);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBe(new Date(now + 600_000).toISOString());

    const out = await ddb.send(new GetCommand({ TableName: tableName(), Key: { PK: `GHSTATE#${state}`, SK: "META" } }));
    expect(out.Item).toEqual({
      PK: `GHSTATE#${state}`,
      SK: "META",
      user_id: alice.userId,
      workspace_id: alice.workspaceId,
      purpose: "install",
      ttl: Math.floor(now / 1000) + 600,
    });
  });

  it("issues a different nonce each time", async () => {
    const a = await createGitHubState(alice, "install");
    const b = await createGitHubState(alice, "install");
    expect(a.state).not.toBe(b.state);
  });
});

describe("consumeGitHubState: every rejection is state_invalid with zero code exchanges", () => {
  it("accepts a valid state once (then exchanges the code)", async () => {
    const { state } = await createGitHubState(alice, "install");
    await expect(callbackFlow(alice, state, "install")).resolves.toEqual({ exchanged: true });
    expect(tokenCalls).toHaveLength(1);
  });

  it.each([
    ["missing", undefined, "missing"],
    ["empty", "", "missing"],
    ["malformed", "not-a-nonce#", "malformed"],
    ["unknown", "A".repeat(43), "not_found"],
  ])("%s state", async (_label, state, reason) => {
    await expect(callbackFlow(alice, state, "install")).resolves.toEqual({ error: "state_invalid", reason });
    expect(tokenCalls).toHaveLength(0);
  });

  it("replayed state (second consume after success)", async () => {
    const { state } = await createGitHubState(alice, "install");
    await callbackFlow(alice, state, "install");
    tokenCalls.length = 0;
    await expect(callbackFlow(alice, state, "install")).resolves.toEqual({ error: "state_invalid", reason: "not_found" });
    expect(tokenCalls).toHaveLength(0);
  });

  it("expired state that still exists in the table", async () => {
    const created = Date.UTC(2026, 10, 15, 10, 0, 0);
    const { state } = await createGitHubState(alice, "install", created);
    const later = created + 600_000 + 1000;
    await expect(callbackFlow(alice, state, "install", later)).resolves.toEqual({ error: "state_invalid", reason: "expired" });
    expect(tokenCalls).toHaveLength(0);
    const still = await ddb.send(new GetCommand({ TableName: tableName(), Key: { PK: `GHSTATE#${state}`, SK: "META" } }));
    expect(still.Item).toBeDefined(); // only DynamoDB's own TTL removes it
  });

  it("wrong purpose", async () => {
    const { state } = await createGitHubState(alice, "authorize");
    await expect(callbackFlow(alice, state, "install")).resolves.toEqual({ error: "state_invalid", reason: "purpose_mismatch" });
    expect(tokenCalls).toHaveLength(0);
  });

  it("wrong user and workspace, without destroying the owner's state", async () => {
    const { state } = await createGitHubState(alice, "install");
    await expect(callbackFlow(bob, state, "install")).resolves.toEqual({ error: "state_invalid", reason: "binding_mismatch" });
    expect(tokenCalls).toHaveLength(0);
    await expect(callbackFlow(alice, state, "install")).resolves.toEqual({ exchanged: true });
  });

  it("right user, wrong workspace", async () => {
    const { state } = await createGitHubState(alice, "install");
    const otherWs = { ...alice, workspaceId: bob.workspaceId } as WorkspaceContext;
    await expect(callbackFlow(otherWs, state, "install")).resolves.toEqual({ error: "state_invalid", reason: "binding_mismatch" });
    expect(tokenCalls).toHaveLength(0);
  });

  it("right workspace, wrong user", async () => {
    const nonce = "B".repeat(43);
    await ddb.send(
      new PutCommand({
        TableName: tableName(),
        Item: { PK: `GHSTATE#${nonce}`, SK: "META", user_id: "logto:someoneelse1", workspace_id: alice.workspaceId, purpose: "install", ttl: Math.floor(Date.now() / 1000) + 600 },
      }),
    );
    await expect(callbackFlow(alice, nonce, "install")).resolves.toEqual({ error: "state_invalid", reason: "binding_mismatch" });
    expect(tokenCalls).toHaveLength(0);
  });

  it("two concurrent consumes: exactly one succeeds and exactly one code exchange happens", async () => {
    for (let round = 0; round < 5; round++) {
      tokenCalls.length = 0;
      const { state } = await createGitHubState(alice, "install");
      const results = await Promise.all(Array.from({ length: 2 }, () => callbackFlow(alice, state, "install")));
      expect(results.filter((r) => "exchanged" in r)).toHaveLength(1);
      expect(tokenCalls).toHaveLength(1);
    }
  });

  it("ten concurrent consumes: still exactly one", async () => {
    const { state } = await createGitHubState(alice, "authorize");
    const results = await Promise.all(Array.from({ length: 10 }, () => callbackFlow(alice, state, "authorize")));
    expect(results.filter((r) => "exchanged" in r)).toHaveLength(1);
    expect(tokenCalls).toHaveLength(1);
  });
});
