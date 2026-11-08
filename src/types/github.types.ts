/*
 * GitHub Webhook Event Types
 */

export interface GitHubPushPayload {
  ref: string;
  before: string;
  after: string;
  repository: GitHubRepository;
  pusher: GitHubPusher;
  sender: GitHubUser;
  commits: GitHubCommit[];
  head_commit: GitHubCommit | null;
  compare: string;
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

export interface EnrichedCommit extends GitHubCommit {
  shortSha?: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  allChangedFiles: string[];
}

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

export interface GitHubPullRequestBranch {
  label: string;
  ref: string;
  sha: string;
  repo: GitHubRepository | null;
}

export interface GitHubPullRequest {
  id: number;
  number: number;
  state: "open" | "closed";
  title: string;
  body: string | null;
  html_url: string;
  diff_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  merge_commit_sha: string | null;
  merged: boolean;
  draft?: boolean;
  user: GitHubUser;
  head: GitHubPullRequestBranch;
  base: GitHubPullRequestBranch;
  additions: number;
  deletions: number;
  changed_files: number;
  commits: number;
}

export interface GitHubPullRequestPayload {
  action: "opened" | "closed" | "reopened" | "synchronize" | "edited" | string;
  number: number;
  pull_request: GitHubPullRequest;
  repository: GitHubRepository;
  sender: GitHubUser;
  installation?: {
    id: number;
    node_id: string;
  };
}