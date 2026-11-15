/**
 * Workspace-bound pagination cursors.
 */

import { decodeCursor, encodeCursor } from "../../src/db/cursor";
import { ContractError } from "../../src/contracts";

const WS = "ws_11111111-1111-4111-8111-111111111111";
const OTHER = "ws_22222222-2222-4222-8222-222222222222";
const KEY = { PK: "REPO#42", SK: "CONFIG", GSI1PK: `WS#${WS}#REPO`, created_at: "2026-11-15T00:00:00Z" };
const owns = (ws: string) => (k: Record<string, string>) => k.GSI1PK === `WS#${ws}#REPO`;

describe("cursors", () => {
  it("round-trips a key for the same workspace", () => {
    const c = encodeCursor(WS, KEY)!;
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(WS, c, owns(WS))).toEqual(KEY);
  });

  it("returns no cursor on the last page and no start key without a cursor", () => {
    expect(encodeCursor(WS, undefined)).toBeUndefined();
    expect(decodeCursor(WS, undefined, owns(WS))).toBeUndefined();
  });

  it("rejects a cursor issued for another workspace", () => {
    const c = encodeCursor(OTHER, { ...KEY, GSI1PK: `WS#${OTHER}#REPO` })!;
    expect(() => decodeCursor(WS, c, owns(WS))).toThrow(ContractError);
  });

  it("rejects a cursor edited to point into another workspace's partition", () => {
    const forged = Buffer.from(JSON.stringify({ w: WS, k: { ...KEY, GSI1PK: `WS#${OTHER}#REPO` } })).toString("base64url");
    expect(() => decodeCursor(WS, forged, owns(WS))).toThrow(ContractError);
  });

  it.each([
    ["empty", ""],
    ["too long", "a".repeat(1025)],
    ["non-base64url", "abc+/="],
    ["not JSON", Buffer.from("nope").toString("base64url")],
    ["non-string key values", Buffer.from(JSON.stringify({ w: WS, k: { PK: 1 } })).toString("base64url")],
    ["array key", Buffer.from(JSON.stringify({ w: WS, k: [] })).toString("base64url")],
    ["too many attributes", Buffer.from(JSON.stringify({ w: WS, k: { a: "1", b: "2", c: "3", d: "4", e: "5" } })).toString("base64url")],
  ])("rejects a %s cursor with invalid_request", (_label, c) => {
    try {
      decodeCursor(WS, c, owns(WS));
      fail("expected throw");
    } catch (e) {
      expect((e as ContractError).code).toBe("invalid_request");
    }
  });
});
