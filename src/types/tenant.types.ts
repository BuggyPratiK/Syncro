/**
 * DynamoDB item shapes for multi-tenant (workspace) data.
 * Everything lives in the single `syncro` table; keys are built only by
 * `src/db/table.ts`.
 *
 * Invariants:
 * - No Discord webhook URL (or its ciphertext) is stored in DynamoDB.
 *   Destinations keep only `secret_ref {name, version}` pointing at an SSM
 *   SecureString parameter.
 * - No GitHub token is stored anywhere.
 * - No new index: workspace listings reuse `type-index` (`GSI1PK` + `created_at`).
 */

import type { Role } from "../contracts/roles";
import type { SignupMode, RateLimitBucket } from "../contracts/constants";

// ─── Identity and workspace ──────────────────────────────────────────────────

/**
 * `USER#<uid>` / `PROFILE`. Created once per user; its conditional creation
 * acts as a lock so concurrent signups produce exactly one workspace.
 * `uid = "logto:" + sub`.
 */
export interface UserProfileItem {
  PK: string;
  SK: "PROFILE";
  user_id: string;
  idp_iss: string;
  bootstrap_workspace_id: string;
  status: "active" | "suspended";
  created_at: string;
}

/**
 * `WS#<ws>` / `META`. Counters are absent until first used; writes check them
 * with `attribute_not_exists(x) OR x < :limit`.
 */
export interface WorkspaceItem {
  PK: string;
  SK: "META";
  workspace_id: string;
  created_by: string;
  status: "active" | "suspended";
  /** The single GitHub account linked to this workspace; set by the first claim and never changed. */
  github_user_id?: string;
  installation_count?: number;
  active_repo_count?: number;
  active_destination_count?: number;
  created_at: string;
}

/** `WS#<ws>` / `MEMBER#<uid>`: the authoritative membership record. */
export interface WorkspaceMemberItem {
  PK: string;
  SK: string;
  workspace_id: string;
  user_id: string;
  role: Role;
  status: "active" | "removed";
  joined_at: string;
}

/** `USER#<uid>` / `MEMBERSHIP#<ws>`: the user-side copy, for listing a user's workspaces. */
export interface UserMembershipItem {
  PK: string;
  SK: string;
  workspace_id: string;
  user_id: string;
  role: Role;
  status: "active" | "removed";
  joined_at: string;
}

// ─── GitHub ──────────────────────────────────────────────────────────────────

/**
 * `GHUSER#<github_user_id>` / `LINK`. Created conditionally, so one GitHub
 * account can be linked to only one workspace.
 */
export interface GitHubUserLinkItem {
  PK: string;
  SK: "LINK";
  github_user_id: string;
  workspace_id: string;
  created_at: string;
}

/** `INSTALLATION#<id>` / `META`; listed per workspace via `GSI1PK = WS#<ws>#INSTALLATION`. */
export interface InstallationItem {
  PK: string;
  SK: "META";
  installation_id: string;
  workspace_id: string;
  account_id: string;
  account_login: string;
  account_type: "User" | "Organization";
  claimed_by_github_user_id: string;
  /** The Syncro user who performed the claim. */
  claimed_by: string;
  verified_via: "user_oauth";
  verified_at: string;
  status: "active" | "deleted";
  GSI1PK: string;
  created_at: string;
  updated_at: string;
}

/**
 * `GHSTATE#<nonce>` / `META`: single-use OAuth state. `ttl` (epoch seconds) is
 * creation + 10 minutes and is checked explicitly on use, because DynamoDB
 * removes expired items only eventually.
 */
export interface GitHubStateItem {
  PK: string;
  SK: "META";
  user_id: string;
  workspace_id: string;
  purpose: "install" | "authorize";
  ttl: number;
}

/**
 * `GHLISTING#<listingId>` / `META`: snapshot of the repositories GitHub
 * listed for a user, used to register repositories. No token is stored.
 */
export interface GitHubListingItem {
  PK: string;
  SK: "META";
  listing_id: string;
  workspace_id: string;
  installation_id: string;
  github_user_id: string;
  repos: Array<{ id: string; full_name: string; admin: boolean }>;
  verified_at: string;
  /** Epoch seconds = verified + 15 minutes; checked explicitly on use. */
  ttl: number;
}

// ─── Repositories and destinations ───────────────────────────────────────────

/**
 * `REPO#<id>` / `CONFIG` for a repository owned by a workspace. A repository
 * record without `workspace_id` belongs to no workspace and its webhooks are
 * ignored. It never stores a webhook URL. `discord_destination_id` is either
 * present or removed, never null.
 */
export interface TenantRepoConfigItem {
  PK: string;
  SK: "CONFIG";
  github_repo_id: string;
  github_full_name: string;
  github_url: string;
  workspace_id: string;
  installation_id: string;
  discord_destination_id?: string;
  watched_branch: string;
  is_active: boolean;
  ownership_verified_at: string;
  GSI1PK: string;
  created_at: string;
  updated_at: string;
}

/** Points at the SSM parameter that holds a webhook URL. Never returned by the API. */
export interface SecretRefAttribute {
  name: string;
  version: number;
}

/** `WS#<ws>` / `DEST#<uuid>`. Listed by querying the workspace partition (no index entry). */
export interface TenantDestinationItem {
  PK: string;
  SK: string;
  destination_id: string;
  workspace_id: string;
  provider: "discord";
  display_name: string;
  /** `pending_secret`: the URL is not stored yet; such a destination never receives notifications. */
  status: "pending_secret" | "active" | "inactive";
  /** Absent while `pending_secret`. */
  secret_ref?: SecretRefAttribute;
  /** Non-secret Discord webhook ID, used to show a masked URL. */
  webhook_id: string;
  created_at: string;
  updated_at: string;
}

// ─── System items ────────────────────────────────────────────────────────────

/** `SYSTEM#COUNTERS` / `SSM_DEST_PARAMS`: number of destination parameters across all workspaces. */
export interface SsmDestParamCounterItem {
  PK: "SYSTEM#COUNTERS";
  SK: "SSM_DEST_PARAMS";
  count: number;
}

/** `SYSTEM#CONFIG` / `SIGNUP`: the operator's signup switch. */
export interface SignupConfigItem {
  PK: "SYSTEM#CONFIG";
  SK: "SIGNUP";
  mode: SignupMode;
  /** User IDs allowed to sign up while in `prelaunch` mode. */
  prelaunch_allow: string[];
  daily_cap: number;
  updated_at: string;
}

/** `SYSTEM#SIGNUPS` / `DAY#<yyyy-mm-dd>`: new workspaces created on a UTC day. */
export interface SignupDayCounterItem {
  PK: "SYSTEM#SIGNUPS";
  SK: string;
  count: number;
  ttl: number;
}

/** `RATE#<uid>` / `<bucket>#<floor(epochSeconds/60)>`: one fixed-window counter. */
export interface RateLimitCounterItem {
  PK: string;
  SK: string;
  bucket: RateLimitBucket;
  count: number;
  ttl: number;
}

// ─── Delivery history ────────────────────────────────────────────────────────

/**
 * Short, non-sensitive summary stored on a delivery when it is recorded in a
 * workspace's history. Optional fields are omitted when not applicable.
 */
export interface DeliverySummaryAttribute {
  repo_full_name: string;
  event_type: string;
  branch?: string;
  action?: string;
  commit_count?: number;
  head_short_sha?: string;
  pr_number?: number;
}
