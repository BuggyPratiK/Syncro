/**
 * Discord notification provider.
 * Sends rich embed messages to a Discord channel via Incoming Webhook.
 *
 * Uses Discord REST API directly — no Gateway/WebSocket connection needed.
 * This works perfectly inside a stateless Lambda function.
 *
 * There is no default or global webhook URL: the caller must pass the target
 * resolved for the repository, and without one nothing is sent.
 *
 * Each attempt is aborted after `RELAY.discordAttemptTimeoutMs`, or earlier if
 * the invocation deadline (minus a safety reserve) comes first. No attempt is
 * started once that budget is used up.
 */

import {
  NotificationProvider,
  NotificationPayload,
  NotificationResult,
  SendOptions,
} from "../../types/notification.types";
import { RELAY } from "../../contracts/constants";
import { attemptTimeoutMs, type Deadline } from "../../utils/deadline";
import { logger, maskWebhookUrl } from "../../utils/logger";
import { validateDiscordWebhookUrl } from "../../utils/url-validator";
import { buildPushEmbed } from "../templates/push.template";
import { buildPrEmbed } from "../templates/pr.template";

const DISCORD_RATE_LIMIT_STATUS = 429;

export interface DiscordRetryConfig {
  maxRetries?: number;
  maxRetryDelayMs?: number;
  initialDelayMs?: number;
  getRemainingTimeMs?: () => number;
}

export const DEFAULT_DISCORD_RETRY_CONFIG: Required<Omit<DiscordRetryConfig, "getRemainingTimeMs">> = {
  maxRetries: 2,
  maxRetryDelayMs: 3000, // Bounded to 3 seconds to protect Lambda execution budget
  initialDelayMs: 500,
};

export class DiscordProvider implements NotificationProvider {
  readonly channel = "discord" as const;
  private readonly config: Required<Omit<DiscordRetryConfig, "getRemainingTimeMs">> & {
    getRemainingTimeMs?: () => number;
  };

  constructor(options?: DiscordRetryConfig) {
    this.config = {
      ...DEFAULT_DISCORD_RETRY_CONFIG,
      ...options,
    };
  }

