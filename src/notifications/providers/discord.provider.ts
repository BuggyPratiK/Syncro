/**
 * Discord notification provider.
 * Sends rich embed messages to a Discord channel via Incoming Webhook.
 *
 * Uses Discord REST API directly — no Gateway/WebSocket connection needed.
 * This works perfectly inside a stateless Lambda function.
 */

import { NotificationProvider, NotificationPayload, NotificationResult } from "../../types/notification.types";
import { getEnv } from "../../config/env";
import { logger } from "../../utils/logger";
import { buildPushEmbed } from "../templates/push.template";
import { buildPrEmbed } from "../templates/pr.template";

const DISCORD_RATE_LIMIT_STATUS = 429;
const MAX_RETRIES = 1;

export class DiscordProvider implements NotificationProvider {
  readonly channel = "discord" as const;

  async send(payload: NotificationPayload): Promise<NotificationResult> {
    const webhookUrl = getEnv().DISCORD_WEBHOOK_URL;
    const embed =
      payload.type === "pull_request"
        ? buildPrEmbed(payload)
        : buildPushEmbed(payload);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ embeds: [embed] }),
        });

        if (response.ok || response.status === 204) {
          logger.info("Discord notification sent", {
            channel: this.channel,
            repo: payload.repoFullName,
            attempt,
          });
          return { success: true, channel: this.channel, retried: attempt > 0 };
        }

        // Handle Discord rate limiting
        if (response.status === DISCORD_RATE_LIMIT_STATUS && attempt < MAX_RETRIES) {
          const retryAfterHeader = response.headers.get("retry-after");
          const retryAfterMs = retryAfterHeader
            ? Math.ceil(parseFloat(retryAfterHeader) * 1000)
            : 1000;

          logger.warn("Discord rate limited — retrying after delay", {
            retryAfterMs,
            attempt,
          });

          await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
          continue;
        }

        const errorText = await response.text();
        throw new Error(`Discord API error ${response.status}: ${errorText}`);
      } catch (error) {
        if (attempt === MAX_RETRIES) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error("Discord notification failed after retries", {
            channel: this.channel,
            error: errorMessage,
            repo: payload.repoFullName,
          });
          return { success: false, channel: this.channel, error: errorMessage };
        }
      }
    }

    return { success: false, channel: this.channel, error: "Max retries exceeded" };
  }
}
