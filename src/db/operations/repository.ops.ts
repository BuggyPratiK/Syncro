/**
 * DynamoDB operations for repository configuration items.
 */

import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { ddb } from "../client";
import { tableName, keys, gsiKeys } from "../table";
import {
  RepoConfigItem,
  CreateRepoInput,
  UpdateRepoInput,
  PaginationParams,
  PaginatedResult,
} from "../../types/dynamodb.types";
import { getDiscordDestination } from "./destination.ops";
import { validateDiscordWebhookUrl } from "../../utils/url-validator";
import { encodeNextToken, decodeNextToken } from "../../utils/pagination";

const REPO_FULL_NAME_REGEX = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

/**
 * Validates a GitHub repository full name (owner/repo).
 */
export function isValidRepoFullName(fullName: string): boolean {
  return typeof fullName === "string" && REPO_FULL_NAME_REGEX.test(fullName.trim());
}

/**
 * Fetches repository configuration from DynamoDB.
 * Returns null if the repository is not registered with Syncro.
 */
export async function getRepoConfig(
  githubRepoId: string | number,
): Promise<RepoConfigItem | null> {
  if (!githubRepoId) return null;

  const result = await ddb.send(
    new GetCommand({
      TableName: tableName(),
      Key: keys.repoConfig(githubRepoId),
    }),
  );

  if (!result.Item) return null;
  return result.Item as RepoConfigItem;
}

/**
 * Creates a new repository configuration item in DynamoDB.
 * Validates identifiers and destination references before creating.
 * Uses conditional write (attribute_not_exists(PK)) to avoid overwrites.
 */
export async function createRepo(input: CreateRepoInput): Promise<RepoConfigItem> {
  const repoIdStr = String(input.github_repo_id).trim();
  if (!repoIdStr) {
    throw new Error("Repository ID is required");
  }

  const fullName = input.github_full_name.trim();
  if (!isValidRepoFullName(fullName)) {
    throw new Error(`Invalid repository full name '${fullName}'. Expected 'owner/repo'`);
  }

  // Validate destination reference if provided
  if (input.discord_destination_id) {
    const destination = await getDiscordDestination(input.discord_destination_id);
    if (!destination) {
      throw new Error(
        `Referenced Discord destination '${input.discord_destination_id}' does not exist`,
      );
    }
    if (!destination.is_active) {
      throw new Error(
        `Referenced Discord destination '${input.discord_destination_id}' is inactive`,
      );
    }
  }

  // Validate legacy webhook URL if provided
  if (input.discord_webhook_url) {
    const validation = validateDiscordWebhookUrl(input.discord_webhook_url);
    if (!validation.valid || !validation.cleanedUrl) {
      throw new Error(validation.error ?? "Invalid Discord webhook URL");
    }
  }

  const now = new Date().toISOString();
  const item: RepoConfigItem = {
    ...keys.repoConfig(repoIdStr),
    github_repo_id: repoIdStr,
    github_full_name: fullName,
    github_url: input.github_url.trim(),
    ...(input.discord_destination_id
      ? { discord_destination_id: input.discord_destination_id }
      : {}),
    ...(input.discord_webhook_url
      ? { discord_webhook_url: input.discord_webhook_url }
      : {}),
    watched_branch: input.watched_branch?.trim() || "main",
    is_active: true,
    GSI1PK: gsiKeys.allRepos(),
    created_at: now,
    updated_at: now,
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName(),
        Item: item,
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
    return item;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      throw new Error(`Repository with ID '${repoIdStr}' is already registered`);
    }
    throw error;
  }
}

/**
 * Updates mutable fields of an existing repository configuration.
 * Allowlist: github_full_name, github_url, discord_destination_id, watched_branch, is_active.
 * Prevents mutation of immutable keys: PK, SK, github_repo_id, created_at, GSI1PK.
 */
