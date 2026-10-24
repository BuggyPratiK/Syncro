/**
 * Notification Engine.
 * Dispatches notifications to configured providers for a given push event.
 * Provider selection is driven by repository config from DynamoDB.
 */

import { PushEventSummary } from "../types/github.types";
import { NotificationPayload, NotificationProvider } from "../types/notification.types";
import { RepoConfigItem } from "../types/dynamodb.types";
import { DiscordProvider } from "./providers/discord.provider";
import {
  createNotificationRecord,
  markNotificationSent,
  markNotificationFailed,
} from "../db/operations/notification.ops";
import { logger } from "../utils/logger";

// Instantiate providers once per Lambda cold start (reused across warm invocations)
const discordProvider = new DiscordProvider();

/**
 * Builds the generic NotificationPayload from an enriched push summary.
 * This is provider-agnostic — each provider formats it for their own API.
 */
function buildPayload(summary: PushEventSummary): NotificationPayload {
  return {
    type: "push",
    repoFullName: summary.repoFullName,
    repoUrl: summary.repoUrl,
    branch: summary.branch,
    pusherName: summary.pusherName,
    commits: summary.commits.map((c) => ({
      sha: c.id,
      shortSha: c.id.substring(0, 7),
      message: c.message,
      url: c.url,
      authorName: c.author.name,
    })),
    totalAdditions: summary.totalAdditions,
    totalDeletions: summary.totalDeletions,
    totalFilesChanged: summary.totalFilesChanged,
    changedFiles: summary.commits.flatMap((c) => c.allChangedFiles),
    compareUrl: summary.compareUrl,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Determines which providers to use for a given repo config.
 * Currently only Discord is implemented (Phase 1).
 */
function getProviders(repoConfig: RepoConfigItem): NotificationProvider[] {
  const providers: NotificationProvider[] = [];
  if (repoConfig.discord_webhook_url) {
    providers.push(discordProvider);
  }
  // Phase 2: if (repoConfig.telegram_chat_id) providers.push(telegramProvider);
  // Phase 3: if (repoConfig.slack_webhook_url) providers.push(slackProvider);
  return providers;
}

/**
 * Sends notifications for a push event to all configured channels.
 */
export async function dispatchPushNotification(
  summary: PushEventSummary,
  repoConfig: RepoConfigItem,
): Promise<void> {
  const payload = buildPayload(summary);
  const providers = getProviders(repoConfig);

  if (providers.length === 0) {
    logger.warn("No notification providers configured for repo", {
      repo: summary.repoFullName,
    });
    return;
  }

  // Send to all configured channels (sequentially in MVP — parallel in Phase 4+)
  for (const provider of providers) {
    const notifTimestamp = await createNotificationRecord(
      summary.repoId,
      summary.deliveryId,
      provider.channel,
    );

    const result = await provider.send(payload);

    if (result.success) {
      await markNotificationSent(summary.repoId, notifTimestamp, result.messageId);
      logger.info("Notification delivered", {
        channel: provider.channel,
        repo: summary.repoFullName,
        retried: result.retried,
      });
    } else {
      await markNotificationFailed(summary.repoId, notifTimestamp, result.error ?? "Unknown error");
      logger.error("Notification delivery failed", {
        channel: provider.channel,
        repo: summary.repoFullName,
        error: result.error,
      });
    }
  }
}
