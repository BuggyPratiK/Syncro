/**
 * DynamoDB Item Shape Definitions
 * These define the structure of items stored in the syncro table.
 */

export type NotificationProviderChannel = "discord" | "telegram" | "slack";

/** Discord Destination item — PK=DESTINATION#<destination_id>, SK=CONFIG */
export interface DiscordDestinationItem {
  PK: string; // DESTINATION#<destination_id>
  SK: "CONFIG";
  destination_id: string; // Unique destination identifier (UUID)
  provider: "discord";
  display_name: string; // User-facing label (e.g. "Dev Alerts Channel")
  discord_webhook_url: string; // Secret incoming webhook URL (backend only)
  is_active: boolean;
  GSI1PK: "TYPE#DESTINATION"; // For listing all destinations via type-index
  created_at: string; // ISO 8601 UTC
  updated_at: string; // ISO 8601 UTC
}

/** Non-sensitive Destination DTO for API/dashboard responses */
export interface SafeDiscordDestinationDto {
  destination_id: string;
  provider: "discord";
  display_name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  webhook_url_masked: string;
}

/** Repository Config item — PK=REPO#<id>, SK=CONFIG */
export interface RepoConfigItem {
  PK: string; // REPO#<github_repo_id>
  SK: "CONFIG";
  github_repo_id: string;
  github_full_name: string; // "owner/repo"
  github_url: string;
  discord_destination_id?: string; // Foreign key referencing DiscordDestinationItem.destination_id
  discord_webhook_url?: string; // Legacy/transitional field maintained for backward compatibility
  watched_branch: string; // configurable, e.g. "main"
  is_active: boolean;
  GSI1PK: "TYPE#REPO"; // for listing all repos via type-index
  created_at: string; // ISO 8601 UTC
  updated_at: string; // ISO 8601 UTC
}

/** Non-sensitive Repository Config DTO for API/dashboard responses */
export interface SafeRepoConfigDto {
  github_repo_id: string;
  github_full_name: string;
  github_url: string;
  discord_destination_id?: string;
  watched_branch: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type DeliveryStatus = "processing" | "processed" | "failed" | "ignored";

/** Delivery dedup item — PK=DELIVERY#<id>, SK=DELIVERY#<id> */
export interface DeliveryItem {
  PK: string; // DELIVERY#<X-GitHub-Delivery>
  SK: string; // DELIVERY#<X-GitHub-Delivery>
  github_repo_id: string;
  event_type: string; // "push" | "pull_request" | string
  status: DeliveryStatus;
  received_at: string; // ISO 8601 UTC
  processed_at?: string; // ISO 8601 UTC
  error_message?: string;
  lease_expires_at?: number; // Unix epoch ms — allows safe recovery of interrupted executions
  attempt_count?: number; // Total number of processing attempts
  last_attempt_at?: string; // ISO 8601 UTC
  ttl: number; // Unix epoch — auto-deleted after 30 days
}

/** Commit record item — PK=REPO#<id>, SK=COMMIT#<sha> */
export interface CommitItem {
  PK: string; // REPO#<github_repo_id>
  SK: string; // COMMIT#<sha>
  delivery_id: string;
  sha: string;
  short_sha: string; // first 7 chars
  message: string;
  author_name: string;
  author_email: string;
  branch: string;
  additions: number;
  deletions: number;
  files_changed: number;
  changed_files: string[];
  github_url: string;
  committed_at: string; // ISO 8601 UTC
}

/** Notification log item — PK=REPO#<id>, SK=NOTIF#<delivery_id>#<channel>[#<dest_id>] */
export interface NotificationItem {
  PK: string; // REPO#<github_repo_id>
  SK: string; // NOTIF#<delivery_id>#<channel>[#<dest_id>]
  delivery_id: string;
  channel: string; // "discord" | "telegram" | "slack"
  destination_id?: string; // safe non-secret target identifier (e.g. webhook ID or sha256 slice)
  status: "pending" | "sent" | "failed";
  retry_count: number;
  message_id?: string; // returned by Discord/Telegram if available
  created_at: string; // ISO 8601 UTC — initial record creation
  sent_at?: string; // ISO 8601 UTC — when delivery succeeded
  failed_at?: string; // ISO 8601 UTC — when delivery failed
  error_message?: string;
  updated_at?: string; // ISO 8601 UTC — last update or retry
}

// ─── Input Types for Operations ──────────────────────────────────────────────

export interface CreateDestinationInput {
  destination_id?: string;
  display_name: string;
  discord_webhook_url: string;
}

export interface UpdateDestinationInput {
  display_name?: string;
  discord_webhook_url?: string;
  is_active?: boolean;
}

export interface CreateRepoInput {
  github_repo_id: string | number;
  github_full_name: string;
  github_url: string;
  discord_destination_id?: string;
  discord_webhook_url?: string;
  watched_branch?: string;
}

export interface UpdateRepoInput {
  github_full_name?: string;
  github_url?: string;
  discord_destination_id?: string;
  watched_branch?: string;
  is_active?: boolean;
}

export interface PaginationParams {
  limit?: number;
  nextToken?: string;
  activeOnly?: boolean;
}

export interface PaginatedResult<T> {
  items: T[];
  nextToken?: string;
}