export async function updateRepo(
  githubRepoId: string | number,
  updates: UpdateRepoInput,
): Promise<RepoConfigItem> {
  const repoIdStr = String(githubRepoId).trim();
  if (!repoIdStr) {
    throw new Error("Repository ID is required");
  }

  const updateParts: string[] = [];
  const exprNames: Record<string, string> = {};
  const exprValues: Record<string, unknown> = {};

  if (updates.github_full_name !== undefined) {
    const fullName = updates.github_full_name.trim();
    if (!isValidRepoFullName(fullName)) {
      throw new Error(`Invalid repository full name '${fullName}'. Expected 'owner/repo'`);
    }
    updateParts.push("#fullName = :fullName");
    exprNames["#fullName"] = "github_full_name";
    exprValues[":fullName"] = fullName;
  }

  if (updates.github_url !== undefined) {
    updateParts.push("#url = :url");
    exprNames["#url"] = "github_url";
    exprValues[":url"] = updates.github_url.trim();
  }

  if (updates.discord_destination_id !== undefined) {
    if (updates.discord_destination_id !== "") {
      const destination = await getDiscordDestination(updates.discord_destination_id);
      if (!destination) {
        throw new Error(
          `Referenced Discord destination '${updates.discord_destination_id}' does not exist`,
        );
      }
      if (!destination.is_active) {
        throw new Error(
          `Referenced Discord destination '${updates.discord_destination_id}' is inactive`,
        );
      }
      updateParts.push("#destId = :destId");
      exprNames["#destId"] = "discord_destination_id";
      exprValues[":destId"] = updates.discord_destination_id;
    } else {
      // Removing destination
      updateParts.push("#destId = :nullVal");
      exprNames["#destId"] = "discord_destination_id";
      exprValues[":nullVal"] = null;
    }
  }

  if (updates.watched_branch !== undefined) {
    const branch = updates.watched_branch.trim();
    if (!branch) {
      throw new Error("Watched branch cannot be empty");
    }
    updateParts.push("#branch = :branch");
    exprNames["#branch"] = "watched_branch";
    exprValues[":branch"] = branch;
  }

  if (updates.is_active !== undefined) {
    updateParts.push("#active = :active");
    exprNames["#active"] = "is_active";
    exprValues[":active"] = Boolean(updates.is_active);
  }

  const now = new Date().toISOString();
  updateParts.push("#updatedAt = :now");
  exprNames["#updatedAt"] = "updated_at";
  exprValues[":now"] = now;

  try {
    const result = await ddb.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: keys.repoConfig(repoIdStr),
        UpdateExpression: `SET ${updateParts.join(", ")}`,
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeNames: exprNames,
        ExpressionAttributeValues: exprValues,
        ReturnValues: "ALL_NEW",
      }),
    );

    return result.Attributes as RepoConfigItem;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      throw new Error(`Repository with ID '${repoIdStr}' not found`);
    }
    throw error;
  }
}

/**
 * Soft-deactivates a repository configuration.
 * Preserves historical delivery, commit, and notification records.
 */
export async function deactivateRepo(
  githubRepoId: string | number,
): Promise<RepoConfigItem> {
  return updateRepo(githubRepoId, { is_active: false });
}

/**
 * Lists registered repositories using the type-index GSI.
 * Supports pagination via LastEvaluatedKey / nextToken.
 */
export async function listRepos(
  params?: PaginationParams,
): Promise<PaginatedResult<RepoConfigItem>> {
  const exclusiveStartKey = decodeNextToken(params?.nextToken);
  const limit = params?.limit && params.limit > 0 ? params.limit : undefined;

  const queryInput: QueryCommandInput = {
    TableName: tableName(),
    IndexName: "type-index",
    KeyConditionExpression: "GSI1PK = :gsi1pk",
    ExpressionAttributeValues: {
      ":gsi1pk": gsiKeys.allRepos(),
    },
    ScanIndexForward: false, // Newest first
    ...(limit ? { Limit: limit } : {}),
    ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
  };

  if (params?.activeOnly) {
    queryInput.FilterExpression = "#active = :isActive";
    queryInput.ExpressionAttributeNames = { "#active": "is_active" };
    queryInput.ExpressionAttributeValues = {
      ...queryInput.ExpressionAttributeValues,
      ":isActive": true,
    };
  }

  const result = await ddb.send(new QueryCommand(queryInput));
  const items = (result.Items ?? []) as RepoConfigItem[];

  return {
    items,
    nextToken: encodeNextToken(result.LastEvaluatedKey),
  };
}
