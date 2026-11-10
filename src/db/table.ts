/**
 * DynamoDB table name and key builder functions.
 *
 * All DynamoDB key strings are constructed here.
 * This centralizes the key design and makes it impossible
 * to accidentally produce malformed keys inline.
 */

import { createHash } from "crypto";
import { getEnv } from "../config/env";

export function tableName(): string {
  return getEnv().DYNAMODB_TABLE_NAME;
}

// ─── Key Builders ────────────────────────────────────────────────────────────

export const keys = {
  /** Repository config item */
  repoConfig: (githubRepoId: string | number) => ({
    PK: `REPO#${githubRepoId}`,
    SK: "CONFIG" as const,
  }),

  /** Discord destination item */
  destination: (destinationId: string) => ({
    PK: `DESTINATION#${destinationId}`,
    SK: "CONFIG" as const,
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

  /** Notification log item with deterministic notification ID */
  notification: (githubRepoId: string | number, notificationId: string) => ({
    PK: `REPO#${githubRepoId}`,
    SK: `NOTIF#${notificationId}`,
  }),
};

/**
 * Builds a deterministic, collision-free notification sort key identifier based on:
 * - GitHub delivery ID
 * - Notification provider / channel
 * - Optional destination identifier (e.g. channel ID, webhook ID, or destination hash)
 */
export function buildNotificationId(
  deliveryId: string,
  channel: string,
  destinationId?: string,
): string {
  const sanitizedChannel = channel.toLowerCase().trim();
  return destinationId
    ? `${deliveryId}#${sanitizedChannel}#${destinationId}`
    : `${deliveryId}#${sanitizedChannel}`;
}

/**
 * Extracts a safe destination identifier (e.g. Discord webhook ID or SHA-256 hash).
 * NEVER includes secret webhook tokens.
 */
export function extractDestinationId(targetUrl?: string): string | undefined {
  if (!targetUrl) return undefined;
  const discordMatch = targetUrl.match(/discord(?:app)?\.com\/api\/webhooks\/(\d+)/i);
  if (discordMatch) {
    return discordMatch[1];
  }
  return createHash("sha256").update(targetUrl).digest("hex").slice(0, 10);
}

// ─── GSI Keys ────────────────────────────────────────────────────────────────

export const gsiKeys = {
  /** GSI1PK for listing all repositories */
  allRepos: () => "TYPE#REPO" as const,

  /** GSI1PK for listing all destinations */
  allDestinations: () => "TYPE#DESTINATION" as const,
};
