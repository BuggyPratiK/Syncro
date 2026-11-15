/**
 * Pull Request event handler.
 * Orchestrates the full pipeline for a GitHub pull_request event:
 * resolve the owning workspace → filter branch & action → notify → record the
 * delivery in the workspace's history.
 *
 * Deliveries that do not belong to an active workspace (or are filtered out)
 * are marked ignored with a reason code and never appear in any history.
 */

import { GitHubPullRequestPayload } from "../../types/github.types";
import { resolveWebhookTarget } from "../resolve-target";
import { dispatchPullRequestNotification } from "../../notifications/engine";
import {
  markDeliveryProcessed,
  markDeliveryFailed,
  markDeliveryIgnored,
  type DeliveryStamp,
} from "../../db/operations/delivery.ops";
import { logger } from "../../utils/logger";
import type { Deadline } from "../../utils/deadline";

const RELEVANT_PR_ACTIONS = new Set(["opened", "closed", "reopened"]);

export async function handlePullRequestEvent(
  payload: GitHubPullRequestPayload,
  deliveryId: string,
  installationId?: number,
  deadline?: Deadline,
): Promise<void> {
  const repoId = String(payload.repository.id);
  const baseBranch = payload.pull_request?.base?.ref;
  const action = payload.action;

  const resolved = await resolveWebhookTarget(repoId, installationId);
  if (!resolved.ok) {
    logger.info("PR event ignored", { repo: payload.repository.full_name, reason: resolved.reason });
    await markDeliveryIgnored(deliveryId, resolved.reason);
    return;
  }
  const { target } = resolved;

  // Only notify for PRs targeting the watched branch (e.g. main)
  if (baseBranch !== target.repo.watched_branch) {
    logger.debug("PR event ignored — target branch not watched", {
      baseBranch,
      watchedBranch: target.repo.watched_branch,
      repo: payload.repository.full_name,
    });
    await markDeliveryIgnored(deliveryId, "branch_not_watched");
    return;
  }

  // Filter noisy actions (labeled, assigned, synchronize, etc.) — keep notifications high-signal
  if (!RELEVANT_PR_ACTIONS.has(action)) {
    logger.debug("PR event ignored — action not relevant", { action, repo: payload.repository.full_name });
    await markDeliveryIgnored(deliveryId, "event_not_supported");
    return;
  }

  const stamp: DeliveryStamp = {
    workspaceId: target.repo.workspace_id,
    summary: {
      repo_full_name: payload.repository.full_name,
      event_type: "pull_request",
      branch: baseBranch,
      action,
      pr_number: payload.pull_request.number,
    },
  };

  try {
    await dispatchPullRequestNotification(payload, target, deliveryId, deadline);

    await markDeliveryProcessed(deliveryId, stamp);

    logger.info("PR event processed successfully", {
      repo: payload.repository.full_name,
      number: payload.pull_request.number,
      action,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("PR event processing failed", { repo: payload.repository.full_name, error: errorMessage });
    await markDeliveryFailed(deliveryId, errorMessage, stamp);
    throw error;
  }
}
