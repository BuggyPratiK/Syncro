/**
 * AWS Lambda Handler — Syncro GitHub Webhook Receiver
 *
 * This is the entry point for all Lambda invocations triggered by API Gateway.
 * Routes:
 *   POST /webhooks/github  — GitHub webhook events
 *   GET  /health           — Health check
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from "aws-lambda";
import { validateWebhookSignature } from "./webhooks/validator";
import { routeWebhookEvent } from "./webhooks/router";
import {
  claimDelivery,
  markDeliveryIgnored,
  markDeliveryFailed,
} from "./db/operations/delivery.ops";
import { logger } from "./utils/logger";

// ─── Response Helpers ─────────────────────────────────────────────────────────

function response(
  statusCode: number,
  body: Record<string, unknown>,
  requestId?: string,
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, requestId }),
  };
}

//--------- Lambda Handler -----------

export async function handler(
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> {
  const requestId = context.awsRequestId;
  const method = event.httpMethod;
  const path = event.path;

  logger.info("Request received", { method, path, requestId });

  //--------- Health check ------------
  if (method === "GET" && path === "/health") {
    return response(200, { status: "ok", service: "syncro" }, requestId);
  }

  //------- Webhook endpoint -----------
  if (method === "POST" && path === "/webhooks/github") {
    return handleGitHubWebhook(event, requestId);
  }

  return response(404, { error: "Not found" }, requestId);
}

async function handleGitHubWebhook(
  event: APIGatewayProxyEvent,
  requestId: string,
): Promise<APIGatewayProxyResult> {
  //Validate signature BEFORE any processing
  const validation = validateWebhookSignature(event);
  if (!validation.valid) {
    logger.warn("Webhook signature validation failed", { error: validation.error, requestId });
    return response(401, { error: "Unauthorized" }, requestId);
  }

  //Parse payload
  let payload: unknown;
  try {
    payload = JSON.parse(validation.rawBody.replace(/^\uFEFF/, ""));
  } catch {
    logger.warn("Failed to parse webhook payload as JSON", { requestId });
    return response(400, { error: "Invalid JSON payload" }, requestId);
  }

  //Extract delivery ID for idempotency
  const deliveryId =
    event.headers["x-github-delivery"] ?? event.headers["X-GitHub-Delivery"];

  if (!deliveryId) {
    logger.warn("Missing X-GitHub-Delivery header", { requestId });
    return response(400, { error: "Missing X-GitHub-Delivery header" }, requestId);
  }

  //Claim delivery (idempotency check + atomic lock)
  const eventType = event.headers["x-github-event"] ?? event.headers["X-GitHub-Event"] ?? "unknown";
  const githubRepoId = String((payload as { repository?: { id?: number } })?.repository?.id ?? "unknown");

  const isClaimed = await claimDelivery(deliveryId, githubRepoId, eventType);
  if (!isClaimed) {
    logger.info("Duplicate delivery — already processed or in progress", { deliveryId, requestId });
    return response(200, { message: "Already processed" }, requestId);
  }

  //Route to appropriate handler
  try {
    const result = await routeWebhookEvent(event, payload, deliveryId);

    if (!result.handled) {
      logger.debug("Event not handled", { eventType: result.eventType, requestId });
      await markDeliveryIgnored(deliveryId, `Unsupported event: ${result.eventType}`);
      return response(200, { message: "Event received but not handled" }, requestId);
    }

    return response(200, { message: "OK" }, requestId);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Internal server error";
    logger.error("Webhook processing error", { error: errorMessage, requestId });
    await markDeliveryFailed(deliveryId, errorMessage);
    return response(500, { error: "Internal server error" }, requestId);
  }
}
