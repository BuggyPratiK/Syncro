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
import { getDiscordDestination } from "../db/operations/destination.ops";
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

interface ResolvedTarget {
  provider: NotificationProvider;
  targetUrl: string;
  destinationId?: string;
}

/**
 * Resolves notification targets for a given repository.
 * Resolves normalized destination references (discord_destination_id) first,
 * and falls back to legacy direct webhook URLs for backward compatibility.
 */
async function resolveNotificationTargets(
  repoConfig: RepoConfigItem,
): Promise<ResolvedTarget[]> {
  const targets: ResolvedTarget[] = [];

  // 1. Check normalized Discord destination reference
  if (repoConfig.discord_destination_id) {
    const destination = await getDiscordDestination(repoConfig.discord_destination_id);
    if (!destination) {
      logger.warn("Referenced Discord destination not found", {
        repo: repoConfig.github_full_name,
        destinationId: repoConfig.discord_destination_id,
      });
    } else if (!destination.is_active) {
      logger.warn("Referenced Discord destination is inactive — skipping notification", {
        repo: repoConfig.github_full_name,
        destinationId: destination.destination_id,
        displayName: destination.display_name,
      });
    } else {
      targets.push({
        provider: discordProvider,
        targetUrl: destination.discord_webhook_url,
        destinationId: destination.destination_id,
      });
    }
  } else if (repoConfig.discord_webhook_url) {
    // 2. Backward compatibility fallback: repository item still has discord_webhook_url
    targets.push({
      provider: discordProvider,
      targetUrl: repoConfig.discord_webhook_url,
      destinationId: extractDestinationId(repoConfig.discord_webhook_url),
    });
  }

  // Future providers (Phase 2 & Phase 3):
  // if (repoConfig.telegram_chat_id) { ... }
  // if (repoConfig.slack_webhook_url) { ... }

  return targets;
}

/**
 * Helper to dispatch a NotificationPayload across all configured targets.
 */
async function dispatchToProviders(
  repoId: string,
  deliveryId: string,
  payload: NotificationPayload,
  repoConfig: RepoConfigItem,
): Promise<void> {
  const targets = await resolveNotificationTargets(repoConfig);

  if (targets.length === 0) {
    logger.warn("No active notification destinations configured for repo", {
      repo: payload.repoFullName,
    });
    return;
  }

  // Send to all configured targets sequentially
  for (const target of targets) {
    const notificationId = await createNotificationRecord(
      repoId,
      deliveryId,
      target.provider.channel,
      target.destinationId,
    );

    try {
      const result = await target.provider.send(payload, target.targetUrl);

      if (result.success) {
        await markNotificationSent(repoId, notificationId, result.messageId);
        logger.info("Notification delivered", {
          channel: target.provider.channel,
          repo: payload.repoFullName,
          destinationId: target.destinationId,
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
          channel: target.provider.channel,
          repo: payload.repoFullName,
          destinationId: target.destinationId,
          error: result.error,
          retryCount: result.retryCount,
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await markNotificationFailed(repoId, notificationId, errorMessage);
      logger.error("Unexpected notification provider exception", {
        channel: target.provider.channel,
        repo: payload.repoFullName,
        destinationId: target.destinationId,
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
