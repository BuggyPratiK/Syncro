/**
 * Identifier formats. DynamoDB key builders and request schemas use these,
 * so no identifier containing `#`, `/` or other structure can reach a key or an
 * SSM parameter name.
 */

const UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export const ID_PATTERNS = {
  /** Server-generated `ws_` + `crypto.randomUUID()`; never chosen by a client. */
  workspaceId: new RegExp(`^ws_${UUID_V4}$`),
  /** Server-generated `crypto.randomUUID()`. */
  destinationId: new RegExp(`^${UUID_V4}$`),
  /** Server-generated `crypto.randomUUID()`. */
  listingId: new RegExp(`^${UUID_V4}$`),
  /** `"logto:" + sub`, where `sub` is the Logto user ID. */
  userId: /^logto:[a-z0-9]{12}$/,
  /** GitHub numeric IDs (installation, repository, user, org) as decimal strings. */
  githubId: /^[1-9][0-9]{0,18}$/,
  /** GHSTATE# nonce: 32 random bytes, base64url (no padding). */
  stateNonce: /^[A-Za-z0-9_-]{43}$/,
  /** UTC calendar day for the daily signup counter. */
  utcDay: /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/,
} as const;

export type IdKind = keyof typeof ID_PATTERNS;

export class InvalidIdentifierError extends Error {
  constructor(kind: IdKind) {
    // Never include the offending value: it may be attacker-controlled.
    super(`Invalid identifier: ${kind}`);
    this.name = "InvalidIdentifierError";
  }
}

export function isValidId(kind: IdKind, value: unknown): value is string {
  return typeof value === "string" && ID_PATTERNS[kind].test(value);
}

/** Returns the value as a string, or throws `InvalidIdentifierError`. */
export function assertId(kind: IdKind, value: string | number): string {
  const s = typeof value === "number" ? String(value) : value;
  if (!isValidId(kind, s)) {
    throw new InvalidIdentifierError(kind);
  }
  return s;
}
