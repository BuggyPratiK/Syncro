/**
 * Notification Engine.
 * Dispatches notifications for a webhook delivery that has been resolved to a
 * workspace (see webhooks/resolve-target.ts).
 *
 * The only possible target is the repository's destination inside its own
 * workspace, and only while that destination can receive notifications
 * (active, with a stored secret reference). There is no fallback: no global
 * URL and no URL stored on any record. The webhook URL is read from SSM by the
 * destination-secret reader, under a name derived here from the repository's
 * workspace and destination; if it cannot be read, the notification is
 * recorded as failed and nothing is sent.
 */

import { PushEventSummary, GitHubPullRequestPayload } from "../types/github.types";
import { NotificationPayload } from "../types/notification.types";
import { DiscordProvider } from "./providers/discord.provider";
import {
  createNotificationRecord,
  markNotificationSent,
  markNotificationFailed,
} from "../db/operations/notification.ops";
import { isDeliverableDestination } from "../db/operations/tenant-destination.ops";
import { getBaseEnv } from "../config/env";
import { deriveDestinationParamName } from "../secrets/param-names";
import {
  DestinationSecretError,
  createDestinationSecretReader,
} from "../secrets/destination-secrets";
import type { DestinationSecretReader } from "../contracts/data-ops";
import type { WebhookTarget } from "../webhooks/resolve-target";
import { logger } from "../utils/logger";
import type { Deadline } from "../utils/deadline";

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
    commitsWithStats: summary.commitsWithStats,
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

let secretReader: DestinationSecretReader | undefined;

/** The per-container destination-secret reader (created on first use). */
function reader(): DestinationSecretReader {
  if (!secretReader) secretReader = createDestinationSecretReader();
  return secretReader;
}

/** Test hook: replace the destination-secret reader. */
export function setDestinationSecretReaderForTests(testReader: DestinationSecretReader | undefined): void {
  secretReader = testReader;
}

/**
 * Sends `payload` to the repository's destination, if it has a deliverable one.
 */
async function dispatchToTarget(
  repoId: string,
  deliveryId: string,
  payload: NotificationPayload,
  target: WebhookTarget,
  deadline?: Deadline,
): Promise<void> {
  const { repo, destination } = target;
  if (!destination || !isDeliverableDestination(destination)) {
    logger.warn("No deliverable destination for repo; nothing sent", {
      repo: payload.repoFullName,
      destinationId: repo.discord_destination_id,
      status: destination?.status,
    });
    return;
  }

  const channel = discordProvider.channel;
  const destinationId = destination.destination_id;
  const { notificationId, alreadySent } = await createNotificationRecord(
    repoId,
    deliveryId,
    channel,
    destinationId,
    repo.workspace_id,
  );

  // A retry of the same GitHub delivery must not post the same message twice.
  if (alreadySent) {
    logger.info("Notification already sent by an earlier attempt, skipping", { channel, repo: payload.repoFullName, destinationId });
    return;
  }

  // Read the webhook URL only under the name derived from the repository's own workspace.
  let targetUrl: string;
  try {
    const expectedName = deriveDestinationParamName(repo.workspace_id, destinationId, getBaseEnv().SSM_PARAM_PREFIX);
    targetUrl = await reader().read(destination.secret_ref!, expectedName);
  } catch (error) {
    const code = error instanceof DestinationSecretError ? error.code : "secret_unavailable";
    await markNotificationFailed(repoId, notificationId, code);
    logger.error("Destination webhook URL unavailable; nothing sent", { channel, repo: payload.repoFullName, destinationId, reason: code });
    return;
  }

  try {
    const result = await discordProvider.send(payload, targetUrl, { deadline });

    if (result.success) {
      await markNotificationSent(repoId, notificationId, result.messageId);
      logger.info("Notification delivered", {
        channel,
        repo: payload.repoFullName,
        destinationId,
        retried: result.retried,
        retryCount: result.retryCount,
      });
    } else {
      await markNotificationFailed(repoId, notificationId, result.error ?? "Unknown error", result.retryCount);
      logger.error("Notification delivery failed", {
        channel,
        repo: payload.repoFullName,
        destinationId,
        error: result.error,
        retryCount: result.retryCount,
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await markNotificationFailed(repoId, notificationId, errorMessage);
    logger.error("Unexpected notification provider exception", {
      channel,
      repo: payload.repoFullName,
      destinationId,
      error: errorMessage,
    });
  }
}

/**
 * Sends notifications for a push event to the repository's destination.
 */
export async function dispatchPushNotification(
  summary: PushEventSummary,
  target: WebhookTarget,
  deadline?: Deadline,
): Promise<void> {
  const payload = buildPayload(summary);
  await dispatchToTarget(summary.repoId, summary.deliveryId, payload, target, deadline);
}

/**
 * Sends notifications for a pull request event to the repository's destination.
 */
export async function dispatchPullRequestNotification(
  payload: GitHubPullRequestPayload,
  target: WebhookTarget,
  deliveryId: string,
  deadline?: Deadline,
): Promise<void> {
  const notifPayload = buildPrPayload(payload);
  const repoId = String(payload.repository.id);
  await dispatchToTarget(repoId, deliveryId, notifPayload, target, deadline);
}
