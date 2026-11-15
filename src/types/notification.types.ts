/**
 * Notification Provider Contract
 */

import type { Deadline } from "../utils/deadline";

export type NotificationChannel = "discord" | "telegram" | "slack" | "whatsapp";

export interface PullRequestNotificationDetails {
  action: string;
  number: number;
  title: string;
  body?: string | null;
  url: string;
  authorName: string;
  authorAvatarUrl?: string;
  baseBranch: string;
  headBranch: string;
  merged?: boolean;
  draft?: boolean;
}

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
  pullRequest?: PullRequestNotificationDetails;
  /** Push only: commits whose line stats are included in the totals (when fewer than all). */
  commitsWithStats?: number;
}

export interface NotificationResult {
  success: boolean;
  channel: NotificationChannel;
  messageId?: string;
  error?: string;
  retried?: boolean;
  retryCount?: number;
  statusCode?: number;
}

export interface SendOptions {
  /** Remaining invocation time; each attempt's timeout is sized from it. */
  deadline?: Deadline;
}

export interface NotificationProvider {
  readonly channel: NotificationChannel;
  /**
   * Sends to an explicit target only. There is no global or default target:
   * without a valid target URL nothing is sent.
   */
  send(payload: NotificationPayload, targetUrl: string, options?: SendOptions): Promise<NotificationResult>;
}
