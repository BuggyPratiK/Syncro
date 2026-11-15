/**
 * Signup / bootstrap against DynamoDB Local: real conditional transactions,
 * concurrency, signup modes, the daily cap, and "nothing written on refusal".
 * The signup switch is set with the operator tool itself.
 */

import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../src/db/client";
import { bootstrapUser, setTenancyDepsForTests } from "../../src/db/operations/tenancy.ops";
import { ContractError } from "../../src/contracts";
import { parseArgs, run } from "../../scripts/set-signup-mode";
import { itemsWith, scanAll, tableName, testDocClient, useTestTable } from "./harness";

useTestTable();

const ISS = "https://tenant.logto.app/oidc";
let n = 0;
/** A fresh, valid Logto-style user ID per call (12 lowercase alphanumerics). */
function newUser(): string {
  n += 1;
  return `logto:${`u${Date.now().toString(36)}${n.toString(36)}`.padEnd(12, "0").slice(-12)}`;
}

async function setSignup(argv: string[]): Promise<void> {
  const doc = testDocClient();
  try {
    await run(doc, { ...parseArgs([...argv, "--yes"], {}), table: tableName() });
  } finally {
    doc.destroy();
  }
  setTenancyDepsForTests(undefined); // drop the cached config so the change applies now
}

/** Items that belong to one user's bootstrap (profile, memberships, workspace, member). */
async function footprint(uid: string) {
  const all = await scanAll();
  const profile = all.filter((i) => i.PK === `USER#${uid}` && i.SK === "PROFILE");
  const memberships = all.filter((i) => i.PK === `USER#${uid}` && String(i.SK).startsWith("MEMBERSHIP#"));
  const members = all.filter((i) => String(i.SK) === `MEMBER#${uid}`);
  const workspaces = all.filter((i) => i.SK === "META" && i.created_by === uid);
  return { profile, memberships, members, workspaces };
}

beforeEach(() => setTenancyDepsForTests(undefined));

describe("bootstrap: concurrency and invariants", () => {
  beforeAll(() => setSignup(["--mode", "open", "--daily-cap", "1000"]));

  it("25 parallel calls for the same user create exactly one workspace, and all agree on it", async () => {
    const uid = newUser();
    const results = await Promise.allSettled(Array.from({ length: 25 }, () => bootstrapUser(uid, ISS)));

    const ok = results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ created: boolean; workspaceId: string }>).value);
    expect(ok).toHaveLength(25);
    expect(ok.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(ok.map((r) => r.workspaceId)).size).toBe(1);

    const f = await footprint(uid);
    expect(f.profile).toHaveLength(1);
    expect(f.workspaces).toHaveLength(1);
    expect(f.members).toHaveLength(1);
    expect(f.memberships).toHaveLength(1);
  });

  it("creates an owner membership mirrored on both sides, and the profile points at the workspace", async () => {
    const uid = newUser();
    const { workspaceId } = await bootstrapUser(uid, ISS);
    const f = await footprint(uid);

    expect(f.profile[0]).toMatchObject({ bootstrap_workspace_id: workspaceId, status: "active", idp_iss: ISS });
    expect(f.workspaces[0]).toMatchObject({ PK: `WS#${workspaceId}`, workspace_id: workspaceId, status: "active" });
    expect(f.members[0]).toMatchObject({ PK: `WS#${workspaceId}`, role: "owner", status: "active" });
    expect(f.memberships[0]).toMatchObject({ SK: `MEMBERSHIP#${workspaceId}`, role: "owner", status: "active" });
    expect(workspaceId).toMatch(/^ws_[0-9a-f-]{36}$/);
  });

  it("a second call returns the same workspace and writes nothing new", async () => {
    const uid = newUser();
    const first = await bootstrapUser(uid, ISS);
    const before = (await scanAll()).length;
    await expect(bootstrapUser(uid, ISS)).resolves.toEqual({ created: false, workspaceId: first.workspaceId });
    expect((await scanAll()).length).toBe(before);
  });

  it("retries with a new ID after a real workspace-ID collision, leaving the existing workspace untouched", async () => {
    const taken = "ws_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await ddb.send(new PutCommand({ TableName: tableName(), Item: { PK: `WS#${taken}`, SK: "META", workspace_id: taken, created_by: "someone-else", status: "active" } }));
    const fresh = "ws_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const ids = [taken, fresh];
    setTenancyDepsForTests({ newWorkspaceId: () => ids.shift()! });

    const uid = newUser();
    await expect(bootstrapUser(uid, ISS)).resolves.toEqual({ created: true, workspaceId: fresh });
    expect((await itemsWith(`WS#${taken}`))).toEqual([expect.objectContaining({ created_by: "someone-else" })]);
  });

  it("retries a transient failure and then succeeds exactly once", async () => {
    let failed = false;
    setTenancyDepsForTests({
      send: (async (cmd: Parameters<typeof ddb.send>[0]) => {
        if (!failed && cmd.constructor.name === "TransactWriteCommand") {
          failed = true;
          const e = new Error("conflict");
          e.name = "TransactionConflictException";
          throw e;
        }
        return ddb.send(cmd);
      }) as never,
    });

    const uid = newUser();
    await expect(bootstrapUser(uid, ISS)).resolves.toMatchObject({ created: true });
    expect((await footprint(uid)).profile).toHaveLength(1);
  });

  it("a non-transient failure is thrown and leaves zero items", async () => {
    setTenancyDepsForTests({
      send: (async (cmd: Parameters<typeof ddb.send>[0]) => {
        if (cmd.constructor.name === "TransactWriteCommand") {
          const e = new Error("bad request");
          e.name = "ValidationException";
          throw e;
        }
        return ddb.send(cmd);
      }) as never,
    });

    const uid = newUser();
    await expect(bootstrapUser(uid, ISS)).rejects.toMatchObject({ name: "ValidationException" });
    const f = await footprint(uid);
    expect([f.profile, f.memberships, f.members, f.workspaces].flat()).toHaveLength(0);
  });

  it("a suspended profile is refused", async () => {
    const uid = newUser();
    await bootstrapUser(uid, ISS);
    await ddb.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { PK: `USER#${uid}`, SK: "PROFILE" },
        UpdateExpression: "SET #s = :s",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": "suspended" },
      }),
    );
    await expect(bootstrapUser(uid, ISS)).rejects.toMatchObject({ code: "profile_suspended" });
  });
});

