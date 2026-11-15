/**
 * DynamoDB table name and key builder functions.
 *
 * All DynamoDB key strings are constructed here.
 * This centralizes the key design and makes it impossible
 * to accidentally produce malformed keys inline.
 */

import { getBaseEnv } from "../config/env";
import { assertId } from "../contracts/ids";
import { RATE_LIMIT_BUCKETS, type RateLimitBucket } from "../contracts/constants";

export function tableName(): string {
  return getBaseEnv().DYNAMODB_TABLE_NAME;
}

// ─── Key Builders ────────────────────────────────────────────────────────────

export const keys = {
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

// ─── Tenant Keys ─────────────────────────────────────────────────────────────
//
// Every builder validates its identifiers (src/contracts/ids.ts) and throws
// `InvalidIdentifierError` otherwise, so client-influenced values can never
// inject `#` or other key structure.

/** Sort-key prefix of tenant destinations in the workspace partition. */
export const DEST_SK_PREFIX = "DEST#" as const;

export const tenantKeys = {
  /** `USER#<uid>` / `PROFILE` — bootstrap lock. */
  userProfile: (userId: string) => ({
    PK: `USER#${assertId("userId", userId)}`,
    SK: "PROFILE" as const,
  }),

  /** `USER#<uid>` / `MEMBERSHIP#<ws>`. */
  userMembership: (userId: string, workspaceId: string) => ({
    PK: `USER#${assertId("userId", userId)}`,
    SK: `MEMBERSHIP#${assertId("workspaceId", workspaceId)}`,
  }),

  /** `WS#<ws>` / `META`. */
  workspace: (workspaceId: string) => ({
    PK: `WS#${assertId("workspaceId", workspaceId)}`,
    SK: "META" as const,
  }),

  /** `WS#<ws>` / `MEMBER#<uid>` — authoritative membership. */
  workspaceMember: (workspaceId: string, userId: string) => ({
    PK: `WS#${assertId("workspaceId", workspaceId)}`,
    SK: `MEMBER#${assertId("userId", userId)}`,
  }),

  /** `WS#<ws>` / `DEST#<uuid>`. */
  destination: (workspaceId: string, destinationId: string) => ({
    PK: `WS#${assertId("workspaceId", workspaceId)}`,
    SK: `${DEST_SK_PREFIX}${assertId("destinationId", destinationId)}`,
  }),

  /** `GHUSER#<github_user_id>` / `LINK`: links one GitHub account to one workspace. */
  githubUserLink: (githubUserId: string | number) => ({
    PK: `GHUSER#${assertId("githubId", githubUserId)}`,
    SK: "LINK" as const,
  }),

  /** `INSTALLATION#<id>` / `META`. */
  installation: (installationId: string | number) => ({
    PK: `INSTALLATION#${assertId("githubId", installationId)}`,
    SK: "META" as const,
  }),

  /** `REPO#<id>` / `CONFIG` (same key as the legacy item; tenant items carry `workspace_id`). */
  repo: (githubRepoId: string | number) => ({
    PK: `REPO#${assertId("githubId", githubRepoId)}`,
    SK: "CONFIG" as const,
  }),

  /** `GHSTATE#<nonce>` / `META` (single use, TTL 10 min). */
  githubState: (nonce: string) => ({
    PK: `GHSTATE#${assertId("stateNonce", nonce)}`,
    SK: "META" as const,
  }),

  /** `GHLISTING#<listingId>` / `META` (TTL 15 min). */
  githubListing: (listingId: string) => ({
    PK: `GHLISTING#${assertId("listingId", listingId)}`,
    SK: "META" as const,
  }),

  /** `SYSTEM#COUNTERS` / `SSM_DEST_PARAMS`: service-wide destination-parameter count. */
  ssmDestParamCounter: () => ({
    PK: "SYSTEM#COUNTERS" as const,
    SK: "SSM_DEST_PARAMS" as const,
  }),

  /** `SYSTEM#CONFIG` / `SIGNUP`. */
  signupConfig: () => ({
    PK: "SYSTEM#CONFIG" as const,
    SK: "SIGNUP" as const,
  }),

  /** `SYSTEM#SIGNUPS` / `DAY#<yyyy-mm-dd>`: new workspaces per UTC day. */
  signupDay: (utcDay: string) => ({
    PK: "SYSTEM#SIGNUPS" as const,
    SK: `DAY#${assertId("utcDay", utcDay)}`,
  }),

  /** `RATE#<uid>` / `<bucket>#<window>`, window = floor(epochSeconds / 60). */
  rateLimit: (userId: string, bucket: RateLimitBucket, window: number) => {
    if (!RATE_LIMIT_BUCKETS.includes(bucket)) throw new Error("Invalid rate-limit bucket");
    if (!Number.isSafeInteger(window) || window < 0) throw new Error("Invalid rate-limit window");
    return {
      PK: `RATE#${assertId("userId", userId)}`,
      SK: `${bucket}#${window}`,
    };
  },
};

/** Workspace-scoped `type-index` partitions (no new GSI). */
export const tenantGsiKeys = {
  repos: (workspaceId: string) => `WS#${assertId("workspaceId", workspaceId)}#REPO`,
  installations: (workspaceId: string) => `WS#${assertId("workspaceId", workspaceId)}#INSTALLATION`,
  deliveries: (workspaceId: string) => `WS#${assertId("workspaceId", workspaceId)}#DELIVERY`,
};

/** UTC calendar day (`yyyy-mm-dd`) for the daily signup counter. */
export function utcDayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}
