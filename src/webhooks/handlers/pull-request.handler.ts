/**
 * Pull Request event handler.
 * Orchestrates the full pipeline for a GitHub pull_request event:
 * check repo config → filter branch & action → dispatch notification → record delivery.
 */

import { GitHubPullRequestPayload } from "../../types/github.types";
import { findActiveRepo } from "../../services/repository.service";
import { dispatchPullRequestNotification } from "../../notifications/engine";
import { markDeliveryProcessed, markDeliveryFailed } from "../../db/operations/delivery.ops";
import { logger } from "../../utils/logger";

const RELEVANT_PR_ACTIONS = new Set(["opened", "closed", "reopened"]);

export async function handlePullRequestEvent(
  payload: GitHubPullRequestPayload,
  deliveryId: string,
): Promise<void> {
  const repoId = String(payload.repository.id);
  const baseBranch = payload.pull_request?.base?.ref;
  const action = payload.action;

  // Fetch repo config from DynamoDB
  const repoConfig = await findActiveRepo(repoId);
  if (!repoConfig) {
    logger.info("PR event ignored — repo not registered or inactive", {
      repo: payload.repository.full_name,
    });
    await markDeliveryProcessed(deliveryId);
    return;
  }

  // Filter by watched branch (only notify for PRs targeting the watched branch, e.g. main)
  if (baseBranch !== repoConfig.watched_branch) {
    logger.debug("PR event ignored — target branch not watched", {
      baseBranch,
      watchedBranch: repoConfig.watched_branch,
      repo: payload.repository.full_name,
    });
    await markDeliveryProcessed(deliveryId);
    return;
  }

  // Filter noisy actions (labeled, assigned, synchronize, etc.) — keep notifications high-signal
  if (!RELEVANT_PR_ACTIONS.has(action)) {
    logger.debug("PR event ignored — action not relevant", {
      action,
      repo: payload.repository.full_name,
    });
    await markDeliveryProcessed(deliveryId);
    return;
  }

  try {
    // Dispatch notifications to all configured channels
    await dispatchPullRequestNotification(payload, repoConfig, deliveryId);

    await markDeliveryProcessed(deliveryId);

    logger.info("PR event processed successfully", {
      repo: payload.repository.full_name,
      number: payload.pull_request.number,
      action,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("PR event processing failed", {
      repo: payload.repository.full_name,
      error: errorMessage,
    });
    await markDeliveryFailed(deliveryId, errorMessage);
    throw error;
  }
}

