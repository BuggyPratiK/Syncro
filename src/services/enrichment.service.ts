/**
 * Data Enrichment Service.
 * Orchestrates fetching full commit details from the GitHub API
 * and building a complete PushEventSummary for notification templates.
 */

import { GitHubPushPayload, PushEventSummary } from "../types/github.types";
import { enrichCommits } from "./github.service";
import { branchFromRef, shortSha } from "../utils/format";
import { logger } from "../utils/logger";
import type { Deadline } from "../utils/deadline";

/**
 * Enriches a GitHub push payload with full diff stats from the GitHub API
 * and returns a normalized PushEventSummary.
 */
export async function enrichPushEvent(
  payload: GitHubPushPayload,
  installationId: number,
  deliveryId: string,
  deadline?: Deadline,
): Promise<PushEventSummary> {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const branch = branchFromRef(payload.ref);

  logger.info("Enriching push event", {
    repo: payload.repository.full_name,
    branch,
    commitCount: payload.commits.length,
  });

  // Only enrich the distinct commits (GitHub marks force-pushed non-distinct commits)
  const distinctCommits = payload.commits.filter((c) => c.distinct);
  const enriched = await enrichCommits(installationId, owner, repo, distinctCommits, deadline);

  const totalAdditions = enriched.reduce((sum, c) => sum + c.additions, 0);
  const totalDeletions = enriched.reduce((sum, c) => sum + c.deletions, 0);

  // Deduplicate changed files across all commits
  const allFiles = [...new Set(enriched.flatMap((c) => c.allChangedFiles))];

  return {
    repoId: String(payload.repository.id),
    repoFullName: payload.repository.full_name,
    repoUrl: payload.repository.html_url,
    branch,
    pusherName: payload.pusher.name,
    commits: enriched.map((c) => ({
      ...c,
      shortSha: shortSha(c.id),
    })),
    totalAdditions,
    totalDeletions,
    totalFilesChanged: allFiles.length,
    compareUrl: payload.compare,
    deliveryId,
    // Totals only cover commits whose stats came from the API (see enrichment cap).
    commitsWithStats: enriched.filter((c) => c.statsFromApi !== false).length,
  };
}
