/**
 * Event Router.
 * Routes validated webhook events to the appropriate handler
 * based on the X-GitHub-Event header.
 */

import { APIGatewayProxyEvent } from "aws-lambda";
import { handlePushEvent } from "./handlers";
import { GitHubPushPayload } from "../types/github.types";
import { logger } from "../utils/logger";

export type SupportedEvent = "push";
const SUPPORTED_EVENTS: SupportedEvent[] = ["push"];

export interface RouterResult {
  handled: boolean;
  eventType?: string;
}

export async function routeWebhookEvent(
  event: APIGatewayProxyEvent,
  parsedPayload: unknown,
  deliveryId: string,
): Promise<RouterResult> {
  const eventType = event.headers["x-github-event"] ?? event.headers["X-GitHub-Event"];

  if (!eventType) {
    logger.warn("Missing X-GitHub-Event header");
    return { handled: false };
  }

  if (!SUPPORTED_EVENTS.includes(eventType as SupportedEvent)) {
    logger.debug("Unsupported event type — ignoring", { eventType });
    return { handled: false, eventType };
  }

  // GitHub Apps send installation ID in the payload
  const installationId = (parsedPayload as { installation?: { id: number } })?.installation?.id;
  if (!installationId) {
    logger.warn("Missing installation ID in payload — is this a GitHub App webhook?", { eventType });
    // Continue anyway for PAT-based setups — enrichment will handle auth separately
  }

  switch (eventType) {
    case "push":
      await handlePushEvent(
        parsedPayload as GitHubPushPayload,
        deliveryId,
        installationId ?? 0,
      );
      return { handled: true, eventType };

    default:
      return { handled: false, eventType };
  }
}
