/**
 * Push event handler.
 * Orchestrates the full pipeline for a GitHub push event:
 * resolve the owning workspace → filter branch → enrich → persist commits →
 * notify → record the delivery in the workspace's history.
 *
 * Deliveries that do not belong to an active workspace (or are filtered out)
 * are marked ignored with a reason code and never appear in any history.
 */

import { GitHubPushPayload } from "../../types/github.types";
import { resolveWebhookTarget } from "../resolve-target";
import { enrichPushEvent } from "../../services/enrichment.service";
import { dispatchPushNotification } from "../../notifications/engine";
import { saveCommit } from "../../db/operations/commit.ops";
import {
  markDeliveryProcessed,
  markDeliveryFailed,
  markDeliveryIgnored,
  type DeliveryStamp,
} from "../../db/operations/delivery.ops";
import { branchFromRef, shortSha } from "../../utils/format";
import { logger } from "../../utils/logger";
import type { Deadline } from "../../utils/deadline";

export async function handlePushEvent(
  payload: GitHubPushPayload,
  deliveryId: string,
  installationId: number,
  deadline?: Deadline,
): Promise<void> {
  const repoId = String(payload.repository.id);
  const branch = branchFromRef(payload.ref);

  const resolved = await resolveWebhookTarget(repoId, installationId);
  if (!resolved.ok) {
    logger.info("Push event ignored", { repo: payload.repository.full_name, reason: resolved.reason });
    await markDeliveryIgnored(deliveryId, resolved.reason);
    return;
  }
  const { target } = resolved;

  // Filter by watched branch
  if (branch !== target.repo.watched_branch) {
    logger.debug("Push event ignored — branch not watched", {
      branch,
      watchedBranch: target.repo.watched_branch,
      repo: payload.repository.full_name,
    });
    await markDeliveryIgnored(deliveryId, "branch_not_watched");
    return;
  }

  // Skip delete and tag events
  if (payload.deleted || payload.commits.length === 0) {
    logger.debug("Push event ignored — branch deleted or no commits", { repo: payload.repository.full_name });
    await markDeliveryIgnored(deliveryId, "event_not_supported");
    return;
  }

  const stamp: DeliveryStamp = {
    workspaceId: target.repo.workspace_id,
    summary: {
      repo_full_name: payload.repository.full_name,
      event_type: "push",
      branch,
      commit_count: payload.commits.length,
      head_short_sha: shortSha(payload.after),
    },
  };

  try {
    // Enrich commit data from GitHub API
    const summary = await enrichPushEvent(payload, installationId, deliveryId, deadline);

    // Persist all commits, tagged with the owning workspace
    await Promise.all(
      summary.commits.map((commit) => saveCommit(repoId, deliveryId, branch, commit, target.repo.workspace_id)),
    );

    await dispatchPushNotification(summary, target, deadline);

    await markDeliveryProcessed(deliveryId, stamp);

    logger.info("Push event processed successfully", {
      repo: payload.repository.full_name,
      branch,
      commits: summary.commits.length,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("Push event processing failed", { repo: payload.repository.full_name, error: errorMessage });
    await markDeliveryFailed(deliveryId, errorMessage, stamp);
    throw error; // Re-throw so Lambda returns 500 and GitHub can retry
  }
}