describe("bootstrap: signup modes", () => {
  it("prelaunch refuses users not on the allowlist and writes nothing", async () => {
    await setSignup(["--mode", "prelaunch", "--daily-cap", "1000"]);
    const uid = newUser();
    await expect(bootstrapUser(uid, ISS)).rejects.toMatchObject({ code: "signup_not_open" });
    const f = await footprint(uid);
    expect([f.profile, f.memberships, f.members, f.workspaces].flat()).toHaveLength(0);
  });

  it("prelaunch admits allowlisted users", async () => {
    const uid = newUser();
    await setSignup(["--mode", "prelaunch", "--allow-add", uid]);
    await expect(bootstrapUser(uid, ISS)).resolves.toMatchObject({ created: true });
  });

  it("paused refuses new users but still returns existing profiles", async () => {
    await setSignup(["--mode", "open"]);
    const existing = newUser();
    const { workspaceId } = await bootstrapUser(existing, ISS);

    await setSignup(["--mode", "paused"]);
    const newcomer = newUser();
    await expect(bootstrapUser(newcomer, ISS)).rejects.toMatchObject({ code: "signup_paused" });
    await expect(bootstrapUser(existing, ISS)).resolves.toEqual({ created: false, workspaceId });
    expect((await footprint(newcomer)).profile).toHaveLength(0);
  });
});

describe("bootstrap: daily new-workspace cap", () => {
  it("under 25 parallel distinct users, exactly the cap succeed and refusals leave no partial items", async () => {
    const CAP = 5;
    await setSignup(["--mode", "open", "--daily-cap", String(CAP)]);
    // A day of its own, so the counter starts at zero for this test.
    setTenancyDepsForTests({ now: () => new Date("2031-03-03T12:00:00Z") });

    const users = Array.from({ length: 25 }, () => newUser());
    const results = await Promise.allSettled(users.map((u) => bootstrapUser(u, ISS)));

    const created = results.filter((r) => r.status === "fulfilled");
    const refusedCodes = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => (r.reason instanceof ContractError ? r.reason.code : String(r.reason)));

    expect(created).toHaveLength(CAP);
    expect(new Set(refusedCodes)).toEqual(new Set(["signup_paused"]));

    const day = await itemsWith("SYSTEM#SIGNUPS", "DAY#2031-03-03");
    expect(day[0]).toMatchObject({ count: CAP });

    // Zero partial items: exactly CAP of each item kind across the 25 users.
    const footprints = await Promise.all(users.map((u) => footprint(u)));
    for (const kind of ["profile", "memberships", "members", "workspaces"] as const) {
      expect(footprints.reduce((sum, f) => sum + f[kind].length, 0)).toBe(CAP);
    }
  });
});
