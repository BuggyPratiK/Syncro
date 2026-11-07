/**
 * Notification Provider Contract
 */

export type NotificationChannel = "discord" | "telegram" | "slack" | "whatsapp";

export interface NotificationPayload {
  type: "push" | "pull_request" | "branch_behind" | "daily_summary";
  repoFullName: string;
  repoUrl: string;
  branch: string;
  pusherName: string;
  commits: Array<{
    sha: string;
    shortSha: string;
    message: string;
    url: string;
    authorName: string;
  }>;
  totalAdditions: number;
  totalDeletions: number;
  totalFilesChanged: number;
  changedFiles: string[];
  compareUrl: string;
  timestamp: string;
}

export interface NotificationResult {
  success: boolean;
  channel: NotificationChannel;
  messageId?: string;
  error?: string;
  retried?: boolean;
}

export interface NotificationProvider {
  readonly channel: NotificationChannel;
  send(payload: NotificationPayload): Promise<NotificationResult>;
}
