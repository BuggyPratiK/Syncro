/**
 * Repository service — manages repository configuration lookups.
 */

import { getRepoConfig } from "../db/operations/repository.ops";
import { RepoConfigItem } from "../types/dynamodb.types";
import { logger } from "../utils/logger";

/**
 * Looks up repository config from DynamoDB.
 * Returns null if the repo is not registered or is inactive.
 */
export async function findActiveRepo(githubRepoId: string | number): Promise<RepoConfigItem | null> {
  const config = await getRepoConfig(githubRepoId);

  if (!config) {
    logger.debug("Repository not registered with Syncro", { githubRepoId });
    return null;
  }

  if (!config.is_active) {
    logger.debug("Repository is inactive — skipping notification", {
      githubRepoId,
      repoFullName: config.github_full_name,
    });
    return null;
  }

  return config;
}
