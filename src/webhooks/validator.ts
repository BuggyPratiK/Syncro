/**
 * GitHub webhook signature validator.
 * Must be called with the RAW request body before any JSON parsing.
 *
 * The webhook secret comes from SSM (see config/secrets). If it cannot be
 * read, `SecretUnavailableError` propagates and the request must not be
 * processed.
 */

import { APIGatewayProxyEvent } from "aws-lambda";
import { verifyGitHubSignature } from "../utils/crypto";
import { getSenderSecrets } from "../config/secrets";

export interface ValidationResult {
  valid: boolean;
  rawBody: string;
  error?: string;
}

/**
 * Validates the GitHub webhook signature from an API Gateway event.
 */
export async function validateWebhookSignature(
  event: APIGatewayProxyEvent,
): Promise<ValidationResult> {
  const signature = event.headers["x-hub-signature-256"] ?? event.headers["X-Hub-Signature-256"];

  if (!signature) {
    return { valid: false, rawBody: "", error: "Missing X-Hub-Signature-256 header" };
  }

  // API Gateway may base64-encode the body for binary content types
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : (event.body ?? "");

  const { githubWebhookSecret } = await getSenderSecrets();
  const isValid = verifyGitHubSignature(githubWebhookSecret, rawBody, signature);

  if (!isValid) {
    return { valid: false, rawBody, error: "Invalid webhook signature" };
  }

  return { valid: true, rawBody };
}
