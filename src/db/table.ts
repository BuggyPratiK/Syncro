/**
 * DynamoDB table name and key builder functions.
 *
 * All DynamoDB key strings are constructed here.
 * This centralizes the key design and makes it impossible
 * to accidentally produce malformed keys inline.
 */

import { getEnv } from "../config/env";

export function tableName(): string {
  return getEnv().DYNAMODB_TABLE_NAME;
}

// ─── Key Builders ────────────────────────────────────────────────────────────

export const keys = {
  /** Repository config item */
  repoConfig: (githubRepoId: string | number) => ({
    PK: `REPO#${githubRepoId}`,
    SK: "CONFIG",
  }),

  /** Delivery dedup item */
  delivery: (deliveryId: string) => ({
    PK: `DELIVERY#${deliveryId}`,
    SK: `DELIVERY#${deliveryId}`,
  }),

  /** Commit record item */
  commit: (githubRepoId: string | number, sha: string) => ({
    PK: `REPO#${githubRepoId}`,
    SK: `COMMIT#${sha}`,
  }),

  /** Notification log item */
  notification: (githubRepoId: string | number, timestamp: string) => ({
    PK: `REPO#${githubRepoId}`,
    SK: `NOTIF#${timestamp}`,
  }),
};

// ─── GSI Keys ────────────────────────────────────────────────────────────────

export const gsiKeys = {
  /** GSI1PK for listing all repositories */
  allRepos: () => "TYPE#REPO",
};
