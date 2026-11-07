/**
 * Cryptographic utilities for webhook signature verification.
 */

import { createHmac, timingSafeEqual } from "crypto";

/**
 * Verifies a GitHub webhook HMAC-SHA256 signature.
 *
 * @param secret
 * @param rawBody
 * @param signature - The X-Hub-Signature-256 header value (format: "sha256=<hex>")
 * @returns true if the signature is valid, false otherwise
 *
 * SECURITY: Uses timingSafeEqual to prevent timing attacks.
 */
export function verifyGitHubSignature(
  secret: string,
  rawBody: string,
  signature: string,
): boolean {
  if (!signature || !signature.startsWith("sha256=")) {
    return false;
  }

  const expectedHex = createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex");

  const expected = Buffer.from(`sha256=${expectedHex}`, "utf8");
  const received = Buffer.from(signature, "utf8");

  if (expected.length !== received.length) {
    return false;
  }

  return timingSafeEqual(expected, received);
}
