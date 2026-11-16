/**
 * Workspace-bound pagination cursors.
 *
 * A cursor wraps DynamoDB's `LastEvaluatedKey` together with the workspace it
 * was issued for. Decoding checks the length and character set, the workspace,
 * and that every key attribute belongs to that workspace's partition, so a
 * cursor can never be replayed against, or edited to point into, another
 * workspace. Invalid cursors are a client error (`invalid_request`).
 */

import { REQUEST_LIMITS } from "../contracts/constants";
import { ContractError } from "../contracts/errors";

type Key = Record<string, string>;

export function encodeCursor(workspaceId: string, lastKey: Record<string, unknown> | undefined): string | undefined {
  if (!lastKey || Object.keys(lastKey).length === 0) return undefined;
  const cursor = Buffer.from(JSON.stringify({ w: workspaceId, k: lastKey }), "utf8").toString("base64url");
  // Keys here are short; this only guards against an unexpected key shape.
  if (cursor.length > REQUEST_LIMITS.cursorMaxLength) throw new Error("Cursor too long");
  return cursor;
}

/**
 * Returns the `ExclusiveStartKey` for `cursor`, or `undefined` when there is no
 * cursor. `ownsKey` must confirm every attribute of the key belongs to the
 * workspace (e.g. `PK === "WS#<ws>"` or `GSI1PK === "WS#<ws>#REPO"`).
 */
export function decodeCursor(
  workspaceId: string,
  cursor: string | undefined,
  ownsKey: (key: Key) => boolean,
): Key | undefined {
  if (cursor === undefined) return undefined;
  const invalid = () => new ContractError("invalid_request");
  if (cursor.length === 0 || cursor.length > REQUEST_LIMITS.cursorMaxLength || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw invalid();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  const { w, k } = (parsed ?? {}) as { w?: unknown; k?: unknown };
  if (w !== workspaceId || k === null || typeof k !== "object" || Array.isArray(k)) throw invalid();
  const entries = Object.entries(k as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 4 || !entries.every(([, v]) => typeof v === "string")) throw invalid();
  const key = k as Key;
  if (!ownsKey(key)) throw invalid();
  return key;
}
