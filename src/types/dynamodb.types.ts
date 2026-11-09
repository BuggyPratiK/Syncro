/**
 * DynamoDB Item Shape Definitions
 * These define the structure of items stored in the syncro table.
 */

/** Repository Config item — PK=REPO#<id>, SK=CONFIG */
export interface RepoConfigItem {
  PK: string; // REPO#<github_repo_id>
  SK: "CONFIG";
  github_repo_id: string;
  github_full_name: string; // "owner/repo"
  github_url: string;
  discord_webhook_url: string;
  watched_branch: string; // configurable, e.g. "main"
  is_active: boolean;
  GSI1PK: "TYPE#REPO"; // for listing all repos
  created_at: string; // ISO 8601 UTC
  updated_at: string; // ISO 8601 UTC
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
