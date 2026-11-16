/**
 * Signup / workspace bootstrap: signup-mode gating and the full transaction
 * outcome classification table, with a fake DynamoDB transport.
 */

import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  BootstrapInconsistentError,
  DEFAULT_SIGNUP_CONFIG,
  bootstrapUser,
  getSignupConfig,
  parseSignupConfig,
  setTenancyDepsForTests,
} from "../../src/db/operations/tenancy.ops";
import { ContractError } from "../../src/contracts";

const UID = "logto:abcdef123456";
const ISS = "https://tenant.logto.app/oidc";
const WS1 = "ws_11111111-1111-4111-8111-111111111111";
const WS2 = "ws_22222222-2222-4222-8222-222222222222";

type Cmd = GetCommand | TransactWriteCommand;

function cancelled(codes: string[]): Error {
  const e = new Error("Transaction cancelled") as Error & { CancellationReasons: Array<{ Code: string }> };
  e.name = "TransactionCanceledException";
  e.CancellationReasons = codes.map((Code) => ({ Code }));
  return e;
}

function named(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

const OPEN = { PK: "SYSTEM#CONFIG", SK: "SIGNUP", mode: "open", prelaunch_allow: [], daily_cap: 100, updated_at: "t" };
const PROFILE = {
  PK: `USER#${UID}`,
  SK: "PROFILE",
  user_id: UID,
  idp_iss: ISS,
  bootstrap_workspace_id: WS1,
  status: "active",
  created_at: "t",
};

/**
 * Fake transport: answers profile reads from `profiles` (in order; last value
 * repeats), the config read with `config`, and transactions from `txResults`.
 */
function fakeSend(opts: {
  profiles?: Array<Record<string, unknown> | undefined>;
  config?: Record<string, unknown>;
  txResults?: Array<Error | "ok">;
}) {
  const profiles = [...(opts.profiles ?? [undefined])];
  const txResults = [...(opts.txResults ?? ["ok"])];
  const calls: Cmd[] = [];
  const send = jest.fn(async (cmd: Cmd) => {
    calls.push(cmd);
    if (cmd instanceof GetCommand) {
      if (cmd.input.Key?.SK === "SIGNUP") return { Item: opts.config ?? OPEN };
      const p = profiles.length > 1 ? profiles.shift() : profiles[0];
      return { Item: p };
    }
    const r = txResults.length > 1 ? txResults.shift() : txResults[0];
    if (r !== "ok") throw r;
    return {};
  });
  return { send, calls, txCalls: () => calls.filter((c) => c instanceof TransactWriteCommand) as TransactWriteCommand[] };
}

function install(fake: ReturnType<typeof fakeSend>, ids: string[] = [WS1, WS2, WS1]) {
  const queue = [...ids];
  setTenancyDepsForTests({
    send: fake.send as never,
    newWorkspaceId: () => queue.shift() ?? WS1,
    sleep: async () => undefined,
    now: () => new Date("2026-11-15T10:00:00Z"),
  });
}

afterEach(() => setTenancyDepsForTests(undefined));

describe("bootstrapUser: existing profiles", () => {
  it("returns the existing workspace without writing", async () => {
    const fake = fakeSend({ profiles: [PROFILE] });
    install(fake);
    await expect(bootstrapUser(UID, ISS)).resolves.toEqual({ created: false, workspaceId: WS1 });
    expect(fake.txCalls()).toHaveLength(0);
  });

  it("returns the existing workspace even while signups are paused", async () => {
    const fake = fakeSend({ profiles: [PROFILE], config: { ...OPEN, mode: "paused" } });
    install(fake);
    await expect(bootstrapUser(UID, ISS)).resolves.toEqual({ created: false, workspaceId: WS1 });
  });

  it("refuses a suspended profile", async () => {
    install(fakeSend({ profiles: [{ ...PROFILE, status: "suspended" }] }));
    await expect(bootstrapUser(UID, ISS)).rejects.toMatchObject({ code: "profile_suspended" });
  });
});

describe("bootstrapUser: signup mode", () => {
  it("paused → signup_paused, nothing written", async () => {
    const fake = fakeSend({ config: { ...OPEN, mode: "paused" } });
    install(fake);
    await expect(bootstrapUser(UID, ISS)).rejects.toMatchObject({ code: "signup_paused" });
    expect(fake.txCalls()).toHaveLength(0);
  });

  it("prelaunch and not allowlisted → signup_not_open, nothing written", async () => {
    const fake = fakeSend({ config: { ...OPEN, mode: "prelaunch", prelaunch_allow: ["logto:zzzzzzzzzzzz"] } });
    install(fake);
    await expect(bootstrapUser(UID, ISS)).rejects.toMatchObject({ code: "signup_not_open" });
    expect(fake.txCalls()).toHaveLength(0);
  });

  it("prelaunch and allowlisted → created", async () => {
    install(fakeSend({ config: { ...OPEN, mode: "prelaunch", prelaunch_allow: [UID] } }));
    await expect(bootstrapUser(UID, ISS)).resolves.toEqual({ created: true, workspaceId: WS1 });
  });

  it("no config written yet → closed (prelaunch with an empty allowlist)", async () => {
    expect(parseSignupConfig(undefined)).toBe(DEFAULT_SIGNUP_CONFIG);
    const fake = fakeSend({});
    fake.send.mockImplementation(async (cmd: Cmd) => (cmd instanceof GetCommand ? { Item: undefined } : {}));
    install(fake);
    await expect(bootstrapUser(UID, ISS)).rejects.toMatchObject({ code: "signup_not_open" });
  });

  it.each([
    { ...OPEN, mode: "wide-open" },
    { ...OPEN, daily_cap: -1 },
    { ...OPEN, daily_cap: "100" },
    { ...OPEN, prelaunch_allow: "logto:abcdef123456" },
  ])("malformed config fails closed as paused (%p)", (item) => {
    expect(parseSignupConfig(item as never).mode).toBe("paused");
  });

  it("caches the config for up to a minute", async () => {
    const fake = fakeSend({});
    install(fake);
    await getSignupConfig(1_000);
    await getSignupConfig(30_000);
    await getSignupConfig(61_001);
    const configReads = fake.calls.filter((c) => c instanceof GetCommand && c.input.Key?.SK === "SIGNUP");
    expect(configReads).toHaveLength(2);
  });
});

describe("bootstrapUser: transaction", () => {
  it("writes profile, workspace, both memberships and the day counter in one transaction", async () => {
    const fake = fakeSend({});
    install(fake);

    await expect(bootstrapUser(UID, ISS)).resolves.toEqual({ created: true, workspaceId: WS1 });

    const [tx] = fake.txCalls();
    const items = tx.input.TransactItems!;
    expect(items).toHaveLength(5);
    expect(items.slice(0, 4).map((i) => i.Put!.ConditionExpression)).toEqual(
      Array(4).fill("attribute_not_exists(PK)"),
    );
    expect(items[0].Put!.Item).toMatchObject({ PK: `USER#${UID}`, SK: "PROFILE", bootstrap_workspace_id: WS1, status: "active" });
    expect(items[1].Put!.Item).toMatchObject({ PK: `WS#${WS1}`, SK: "META", status: "active", created_by: UID });
    expect(items[2].Put!.Item).toMatchObject({ SK: `MEMBER#${UID}`, role: "owner", status: "active" });
    expect(items[3].Put!.Item).toMatchObject({ PK: `USER#${UID}`, SK: `MEMBERSHIP#${WS1}`, role: "owner" });
    expect(items[4].Update!.Key).toEqual({ PK: "SYSTEM#SIGNUPS", SK: "DAY#2026-11-15" });
    expect(items[4].Update!.ConditionExpression).toBe("attribute_not_exists(#count) OR #count < :cap");
    expect(items[4].Update!.ExpressionAttributeValues![":cap"]).toBe(100);
    expect(tx.input.ClientRequestToken!.length).toBeLessThanOrEqual(36);
  });

  it("[0] failed + profile now readable → returns the winner's workspace", async () => {
    install(fakeSend({ profiles: [undefined, { ...PROFILE, bootstrap_workspace_id: WS2 }], txResults: [cancelled(["ConditionalCheckFailed", "None", "None", "None", "None"])] }));
    await expect(bootstrapUser(UID, ISS)).resolves.toEqual({ created: false, workspaceId: WS2 });
  });

  it("[0] failed + profile not found → BootstrapInconsistentError (never success)", async () => {
    install(fakeSend({ profiles: [undefined], txResults: [cancelled(["ConditionalCheckFailed", "None", "None", "None", "None"])] }));
    await expect(bootstrapUser(UID, ISS)).rejects.toBeInstanceOf(BootstrapInconsistentError);
  });

  it.each([1, 2, 3])("[%i] failed (ID collision) → retries with a new workspace ID", async (idx) => {
    const codes = ["None", "None", "None", "None", "None"];
    codes[idx] = "ConditionalCheckFailed";
    const fake = fakeSend({ txResults: [cancelled(codes), "ok"] });
    install(fake);
    await expect(bootstrapUser(UID, ISS)).resolves.toEqual({ created: true, workspaceId: WS2 });
    expect(fake.txCalls()).toHaveLength(2);
  });

  it("[4] failed (daily cap) → signup_paused without retry", async () => {
    const fake = fakeSend({ txResults: [cancelled(["None", "None", "None", "None", "ConditionalCheckFailed"])] });
    install(fake);
    await expect(bootstrapUser(UID, ISS)).rejects.toMatchObject({ code: "signup_paused" });
    expect(fake.txCalls()).toHaveLength(1);
  });

  it.each(["TransactionConflictException", "TransactionInProgressException", "ThrottlingException", "InternalServerError"])(
    "%s is transient → retried",
    async (name) => {
      const fake = fakeSend({ txResults: [named(name), "ok"] });
      install(fake);
      await expect(bootstrapUser(UID, ISS)).resolves.toMatchObject({ created: true });
      expect(fake.txCalls()).toHaveLength(2);
    },
  );

  it("a TransactionConflict cancellation reason is transient → retried", async () => {
    const fake = fakeSend({ txResults: [cancelled(["TransactionConflict", "None", "None", "None", "None"]), "ok"] });
    install(fake);
    await expect(bootstrapUser(UID, ISS)).resolves.toMatchObject({ created: true });
  });

  it("gives up after 3 attempts with bootstrap_contention", async () => {
    const fake = fakeSend({ txResults: [named("TransactionConflictException")] });
    install(fake);
    const error = await bootstrapUser(UID, ISS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).code).toBe("bootstrap_contention");
    expect(fake.txCalls()).toHaveLength(3);
  });

  it.each(["ValidationException", "ItemCollectionSizeLimitExceededException", "SomethingElse"])(
    "%s is not retried and is thrown",
    async (name) => {
      const fake = fakeSend({ txResults: [named(name)] });
      install(fake);
      await expect(bootstrapUser(UID, ISS)).rejects.toMatchObject({ name });
      expect(fake.txCalls()).toHaveLength(1);
    },
  );

  it("an unrecognised cancellation reason is thrown, not retried", async () => {
    const fake = fakeSend({ txResults: [cancelled(["None", "None", "None", "None", "ValidationError"])] });
    install(fake);
    await expect(bootstrapUser(UID, ISS)).rejects.toMatchObject({ name: "TransactionCanceledException" });
    expect(fake.txCalls()).toHaveLength(1);
  });
});

