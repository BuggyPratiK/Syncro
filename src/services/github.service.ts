/**
 * GitHub API service wrapper using Octokit.
 * Handles GitHub App authentication and commit data enrichment.
 *
 * Enrichment is best effort and must never hold up a notification:
 * - at most `RELAY.enrichmentCap` commits are fetched from the API per delivery;
 * - every request has a timeout, sized so enough time is left for the Discord send;
 * - on timeout, error or exhausted budget, the commit falls back to the data
 *   already present in the webhook payload.
 */

import { App } from "@octokit/app";
import { getWebhookEnv } from "../config/env";
import { getSenderSecrets } from "../config/secrets";
import { RELAY } from "../contracts/constants";
import { EnrichedCommit, GitHubCommit } from "../types/github.types";
import { attemptTimeoutMs, type Deadline } from "../utils/deadline";
import { logger } from "../utils/logger";

/**
 * Time kept free for the notification send after enrichment: one full Discord
 * attempt plus the end-of-invocation safety reserve.
 */
const ENRICHMENT_RESERVE_MS = RELAY.discordAttemptTimeoutMs + RELAY.deadlineSafetyReserveMs;

let _app: Promise<App> | undefined;

/** The GitHub App client, created once per container with the key from SSM. */
function getApp(): Promise<App> {
  if (!_app) {
    _app = (async () => {
      const { githubAppPrivateKey } = await getSenderSecrets();
      return new App({ appId: getWebhookEnv().GITHUB_APP_ID, privateKey: githubAppPrivateKey });
    })().catch((error) => {
      _app = undefined; // retry on the next delivery
      throw error;
    });
  }
  return _app;
}

class EnrichmentTimeoutError extends Error {
  constructor() {
    super("GitHub request timed out");
    this.name = "EnrichmentTimeoutError";
  }
}

/** Rejects if `promise` does not settle within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new EnrichmentTimeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Commit built only from the webhook payload (no line-level stats). */
function fromWebhookData(commit: GitHubCommit): EnrichedCommit {
  const files = [...commit.added, ...commit.removed, ...commit.modified];
  return {
    ...commit,
    additions: 0,
    deletions: 0,
    changedFiles: files.length,
    allChangedFiles: files,
    statsFromApi: false,
  };
}

/**
 * Fetches detailed commit data (additions, deletions, changed files)
 * for the commits in a push event. The webhook payload alone does not
 * include line-level diff stats - we need the API for that.
 *
 * Always returns one entry per input commit, in order.
 */
export async function enrichCommits(
  installationId: number,
  owner: string,
  repo: string,
  commits: GitHubCommit[],
  deadline?: Deadline,
): Promise<EnrichedCommit[]> {
  const toEnrich = commits.slice(0, RELAY.enrichmentCap);
  const rest = commits.slice(RELAY.enrichmentCap).map(fromWebhookData);

  if (toEnrich.length === 0) return rest;

  type InstallationOctokit = Awaited<ReturnType<App["getInstallationOctokit"]>>;
  let octokit: InstallationOctokit;
  try {
    const timeoutMs = attemptTimeoutMs(deadline, RELAY.githubRequestTimeoutMs, ENRICHMENT_RESERVE_MS);
    if (timeoutMs === 0) throw new EnrichmentTimeoutError();
    const app = await getApp();
    octokit = await withTimeout(app.getInstallationOctokit(installationId), timeoutMs);
  } catch (error) {
    logger.warn("GitHub enrichment unavailable - using webhook data only", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [...toEnrich.map(fromWebhookData), ...rest];
  }

  // Sequential to avoid API rate-limit bursts; bounded by the cap above.
  const enriched: EnrichedCommit[] = [];
  for (const commit of toEnrich) {
    const timeoutMs = attemptTimeoutMs(deadline, RELAY.githubRequestTimeoutMs, ENRICHMENT_RESERVE_MS);
    if (timeoutMs === 0) {
      enriched.push(fromWebhookData(commit));
      continue;
    }
    try {
      const response = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
        owner,
        repo,
        ref: commit.id,
        request: { signal: AbortSignal.timeout(timeoutMs) },
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
        statsFromApi: true,
      });
    } catch (error) {
      logger.warn("Failed to enrich commit - using webhook data only", {
        sha: commit.id,
        error: error instanceof Error ? error.message : String(error),
      });
      enriched.push(fromWebhookData(commit));
    }
  }

  return [...enriched, ...rest];
}
