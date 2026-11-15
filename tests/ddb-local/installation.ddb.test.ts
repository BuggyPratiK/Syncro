/**
 * Installation claims against DynamoDB Local: identity binding, the
 * per-workspace limit, conflicts between workspaces, idempotent and concurrent
 * re-claims, and freshness of the ownership proof.
 */

import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../src/db/client";
import { claimInstallation, getInstallation, listInstallations } from "../../src/db/operations/installation.ops";
import { ContractError, type WorkspaceContext } from "../../src/contracts";
import { asRole, ghId, newOwner, openSignups, verifiedInstallation } from "./fixtures";
import { tableName, useTestTable } from "./harness";

useTestTable();

beforeAll(openSignups);

async function meta(ctx: WorkspaceContext) {
  const out = await ddb.send(new GetCommand({ TableName: tableName(), Key: { PK: `WS#${ctx.workspaceId}`, SK: "META" }, ConsistentRead: true }));
  return out.Item as Record<string, unknown>;
}

async function code(p: Promise<unknown>): Promise<string> {
  const e = await p.then(() => undefined, (err: unknown) => err);
  return e instanceof ContractError ? e.code : `not a ContractError: ${String(e)}`;
}

describe("claimInstallation", () => {
  it("first claim binds the GitHub account, links it to the workspace and counts one installation", async () => {
    const ctx = await newOwner();
    const gid = ghId();
    const iid = ghId();

    const result = await claimInstallation(ctx, verifiedInstallation({ installationId: iid, githubUserId: gid }));

    expect(result.created).toBe(true);
    expect(result.installation).toMatchObject({ installationId: iid, workspaceId: ctx.workspaceId, status: "active" });
    expect(await meta(ctx)).toMatchObject({ github_user_id: gid, installation_count: 1 });
    const link = await ddb.send(new GetCommand({ TableName: tableName(), Key: { PK: `GHUSER#${gid}`, SK: "LINK" } }));
    expect(link.Item).toMatchObject({ workspace_id: ctx.workspaceId });
  });

  it("a 4th installation is refused", async () => {
    const ctx = await newOwner();
    const gid = ghId();
    for (let i = 0; i < 3; i++) await claimInstallation(ctx, verifiedInstallation({ installationId: ghId(), githubUserId: gid }));

    expect(await code(claimInstallation(ctx, verifiedInstallation({ installationId: ghId(), githubUserId: gid })))).toBe(
      "installation_limit_reached",
    );
    expect((await meta(ctx)).installation_count).toBe(3);
  });

  it("a second GitHub identity in the same workspace is refused", async () => {
    const ctx = await newOwner();
    await claimInstallation(ctx, verifiedInstallation({ installationId: ghId(), githubUserId: ghId() }));
    expect(await code(claimInstallation(ctx, verifiedInstallation({ installationId: ghId(), githubUserId: ghId() })))).toBe(
      "github_identity_mismatch",
    );
  });

  it("the same GitHub identity in another workspace is refused", async () => {
    const [a, b] = [await newOwner(), await newOwner()];
    const gid = ghId();
    await claimInstallation(a, verifiedInstallation({ installationId: ghId(), githubUserId: gid }));
    expect(await code(claimInstallation(b, verifiedInstallation({ installationId: ghId(), githubUserId: gid })))).toBe(
      "github_identity_in_use",
    );
    expect((await meta(b)).github_user_id).toBeUndefined();
  });

  it("an installation claimed by another workspace is refused", async () => {
    const [a, b] = [await newOwner(), await newOwner()];
    const iid = ghId();
    await claimInstallation(a, verifiedInstallation({ installationId: iid, githubUserId: ghId() }));
    expect(await code(claimInstallation(b, verifiedInstallation({ installationId: iid, githubUserId: ghId() })))).toBe(
      "installation_claimed",
    );
    expect((await meta(b)).installation_count).toBeUndefined(); // nothing written for b
  });

  it("an idempotent re-claim writes nothing and does not count again", async () => {
    const ctx = await newOwner();
    const v = { installationId: ghId(), githubUserId: ghId() };
    await claimInstallation(ctx, verifiedInstallation(v));
    const again = await claimInstallation(ctx, verifiedInstallation(v));
    expect(again.created).toBe(false);
    expect((await meta(ctx)).installation_count).toBe(1);
  });

  it("concurrent re-claims of the same installation count it exactly once", async () => {
    for (let round = 0; round < 3; round++) {
      const ctx = await newOwner();
      const v = { installationId: ghId(), githubUserId: ghId() };
      const results = await Promise.all(Array.from({ length: 6 }, () => claimInstallation(ctx, verifiedInstallation(v))));
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect((await meta(ctx)).installation_count).toBe(1);
    }
  });

  it("two workspaces racing for one installation: exactly one wins", async () => {
    const [a, b] = [await newOwner(), await newOwner()];
    const iid = ghId();
    const results = await Promise.allSettled([
      claimInstallation(a, verifiedInstallation({ installationId: iid, githubUserId: ghId() })),
      claimInstallation(b, verifiedInstallation({ installationId: iid, githubUserId: ghId() })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((loser.reason as ContractError).code).toBe("installation_claimed");
  });

  it("a previously deleted installation can be claimed again", async () => {
    const [a, b] = [await newOwner(), await newOwner()];
    const iid = ghId();
    await claimInstallation(a, verifiedInstallation({ installationId: iid, githubUserId: ghId() }));
    await ddb.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { PK: `INSTALLATION#${iid}`, SK: "META" },
        UpdateExpression: "SET #s = :d",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":d": "deleted" },
      }),
    );
    const result = await claimInstallation(b, verifiedInstallation({ installationId: iid, githubUserId: ghId() }));
    expect(result.installation.workspaceId).toBe(b.workspaceId);
  });

  it.each([
    ["older than 15 minutes", new Date(Date.now() - 15 * 60_000 - 1000).toISOString()],
    ["dated in the future", new Date(Date.now() + 5 * 60_000).toISOString()],
    ["unparseable", "yesterday"],
  ])("a verification %s is refused before any write", async (_label, verifiedAt) => {
    const ctx = await newOwner();
    expect(await code(claimInstallation(ctx, verifiedInstallation({ installationId: ghId(), githubUserId: ghId(), verifiedAt })))).toBe(
      "not_installation_owner",
    );
    expect((await meta(ctx)).github_user_id).toBeUndefined();
  });

  it("only the owner role may claim", async () => {
    const ctx = await newOwner();
    expect(await code(claimInstallation(asRole(ctx, "member"), verifiedInstallation({ installationId: ghId(), githubUserId: ghId() })))).toBe(
      "forbidden",
    );
  });

  it("a suspended workspace cannot claim", async () => {
    const ctx = await newOwner();
    await ddb.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { PK: `WS#${ctx.workspaceId}`, SK: "META" },
        UpdateExpression: "SET #s = :s",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": "suspended" },
      }),
    );
    expect(await code(claimInstallation(ctx, verifiedInstallation({ installationId: ghId(), githubUserId: ghId() })))).toBe("not_found");
  });
});

describe("installation reads are workspace-isolated", () => {
  it("get and list show only this workspace's installations, and cursors cannot cross workspaces", async () => {
    const [a, b] = [await newOwner(), await newOwner()];
    const gid = ghId();
    const ids = [ghId(), ghId(), ghId()];
    for (const iid of ids) await claimInstallation(a, verifiedInstallation({ installationId: iid, githubUserId: gid }));

    expect(await getInstallation(a, ids[0])).toMatchObject({ installationId: ids[0] });
    expect(await getInstallation(b, ids[0])).toBeNull();

    const p1 = await listInstallations(a, { limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeDefined();
    const p2 = await listInstallations(a, { limit: 2, cursor: p1.nextCursor });
    expect([...p1.items, ...p2.items].map((i) => i.installationId).sort()).toEqual([...ids].sort());

    expect((await listInstallations(b, { limit: 50 })).items).toHaveLength(0);
    await expect(listInstallations(b, { limit: 2, cursor: p1.nextCursor })).rejects.toMatchObject({ code: "invalid_request" });
  });
});
