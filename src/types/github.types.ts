/**
 * GitHub Webhook Event Types
 * Based on GitHub Webhooks API documentation
 */

export interface GitHubPushPayload {
  ref: string; // e.g. "refs/heads/main"
  before: string; // SHA before push
  after: string; // SHA after push
  repository: GitHubRepository;
  pusher: GitHubPusher;
  sender: GitHubUser;
  commits: GitHubCommit[];
  head_commit: GitHubCommit | null;
  compare: string; // URL to GitHub compare view
  forced: boolean;
  created: boolean;
  deleted: boolean;
}

export interface GitHubRepository {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  default_branch: string;
  owner: GitHubUser;
}

export interface GitHubPusher {
  name: string;
  email: string;
}

export interface GitHubUser {
  login: string;
  id: number;
  avatar_url?: string;
  html_url?: string;
}

export interface GitHubCommit {
  id: string;
  tree_id: string;
  distinct: boolean;
  message: string;
  timestamp: string;
  url: string;
  author: GitHubCommitAuthor;
  committer: GitHubCommitAuthor;
  added: string[];
  removed: string[];
  modified: string[];
}

export interface GitHubCommitAuthor {
  name: string;
  email: string;
  username?: string;
}

/** Enriched commit data fetched from GitHub API */
export interface EnrichedCommit extends GitHubCommit {
  shortSha?: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  allChangedFiles: string[];
}

/** Summary of a push event after enrichment */
export interface PushEventSummary {
  repoId: string;
  repoFullName: string;
  repoUrl: string;
  branch: string;
  pusherName: string;
  commits: EnrichedCommit[];
  totalAdditions: number;
  totalDeletions: number;
  totalFilesChanged: number;
  compareUrl: string;
  deliveryId: string;
}