  async send(
    payload: NotificationPayload,
    targetUrl: string,
    options?: SendOptions,
  ): Promise<NotificationResult> {
    const webhookUrl = targetUrl;
    if (!webhookUrl) {
      return {
        success: false,
        channel: this.channel,
        error: "Missing Discord webhook URL",
        retried: false,
        retryCount: 0,
      };
    }

    const validation = validateDiscordWebhookUrl(webhookUrl);
    if (!validation.valid || !validation.cleanedUrl) {
      return {
        success: false,
        channel: this.channel,
        error: `Invalid Discord webhook URL: ${validation.error}`,
        retried: false,
        retryCount: 0,
      };
    }

    const validWebhookUrl = validation.cleanedUrl;

    const embed =
      payload.type === "pull_request"
        ? buildPrEmbed(payload)
        : buildPushEmbed(payload);

    let lastError = "Unknown error";
    let lastStatusCode: number | undefined;

    // A per-send deadline wins over the constructor's remaining-time callback.
    const getRemainingTimeMs = this.config.getRemainingTimeMs;
    const deadline: Deadline | undefined =
      options?.deadline ?? (getRemainingTimeMs ? { remainingMs: getRemainingTimeMs } : undefined);
    const remainingMs = (): number | undefined => deadline?.remainingMs();

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      const timeoutMs = attemptTimeoutMs(
        deadline,
        RELAY.discordAttemptTimeoutMs,
        RELAY.deadlineSafetyReserveMs,
      );
      if (timeoutMs === 0) {
        lastError = "Insufficient execution time for Discord request";
        logger.warn("Skipping Discord attempt — execution budget exhausted", { attempt });
        break;
      }

      try {
        const response = await fetch(validWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ embeds: [embed] }),
          redirect: "error", // Prevent SSRF attacks via HTTP redirects
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (response.ok || response.status === 204) {
          logger.info("Discord notification sent", {
            channel: this.channel,
            repo: payload.repoFullName,
            attempt,
          });
          return {
            success: true,
            channel: this.channel,
            retried: attempt > 0,
            retryCount: attempt,
            statusCode: response.status,
          };
        }

        lastStatusCode = response.status;
        const errorText = await response.text();
        const sanitizedErrorText = maskWebhookUrl(errorText);
        lastError = `Discord API error ${response.status}: ${sanitizedErrorText}`;

        // 1. Permanent client errors (4xx other than 429) must NOT be retried
        if (response.status >= 400 && response.status < 500 && response.status !== DISCORD_RATE_LIMIT_STATUS) {
          logger.warn("Discord permanent error — skipping retries", {
            channel: this.channel,
            status: response.status,
            repo: payload.repoFullName,
          });
          return {
            success: false,
            channel: this.channel,
            error: lastError,
            retried: attempt > 0,
            retryCount: attempt,
            statusCode: response.status,
          };
        }

        // 2. Rate limit handling (429)
        if (response.status === DISCORD_RATE_LIMIT_STATUS) {
          if (attempt >= this.config.maxRetries) {
            lastError = `Discord rate limit exceeded after ${attempt} retries`;
            break;
          }

          const retryAfterHeader = response.headers.get("retry-after");
          const retryAfterMs = retryAfterHeader
            ? Math.ceil(parseFloat(retryAfterHeader) * 1000)
            : this.config.initialDelayMs;

          // Check against maximum allowed delay (bounded retry)
          if (retryAfterMs > this.config.maxRetryDelayMs) {
            logger.warn("Discord rate-limit delay exceeds maximum retry delay", {
              retryAfterMs,
              maxAllowedMs: this.config.maxRetryDelayMs,
              attempt,
            });
            return {
              success: false,
              channel: this.channel,
              error: `Discord rate limited: retry-after (${retryAfterMs}ms) exceeds max delay (${this.config.maxRetryDelayMs}ms)`,
              retried: attempt > 0,
              retryCount: attempt,
              statusCode: 429,
            };
          }

          // Check remaining execution budget if available
          const remaining = remainingMs();
          if (remaining !== undefined) {
            if (retryAfterMs > remaining - RELAY.deadlineSafetyReserveMs) {
              logger.warn("Discord rate-limit delay exceeds remaining execution budget", {
                retryAfterMs,
                remainingTimeMs: remaining,
                attempt,
              });
              return {
                success: false,
                channel: this.channel,
                error: `Discord rate limited: retry-after (${retryAfterMs}ms) exceeds execution budget (${remaining}ms)`,
                retried: attempt > 0,
                retryCount: attempt,
                statusCode: 429,
              };
            }
          }

          logger.warn("Discord rate limited — retrying after delay", {
            retryAfterMs,
            attempt,
          });

          await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
          continue;
        }

        // 3. Transient server errors (5xx)
        if (response.status >= 500) {
          if (attempt >= this.config.maxRetries) {
            break;
          }

          const delayMs = Math.min(
            this.config.initialDelayMs * Math.pow(2, attempt),
            this.config.maxRetryDelayMs,
          );

          const remainingForRetry = remainingMs();
          if (remainingForRetry !== undefined && delayMs > remainingForRetry - RELAY.deadlineSafetyReserveMs) {
            logger.warn("Insufficient execution budget for 5xx retry", { delayMs, attempt });
            break;
          }

          logger.warn("Discord transient 5xx error — retrying after backoff", {
            status: response.status,
            delayMs,
            attempt,
          });
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
      } catch (networkError) {
        // Network error (e.g. ECONNRESET, ETIMEDOUT, DNS failure) or the attempt timeout firing
        const isTimeout =
          networkError instanceof Error &&
          (networkError.name === "TimeoutError" || networkError.name === "AbortError");
        const errMsg = isTimeout
          ? `Discord request timed out after ${timeoutMs}ms`
          : networkError instanceof Error
            ? networkError.message
            : String(networkError);
        const sanitizedErrMsg = maskWebhookUrl(errMsg);
        lastError = `Network error: ${sanitizedErrMsg}`;

        if (attempt >= this.config.maxRetries) {
          break;
        }

        const delayMs = Math.min(
          this.config.initialDelayMs * Math.pow(2, attempt),
          this.config.maxRetryDelayMs,
        );

        const remainingForRetry = remainingMs();
        if (remainingForRetry !== undefined && delayMs > remainingForRetry - RELAY.deadlineSafetyReserveMs) {
          logger.warn("Insufficient execution budget for network retry", { delayMs, attempt });
          break;
        }

        logger.warn("Discord network error — retrying after backoff", {
          error: sanitizedErrMsg,
          delayMs,
          attempt,
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
    }

    logger.error("Discord notification failed after retries", {
      channel: this.channel,
      error: lastError,
      repo: payload.repoFullName,
    });

    return {
      success: false,
      channel: this.channel,
      error: lastError,
      retried: true,
      retryCount: this.config.maxRetries,
      statusCode: lastStatusCode,
    };
  }
}
