/**
 * `jose` (ESM-only) loads and works under Jest.
 *
 * The dashboard API verifies Logto access tokens with `jose`. Jest runs tests
 * as CommonJS, so the Jest config transforms `jose` for tests. This suite
 * proves that setup: sign an ES384 token with a locally generated key, verify
 * it, and reject a tampered token. No network access.
 */

import { SignJWT, generateKeyPair, jwtVerify, errors } from "jose";

const ISSUER = "https://tenant.example/oidc";
const AUDIENCE = "https://api.syncro.example";

describe("jose under Jest", () => {
  it("verifies an ES384 token signed with a local key", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES384");
    const token = await new SignJWT({ client_id: "spa-client" })
      .setProtectedHeader({ alg: "ES384", typ: "at+jwt" })
      .setSubject("abcdef123456")
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);

    const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
      algorithms: ["ES384"],
      issuer: ISSUER,
      audience: AUDIENCE,
    });

    expect(protectedHeader.alg).toBe("ES384");
    expect(payload.sub).toBe("abcdef123456");
    expect(payload.client_id).toBe("spa-client");
  });

  it("rejects a tampered token", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES384");
    const token = await new SignJWT({ client_id: "spa-client" })
      .setProtectedHeader({ alg: "ES384" })
      .setSubject("abcdef123456")
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime("1h")
      .sign(privateKey);

    const [header, body, signature] = token.split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), sub: "zzzzzzzzzzzz" }),
    ).toString("base64url");

    await expect(
      jwtVerify(`${header}.${forgedBody}.${signature}`, publicKey, {
        algorithms: ["ES384"],
        issuer: ISSUER,
        audience: AUDIENCE,
      }),
    ).rejects.toBeInstanceOf(errors.JWSSignatureVerificationFailed);
  });
});
