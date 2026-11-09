/**
 * Notification Engine.
 * Dispatches notifications to configured providers for a given push event.
 * Provider selection is driven by repository config from DynamoDB.
 */

import { PushEventSummary, GitHubPullRequestPayload } from "../types/github.types";
import { NotificationPayload, NotificationProvider } from "../types/notification.types";
import { RepoConfigItem } from "../types/dynamodb.types";
import { DiscordProvider } from "./providers/discord.provider";
import {
  createNotificationRecord,
  markNotificationSent,
  markNotificationFailed,
} from "../db/operations/notification.ops";
import { extractDestinationId } from "../db/table";
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
 * Builds the generic NotificationPayload from a GitHub PR payload.
 */
export function buildPrPayload(
  payload: GitHubPullRequestPayload,
): NotificationPayload {
  const pr = payload.pull_request;
  const isMerged = pr.merged === true;

  return {
    type: "pull_request",
    repoFullName: payload.repository.full_name,
    repoUrl: payload.repository.html_url,
    branch: pr.base.ref,
    pusherName: pr.user.login,
    commits: [],
    totalAdditions: pr.additions ?? 0,
    totalDeletions: pr.deletions ?? 0,
    totalFilesChanged: pr.changed_files ?? 0,
    changedFiles: [],
    compareUrl: pr.html_url,
    timestamp: new Date().toISOString(),
    pullRequest: {
      action: payload.action,
      number: pr.number,
      title: pr.title,
      body: pr.body,
      url: pr.html_url,
      authorName: pr.user.login,
      authorAvatarUrl: pr.user.avatar_url,
      baseBranch: pr.base.ref,
      headBranch: pr.head.ref,
      merged: isMerged,
      draft: pr.draft,
    },
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
 * Helper to dispatch a NotificationPayload across all configured providers.
 */
async function dispatchToProviders(
  repoId: string,
  deliveryId: string,
  payload: NotificationPayload,
  repoConfig: RepoConfigItem,
): Promise<void> {
  const providers = getProviders(repoConfig);

  if (providers.length === 0) {
    logger.warn("No notification providers configured for repo", {
      repo: payload.repoFullName,
    });
    return;
  }

  // Send to all configured channels (sequentially in MVP — parallel in Phase 4+)
  for (const provider of providers) {
    const targetUrl =
      provider.channel === "discord"
        ? repoConfig.discord_webhook_url
        : undefined;

    const destinationId = extractDestinationId(targetUrl);

    const notificationId = await createNotificationRecord(
      repoId,
      deliveryId,
      provider.channel,
      destinationId,
    );

    try {
      const result = await provider.send(payload, targetUrl);

      if (result.success) {
        await markNotificationSent(repoId, notificationId, result.messageId);
        logger.info("Notification delivered", {
          channel: provider.channel,
          repo: payload.repoFullName,
          retried: result.retried,
          retryCount: result.retryCount,
        });
      } else {
        await markNotificationFailed(
          repoId,
          notificationId,
          result.error ?? "Unknown error",
          result.retryCount,
        );
        logger.error("Notification delivery failed", {
          channel: provider.channel,
          repo: payload.repoFullName,
          error: result.error,
          retryCount: result.retryCount,
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await markNotificationFailed(repoId, notificationId, errorMessage);
      logger.error("Unexpected notification provider exception", {
        channel: provider.channel,
        repo: payload.repoFullName,
        error: errorMessage,
      });
    }
  }
}

/**
 * Sends notifications for a push event to all configured channels.
 */
export async function dispatchPushNotification(
  summary: PushEventSummary,
  repoConfig: RepoConfigItem,
): Promise<void> {
  const payload = buildPayload(summary);
  await dispatchToProviders(summary.repoId, summary.deliveryId, payload, repoConfig);
}

/**
 * Sends notifications for a pull request event to all configured channels.
 */
export async function dispatchPullRequestNotification(
  payload: GitHubPullRequestPayload,
  repoConfig: RepoConfigItem,
  deliveryId: string,
): Promise<void> {
  const notifPayload = buildPrPayload(payload);
  const repoId = String(payload.repository.id);
  await dispatchToProviders(repoId, deliveryId, notifPayload, repoConfig);
}
