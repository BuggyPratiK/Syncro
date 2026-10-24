/**
 * Push event handler.
 * Orchestrates the full pipeline for a GitHub push event:
 * validate → check repo config → enrich → persist → notify.
 */

import { GitHubPushPayload } from "../../types/github.types";
import { findActiveRepo } from "../../services/repository.service";
import { enrichPushEvent } from "../../services/enrichment.service";
import { dispatchPushNotification } from "../../notifications/engine";
import { saveCommit } from "../../db/operations/commit.ops";
import { markDeliveryProcessed, markDeliveryFailed } from "../../db/operations/delivery.ops";
import { branchFromRef } from "../../utils/format";
import { logger } from "../../utils/logger";

export async function handlePushEvent(
  payload: GitHubPushPayload,
  deliveryId: string,
  installationId: number,
): Promise<void> {
  const repoId = String(payload.repository.id);
  const branch = branchFromRef(payload.ref);

  // Fetch repo config from DynamoDB
  const repoConfig = await findActiveRepo(repoId);
  if (!repoConfig) {
    logger.info("Push event ignored — repo not registered or inactive", {
      repo: payload.repository.full_name,
    });
    await markDeliveryProcessed(deliveryId);
    return;
  }

  // Filter by watched branch
  if (branch !== repoConfig.watched_branch) {
    logger.debug("Push event ignored — branch not watched", {
      branch,
      watchedBranch: repoConfig.watched_branch,
      repo: payload.repository.full_name,
    });
    await markDeliveryProcessed(deliveryId);
    return;
  }

  // Skip delete and tag events
  if (payload.deleted || payload.commits.length === 0) {
    logger.debug("Push event ignored — branch deleted or no commits", {
      repo: payload.repository.full_name,
    });
    await markDeliveryProcessed(deliveryId);
    return;
  }

  try {
    // Enrich commit data from GitHub API
    const summary = await enrichPushEvent(payload, installationId, deliveryId);

    // Persist all commits to DynamoDB
    await Promise.all(
      summary.commits.map((commit) =>
        saveCommit(repoId, deliveryId, branch, commit),
      ),
    );

    // Dispatch notifications to all configured channels
    await dispatchPushNotification(summary, repoConfig);

    await markDeliveryProcessed(deliveryId);

    logger.info("Push event processed successfully", {
      repo: payload.repository.full_name,
      branch,
      commits: summary.commits.length,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Push event processing failed", {
      repo: payload.repository.full_name,
      error: errorMessage,
    });
    await markDeliveryFailed(deliveryId, errorMessage);
    throw error; // Re-throw so Lambda returns 500 and GitHub can retry
  }
}