describe("bootstrapUser: idempotency token", () => {
  it("is stable for the same logical transaction and distinct for different ones", async () => {
    // Same user + same workspace ID → same token (a retried send of this attempt).
    const tokens: string[] = [];
    for (let i = 0; i < 2; i++) {
      const fake = fakeSend({ txResults: [named("ValidationException")] });
      install(fake, [WS1]);
      await bootstrapUser(UID, ISS).catch(() => undefined);
      tokens.push(fake.txCalls()[0].input.ClientRequestToken!);
    }
    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[0]).toMatch(/^[0-9a-f]{36}$/);

    // A new attempt (new workspace ID) or another user → different token.
    const retry = fakeSend({ txResults: [cancelled(["None", "ConditionalCheckFailed", "None", "None", "None"]), "ok"] });
    install(retry, [WS1, WS2]);
    await bootstrapUser(UID, ISS);
    const [first, second] = retry.txCalls().map((t) => t.input.ClientRequestToken);
    expect(first).toBe(tokens[0]);
    expect(second).not.toBe(first);

    const other = fakeSend({});
    install(other, [WS1]);
    await bootstrapUser("logto:zzzzzzzzzzzz", ISS);
    expect(other.txCalls()[0].input.ClientRequestToken).not.toBe(tokens[0]);
  });
});

describe("bootstrapUser: input validation", () => {
  it.each(["user_123", "logto:ABC", "logto:abcdef123456#x"])("rejects user id %s before any read", async (uid) => {
    const fake = fakeSend({});
    install(fake);
    await expect(bootstrapUser(uid, ISS)).rejects.toThrow();
    expect(fake.send).not.toHaveBeenCalled();
  });

  it.each(["http://tenant.logto.app/oidc", "", "https://"])("rejects issuer %p", async (iss) => {
    const fake = fakeSend({});
    install(fake);
    await expect(bootstrapUser(UID, iss)).rejects.toThrow("Invalid identity-provider issuer");
    expect(fake.send).not.toHaveBeenCalled();
  });
});
