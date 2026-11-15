/**
 * Secret redaction for logs and stored error messages.
 */

import { redactText, sanitizeErrorForStorage, sanitizeLogData } from "../../src/utils/redact";
import { RELAY } from "../../src/contracts";

const DISCORD = "https://discord.com/api/webhooks/123456789012345678/AbCdEf-token_value";

describe("redactText", () => {
  it.each([
    ["Discord webhook token", `posting to ${DISCORD} failed`, "AbCdEf-token_value"],
    ["classic GitHub token", "auth ghs_abcdefghijklmnopqrstuvwxyz0123 rejected", "ghs_abcdefghijklmnopqrstuvwxyz0123"],
    ["fine-grained GitHub PAT", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "github_pat_11ABCDEFG"],
    ["PEM private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----", "MIIEow"],
    ["truncated PEM private key", "key=-----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN", "MIIEvQIBADAN"],
    ["bearer token", "Authorization: Bearer eyJhbGciOiJFUzM4NCJ9.payload.sig", "eyJhbGciOiJFUzM4NCJ9"],
    ["AWS access key id", "creds AKIAIOSFODNN7EXAMPLE leaked", "AKIAIOSFODNN7EXAMPLE"],
  ])("removes a %s", (_label, input, secret) => {
    expect(redactText(input)).not.toContain(secret);
    expect(redactText(input)).toContain("[REDACTED]");
  });

  it("keeps the non-secret Discord webhook ID", () => {
    expect(redactText(DISCORD)).toBe("https://discord.com/api/webhooks/123456789012345678/[REDACTED]");
  });

  it("leaves ordinary text alone", () => {
    expect(redactText("Discord API error 500: Internal Server Error")).toBe(
      "Discord API error 500: Internal Server Error",
    );
  });
});

describe("sanitizeLogData", () => {
  it("redacts secret-named keys and secrets inside nested values", () => {
    const out = sanitizeLogData({
      authorization: "Bearer abc",
      oauth_code: "abc123",
      code: "ECONNRESET",
      nested: { message: `failed: ${DISCORD}` },
    }) as Record<string, any>;
    expect(out.authorization).toBe("[REDACTED]");
    expect(out.oauth_code).toBe("[REDACTED]");
    expect(out.code).toBe("ECONNRESET"); // error codes stay readable
    expect(out.nested.message).not.toContain("AbCdEf-token_value");
  });

  it("fails closed on circular structures instead of throwing", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(() => sanitizeLogData(a)).not.toThrow();
    expect((sanitizeLogData(a) as Record<string, unknown>).self).toBe("[REDACTED]");
  });

  it("fails closed when a value cannot be inspected", () => {
    const hostile = {};
    Object.defineProperty(hostile, "boom", {
      enumerable: true,
      get() {
        throw new Error("getter exploded");
      },
    });
    expect(sanitizeLogData(hostile)).toBe("[REDACTED]");
  });
});

describe("sanitizeErrorForStorage", () => {
  it("caps the stored length and truncates rather than rejects", () => {
    const out = sanitizeErrorForStorage("x".repeat(5000));
    expect(out.length).toBe(RELAY.persistedErrorMaxChars);
    expect(out.endsWith("…")).toBe(true);
  });

  it("masks BEFORE truncating, so a secret at the cut point never leaks partially", () => {
    const padding = "e".repeat(RELAY.persistedErrorMaxChars - 60);
    const out = sanitizeErrorForStorage(`${padding} ${DISCORD} trailing text after the url`);
    expect(out).not.toMatch(/AbCdEf|token_value/);
    expect(out.length).toBeLessThanOrEqual(RELAY.persistedErrorMaxChars);
  });

  it("accepts Error objects and short messages unchanged apart from masking", () => {
    expect(sanitizeErrorForStorage(new Error("plain failure"))).toBe("plain failure");
  });
});
