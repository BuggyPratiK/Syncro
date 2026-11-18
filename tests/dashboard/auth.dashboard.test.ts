/**
 * Logto access-token verification: rejection matrix with locally generated
 * keys. No network access.
 */

import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  errors,
  type CryptoKey,
  type JWTVerifyGetKey,
} from "jose";
import { AuthError, createAuthenticator, type AuthConfig } from "../../src/dashboard/auth";

const CONFIG: AuthConfig = {
  issuer: "https://tenant.logto.app/oidc",
  audience: "https://api.syncro.test",
  clientId: "spaclientid01",
  jwksUri: "https://tenant.logto.app/oidc/jwks",
};
const SUB = "abcdef123456";

let privateKey: CryptoKey;
let keys: JWTVerifyGetKey;
let otherPrivateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("ES384");
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES384" };
  keys = createLocalJWKSet({ keys: [jwk] });
  otherPrivateKey = (await generateKeyPair("ES384")).privateKey;
});

interface TokenOptions {
  claims?: Record<string, unknown>;
  header?: Record<string, unknown>;
  key?: CryptoKey;
  sub?: string | null;
  issuer?: string;
  audience?: string;
  expiresAt?: number;
  notBefore?: number;
}

async function token(o: TokenOptions = {}): Promise<string> {
  const nowS = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ client_id: CONFIG.clientId, ...o.claims })
    .setProtectedHeader({ alg: "ES384", kid: "k1", typ: "at+jwt", ...o.header })
    .setIssuer(o.issuer ?? CONFIG.issuer)
    .setAudience(o.audience ?? CONFIG.audience)
    .setIssuedAt(nowS)
    .setExpirationTime(o.expiresAt ?? nowS + 3600);
  if (o.sub !== null) jwt.setSubject(o.sub ?? SUB);
  if (o.notBefore !== undefined) jwt.setNotBefore(o.notBefore);
  return jwt.sign(o.key ?? privateKey);
}

const authenticate = () => createAuthenticator(CONFIG, keys);

async function reason(header: string | undefined, auth = authenticate()): Promise<string> {
  const error = await auth(header).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AuthError);
  return (error as AuthError).reason;
}

describe("authenticate", () => {
  it("accepts a valid Logto access token and returns the Syncro user ID", async () => {
    const user = await authenticate()(`Bearer ${await token()}`);
    expect(user).toEqual({ userId: `logto:${SUB}`, issuer: CONFIG.issuer });
  });

  it("accepts a token without a typ header and the lowercase bearer scheme", async () => {
    const t = await token({ header: { typ: undefined } });
    await expect(authenticate()(`bearer ${t}`)).resolves.toMatchObject({ userId: `logto:${SUB}` });
  });

  it("allows 5 seconds of clock skew and no more", async () => {
    const nowS = Math.floor(Date.now() / 1000);
    await expect(authenticate()(`Bearer ${await token({ expiresAt: nowS - 3 })}`)).resolves.toBeDefined();
    expect(await reason(`Bearer ${await token({ expiresAt: nowS - 30 })}`)).toBe("invalid_token");
    expect(await reason(`Bearer ${await token({ notBefore: nowS + 30 })}`)).toBe("invalid_token");
  });

  it.each([
    ["absent", undefined, "missing_token"],
    ["empty", "", "missing_token"],
    ["another scheme", "Basic dXNlcjpwYXNz", "malformed_header"],
    ["no token", "Bearer ", "malformed_header"],
    ["not a JWT", "Bearer abc", "malformed_header"],
    ["extra parts", "Bearer a.b.c.d", "malformed_header"],
    ["oversized", `Bearer ${"a".repeat(5000)}.${"b".repeat(5000)}.c`, "malformed_header"],
  ])("rejects an %s authorization header", async (_label, header, expected) => {
    expect(await reason(header)).toBe(expected);
  });

  it.each<[string, TokenOptions]>([
    ["wrong issuer", { issuer: "https://other.logto.app/oidc" }],
    ["wrong audience", { audience: "https://other.api" }],
    ["another client", { claims: { client_id: "otherclient" } }],
    ["no client_id", { claims: { client_id: undefined } }],
    ["no sub", { sub: null }],
    ["sub in the wrong format", { sub: "ABCDEF123456" }],
    ["sub too short", { sub: "abc123" }],
    ["an ID-token typ", { header: { typ: "JWT" } }],
    ["foreign signing key", { key: undefined }],
  ])("rejects a token with %s", async (label, options) => {
    const t = label === "foreign signing key" ? await token({ key: otherPrivateKey }) : await token(options);
    expect(await reason(`Bearer ${t}`)).toBe("invalid_token");
  });

  it("rejects a tampered token", async () => {
    const [h, p, s] = (await token()).split(".");
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: "zzzzzzzzzzzz" })).toString("base64url");
    expect(await reason(`Bearer ${h}.${forged}.${s}`)).toBe("invalid_token");
  });

  it("rejects alg none and HMAC tokens", async () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const nowS = Math.floor(Date.now() / 1000);
    const claims = enc({ iss: CONFIG.issuer, aud: CONFIG.audience, sub: SUB, client_id: CONFIG.clientId, exp: nowS + 600 });
    expect(await reason(`Bearer ${enc({ alg: "none" })}.${claims}.sig`)).toBe("invalid_token");
    const hmac = await new SignJWT({ client_id: CONFIG.clientId })
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setSubject(SUB)
      .setIssuer(CONFIG.issuer)
      .setAudience(CONFIG.audience)
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("shared-secret-shared-secret-32by"));
    expect(await reason(`Bearer ${hmac}`)).toBe("invalid_token");
  });

  it("reports an unreachable or timed-out key set separately from a bad token", async () => {
    const t = await token();
    const timeout: JWTVerifyGetKey = async () => {
      throw new errors.JWKSTimeout();
    };
    const httpError: JWTVerifyGetKey = async () => {
      throw new errors.JOSEError("Expected 200 OK from the JSON Web Key Set HTTP response");
    };
    const network: JWTVerifyGetKey = async () => {
      throw new TypeError("fetch failed");
    };
    for (const k of [timeout, httpError, network]) {
      expect(await reason(`Bearer ${t}`, createAuthenticator(CONFIG, k))).toBe("jwks_unavailable");
    }
  });
});
