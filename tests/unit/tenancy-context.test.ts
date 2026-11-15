/**
 * Workspace context resolution (fake DynamoDB) and the role matrix.
 */

import { BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../src/db/client";
import { requireRole, resolveWorkspaceContext } from "../../src/tenancy/context";
import { ContractError, type Role, type WorkspaceContext } from "../../src/contracts";

jest.mock("../../src/db/client", () => ({ ddb: { send: jest.fn() } }));

const UID = "logto:abcdef123456";
const WS = "ws_11111111-1111-4111-8111-111111111111";
const MEMBER = { PK: `WS#${WS}`, SK: `MEMBER#${UID}`, user_id: UID, workspace_id: WS, role: "owner", status: "active" };
const META = { PK: `WS#${WS}`, SK: "META", workspace_id: WS, status: "active" };
const send = ddb.send as jest.Mock;

function respond(items: Array<Record<string, unknown>>, unprocessed: Array<Record<string, string>> = []) {
  return {
    Responses: { "syncro-test-table": items },
    UnprocessedKeys: unprocessed.length ? { "syncro-test-table": { Keys: unprocessed } } : {},
  };
}

describe("resolveWorkspaceContext", () => {
  beforeEach(() => send.mockReset());

  it("returns a context for an active member of an active workspace, using a consistent read", async () => {
    send.mockResolvedValueOnce(respond([MEMBER, META]));
    await expect(resolveWorkspaceContext(UID, WS)).resolves.toEqual({ userId: UID, workspaceId: WS, role: "owner" });
    const cmd = send.mock.calls[0][0] as BatchGetCommand;
    expect(cmd.input.RequestItems!["syncro-test-table"].ConsistentRead).toBe(true);
    expect(cmd.input.RequestItems!["syncro-test-table"].Keys).toEqual([
      { PK: `WS#${WS}`, SK: `MEMBER#${UID}` },
      { PK: `WS#${WS}`, SK: "META" },
    ]);
  });

  it.each([
    ["no membership", [META]],
    ["no workspace", [MEMBER]],
    ["membership removed", [{ ...MEMBER, status: "removed" }, META]],
    ["workspace suspended", [MEMBER, { ...META, status: "suspended" }]],
    ["unknown role", [{ ...MEMBER, role: "superuser" }, META]],
    ["membership for another user", [{ ...MEMBER, user_id: "logto:zzzzzzzzzzzz" }, META]],
  ])("returns null when %s", async (_label, items) => {
    send.mockResolvedValueOnce(respond(items));
    await expect(resolveWorkspaceContext(UID, WS)).resolves.toBeNull();
  });

  it("retries unprocessed keys once", async () => {
    send
      .mockResolvedValueOnce(respond([MEMBER], [{ PK: `WS#${WS}`, SK: "META" }]))
      .mockResolvedValueOnce(respond([META]));
    await expect(resolveWorkspaceContext(UID, WS)).resolves.toMatchObject({ role: "owner" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("returns null when keys are still unprocessed after the retry", async () => {
    const pending = [{ PK: `WS#${WS}`, SK: "META" }];
    send.mockResolvedValueOnce(respond([MEMBER], pending)).mockResolvedValueOnce(respond([], pending));
    await expect(resolveWorkspaceContext(UID, WS)).resolves.toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("returns null when the read fails", async () => {
    send.mockRejectedValueOnce(new Error("network down"));
    await expect(resolveWorkspaceContext(UID, WS)).resolves.toBeNull();
  });

  it.each([
    ["malformed user id", "user_1", WS],
    ["malformed workspace id", UID, "ws_1"],
    ["key injection", UID, `${WS}#MEMBER#x`],
  ])("returns null without reading for a %s", async (_label, uid, ws) => {
    await expect(resolveWorkspaceContext(uid, ws)).resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("requireRole (role matrix)", () => {
  const ctx = (role: Role) => ({ userId: UID, workspaceId: WS, role }) as WorkspaceContext;

  it.each([
    ["owner", "owner", true],
    ["owner", "admin", true],
    ["owner", "member", true],
    ["admin", "owner", false],
    ["admin", "admin", true],
    ["admin", "member", true],
    ["member", "owner", false],
    ["member", "admin", false],
    ["member", "member", true],
  ] as const)("%s meets %s → %s", (actual, minimum, allowed) => {
    if (allowed) {
      expect(() => requireRole(ctx(actual), minimum)).not.toThrow();
    } else {
      expect(() => requireRole(ctx(actual), minimum)).toThrow(ContractError);
      try {
        requireRole(ctx(actual), minimum);
      } catch (e) {
        expect((e as ContractError).code).toBe("forbidden");
      }
    }
  });
});
