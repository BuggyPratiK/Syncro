/**
 * Repository service — manages repository configuration lookups, CRUD operations,
 * safe DTO projections, and destination relations.
 */

import {
  getRepoConfig,
  createRepo,
  updateRepo,
  deactivateRepo,
  listRepos,
} from "../db/operations/repository.ops";
import {
  RepoConfigItem,
  SafeRepoConfigDto,
  CreateRepoInput,
  UpdateRepoInput,
  PaginationParams,
  PaginatedResult,
} from "../types/dynamodb.types";
import { logger } from "../utils/logger";

/**
 * Projects a raw DynamoDB RepoConfigItem into a SafeRepoConfigDto.
 * Secret webhook URLs are never present in this DTO.
 */
export function toSafeRepoDto(item: RepoConfigItem): SafeRepoConfigDto {
  return {
    github_repo_id: item.github_repo_id,
    github_full_name: item.github_full_name,
    github_url: item.github_url,
    discord_destination_id: item.discord_destination_id,
    watched_branch: item.watched_branch,
    is_active: item.is_active,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

/**
 * Looks up repository config from DynamoDB.
 * Returns null if the repo is not registered or is inactive.
 */
export async function findActiveRepo(
  githubRepoId: string | number,
): Promise<RepoConfigItem | null> {
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

/**
 * Creates a new repository registration and returns a safe DTO.
 */
export async function createRepoService(
  input: CreateRepoInput,
): Promise<SafeRepoConfigDto> {
  const item = await createRepo(input);
  logger.info("Registered repository", {
    repoId: item.github_repo_id,
    fullName: item.github_full_name,
    destinationId: item.discord_destination_id,
  });
  return toSafeRepoDto(item);
}

/**
 * Retrieves repository configuration as a safe DTO.
 */
export async function getRepoConfigService(
  githubRepoId: string | number,
): Promise<SafeRepoConfigDto | null> {
  const item = await getRepoConfig(githubRepoId);
  if (!item) return null;
  return toSafeRepoDto(item);
}

/**
 * Lists repositories returning safe DTOs and pagination token.
 */
export async function listReposService(
  params?: PaginationParams,
): Promise<PaginatedResult<SafeRepoConfigDto>> {
  const result = await listRepos(params);
  return {
    items: result.items.map(toSafeRepoDto),
    nextToken: result.nextToken,
  };
}

/**
 * Updates repository configuration and returns updated safe DTO.
 */
export async function updateRepoService(
  githubRepoId: string | number,
  updates: UpdateRepoInput,
): Promise<SafeRepoConfigDto> {
  const item = await updateRepo(githubRepoId, updates);
  logger.info("Updated repository configuration", {
    repoId: item.github_repo_id,
    fullName: item.github_full_name,
    isActive: item.is_active,
  });
  return toSafeRepoDto(item);
}

/**
 * Soft-deactivates a repository.
 */
export async function deactivateRepoService(
  githubRepoId: string | number,
): Promise<SafeRepoConfigDto> {
  const item = await deactivateRepo(githubRepoId);
  logger.warn("Deactivated repository", {
    repoId: item.github_repo_id,
    fullName: item.github_full_name,
  });
  return toSafeRepoDto(item);
}

/**
 * Finds all repositories currently referencing a given destination ID.
 * Used for dependency checks during destination management.
 */
export async function getRepositoriesForDestination(
  destinationId: string,
): Promise<RepoConfigItem[]> {
  const result = await listRepos();
  return result.items.filter((r) => r.discord_destination_id === destinationId);
}
