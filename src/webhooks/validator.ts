/**
 * GitHub webhook signature validator.
 * Must be called with the RAW request body before any JSON parsing.
 */

import { APIGatewayProxyEvent } from "aws-lambda";
import { verifyGitHubSignature } from "../utils/crypto";
import { getEnv } from "../config/env";

export interface ValidationResult {
  valid: boolean;
  rawBody: string;
  error?: string;
}

/**
 * Validates the GitHub webhook signature from an API Gateway event.
 */
export function validateWebhookSignature(event: APIGatewayProxyEvent): ValidationResult {
  const signature = event.headers["x-hub-signature-256"] ?? event.headers["X-Hub-Signature-256"];

  if (!signature) {
    return { valid: false, rawBody: "", error: "Missing X-Hub-Signature-256 header" };
  }

  // API Gateway may base64-encode the body for binary content types
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : (event.body ?? "");

  const isValid = verifyGitHubSignature(getEnv().GITHUB_WEBHOOK_SECRET, rawBody, signature);

  if (!isValid) {
    return { valid: false, rawBody, error: "Invalid webhook signature" };
  }

  return { valid: true, rawBody };
}
