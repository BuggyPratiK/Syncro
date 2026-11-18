/**
 * Logto access-token verification.
 *
 * A request is authenticated only when its bearer token:
 * - is signed with ES384 (no other algorithm, never `none` or HMAC) by a key
 *   from the tenant's JWKS, fetched with a 3-second timeout;
 * - has exactly the configured issuer and the API's audience;
 * - was issued to the dashboard's client application (`client_id`);
 * - has a `sub` in Logto's user-ID format;
 * - is within its validity period, allowing 5 seconds of clock skew;
 * - declares `typ: at+jwt` if it declares a type at all, so an ID token
 *   cannot be used in place of an access token.
 *
 * Everything else fails closed. Token problems are `invalid_token`; a JWKS
 * that cannot be fetched or parsed is `jwks_unavailable`, so an outage is not
 * reported to the user as a bad sign-in. Tokens are never logged.
 */

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { AUTH } from "../contracts/constants";

export interface AuthConfig {
  issuer: string;
  audience: string;
  clientId: string;
  jwksUri: string;
}

export interface AuthenticatedUser {
  /** Syncro user ID: `"logto:" + sub`. */
  userId: string;
  /** Token issuer, recorded on the user's profile at signup. */
  issuer: string;
}

export type AuthFailureReason = "missing_token" | "malformed_header" | "invalid_token" | "jwks_unavailable";

export class AuthError extends Error {
  readonly reason: AuthFailureReason;
  constructor(reason: AuthFailureReason) {
    super(`Authentication failed: ${reason}`);
    this.name = "AuthError";
    this.reason = reason;
  }
}

export type Authenticate = (authorizationHeader: string | undefined) => Promise<AuthenticatedUser>;

/** Upper bound on a token's length; Logto access tokens are far smaller. */
const MAX_TOKEN_LENGTH = 8192;
const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;

/** Accepted `typ` header values (compared case-insensitively). */
const ACCESS_TOKEN_TYPES = new Set(["at+jwt", "application/at+jwt"]);

/**
 * JOSE error codes caused by the token itself. Anything else (a JWKS timeout,
 * a non-200 or unparsable JWKS response, a network error) means the key set
 * could not be used.
 */
const TOKEN_ERROR_CODES = new Set([
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_EXPIRED",
  "ERR_JWT_INVALID",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JOSE_NOT_SUPPORTED",
  "ERR_JWK_INVALID",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
]);

/** The tenant's key set: cached by `jose`, re-fetched on an unknown key, 3-second fetch timeout. */
export function remoteKeySet(jwksUri: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: AUTH.jwksTimeoutMs });
}

function isTokenError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && TOKEN_ERROR_CODES.has(code);
}

export function createAuthenticator(config: AuthConfig, keys: JWTVerifyGetKey = remoteKeySet(config.jwksUri)): Authenticate {
  return async (authorizationHeader) => {
    if (authorizationHeader === undefined || authorizationHeader === "") throw new AuthError("missing_token");
    if (authorizationHeader.length > MAX_TOKEN_LENGTH + "Bearer ".length) throw new AuthError("malformed_header");
    const match = BEARER.exec(authorizationHeader);
    if (!match) throw new AuthError("malformed_header");

    let payload: Record<string, unknown>;
    let typ: unknown;
    try {
      const result = await jwtVerify(match[1], keys, {
        algorithms: [...AUTH.allowedAlgorithms],
        issuer: config.issuer,
        audience: config.audience,
        clockTolerance: AUTH.clockToleranceSeconds,
        requiredClaims: ["exp", "sub", AUTH.clientIdClaim],
      });
      payload = result.payload;
      typ = result.protectedHeader.typ;
    } catch (error) {
      throw new AuthError(isTokenError(error) ? "invalid_token" : "jwks_unavailable");
    }

    if (typ !== undefined && (typeof typ !== "string" || !ACCESS_TOKEN_TYPES.has(typ.toLowerCase()))) {
      throw new AuthError("invalid_token");
    }
    if (payload[AUTH.clientIdClaim] !== config.clientId) throw new AuthError("invalid_token");
    const sub = payload.sub;
    if (typeof sub !== "string" || !AUTH.subPattern.test(sub)) throw new AuthError("invalid_token");

    return { userId: `${AUTH.userIdPrefix}${sub}`, issuer: config.issuer };
  };
}
