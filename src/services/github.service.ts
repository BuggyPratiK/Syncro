/**
 * GitHub API service wrapper using Octokit.
 * Handles GitHub App authentication and commit data enrichment.
 */

import { App } from "@octokit/app";
import { getEnv } from "../config/env";
import { EnrichedCommit, GitHubCommit } from "../types/github.types";
import { logger } from "../utils/logger";

let _app: App | undefined;

function getApp(): App {
  if (!_app) {
    const env = getEnv();
    _app = new App({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
    });
  }
  return _app;
}

/**
 * Fetches detailed commit data (additions, deletions, changed files)
 * for each commit in a push event. The webhook payload alone does not
 * include line-level diff stats - we need the API for that.
 */
export async function enrichCommits(
  installationId: number,
  owner: string,
  repo: string,
  commits: GitHubCommit[],
): Promise<EnrichedCommit[]> {
  const app = getApp();
  const octokit = await app.getInstallationOctokit(installationId);

  // Enrich commits sequentially to avoid API rate-limit bursts
  // For typical push events (1-5 commits), sequential is fine
  const enriched: EnrichedCommit[] = [];

  for (const commit of commits) {
    try {
      const response = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
        owner,
        repo,
        ref: commit.id,
      });

      const data = response.data;
      const allChangedFiles: string[] = (data.files ?? [])
        .map((f: { filename?: string }) => f.filename)
        .filter((name): name is string => typeof name === "string");

      enriched.push({
        ...commit,
        additions: data.stats?.additions ?? 0,
        deletions: data.stats?.deletions ?? 0,
        changedFiles: data.files?.length ?? 0,
        allChangedFiles,
      });
    } catch (error) {
      logger.warn("Failed to enrich commit - using webhook data only", {
        sha: commit.id,
        error: error instanceof Error ? error.message : String(error),
      });

      // Fall back gracefully using data available from the webhook payload
      enriched.push({
        ...commit,
        additions: 0,
        deletions: 0,
        changedFiles: [...commit.added, ...commit.removed, ...commit.modified].length,
        allChangedFiles: [...commit.added, ...commit.removed, ...commit.modified],
      });
    }
  }

  return enriched;
}
