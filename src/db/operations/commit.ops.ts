/**
 * DynamoDB operations for commit record items.
 */

import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../client";
import { tableName, keys } from "../table";
import { CommitItem } from "../../types/dynamodb.types";
import { EnrichedCommit } from "../../types/github.types";
import { shortSha } from "../../utils/format";

/**
 * Persists an enriched commit record to DynamoDB.
 */
export async function saveCommit(
  githubRepoId: string,
  deliveryId: string,
  branch: string,
  commit: EnrichedCommit,
): Promise<void> {
  const item: CommitItem = {
    ...keys.commit(githubRepoId, commit.id),
    delivery_id: deliveryId,
    sha: commit.id,
    short_sha: shortSha(commit.id),
    message: commit.message,
    author_name: commit.author.name,
    author_email: commit.author.email,
    branch,
    additions: commit.additions,
    deletions: commit.deletions,
    files_changed: commit.changedFiles,
    changed_files: commit.allChangedFiles,
    github_url: commit.url,
    committed_at: commit.timestamp,
  };

  await ddb.send(new PutCommand({ TableName: tableName(), Item: item }));
}
