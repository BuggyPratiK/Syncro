/**
 * DynamoDB operations for repository config items.
 */

import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../client";
import { tableName, keys } from "../table";
import { RepoConfigItem } from "../../types/dynamodb.types";

/**
 * Fetches repository configuration from DynamoDB.
 * Returns null if the repository is not registered with Syncro.
 */
export async function getRepoConfig(githubRepoId: string | number): Promise<RepoConfigItem | null> {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName(),
      Key: keys.repoConfig(githubRepoId),
    }),
  );

  if (!result.Item) return null;
  return result.Item as RepoConfigItem;
}
