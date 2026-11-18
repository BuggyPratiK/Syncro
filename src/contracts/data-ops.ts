/**
 * Data-operation interfaces shared by the backend and the dashboard API.
 * Type-only: there is no runtime code in this file.
 *
 * Conventions:
 * - Expected refusals are thrown as `ContractError(code)` (see ./errors);
 *   anything else is an internal error.
 * - Reading a resource that belongs to another workspace behaves exactly like
 *   "not found", so one tenant can never learn about another tenant's data.
 */

import type { DeliveryDto, InstallationAccountType, MeDto, Page } from "./dto";
import type { RateLimitBucket } from "./constants";
import type { GitHubStateRejectReason } from "./errors";
import type { Role } from "./roles";

// ─── Branded types ───────────────────────────────────────────────────────────
// A brand is a compile-time marker: these values can only be produced by the
// one function allowed to create them (which performs the required check), so
// code cannot pass an unchecked object where a verified one is required.

declare const workspaceContextBrand: unique symbol;
declare const verifiedInstallationBrand: unique symbol;
declare const verifiedListingBrand: unique symbol;
declare const verifiedRepoAssociationBrand: unique symbol;

/**
 * Proof that `userId` is an active member of the active workspace
 * `workspaceId`, established with a strongly consistent read. Only
 * `resolveWorkspaceContext` creates it, and every workspace-scoped operation
 * requires it.
 */
export type WorkspaceContext = {
  readonly userId: string;
  readonly workspaceId: string;
  readonly role: Role;
  readonly [workspaceContextBrand]: true;
};

/**
 * Proof that a GitHub user owns (personal account) or administers
 * (organization) an installation of the Syncro GitHub App. Produced only by
 * the GitHub verification functions, using a fresh user token. Values from the
 * OAuth callback or the browser are never accepted as proof.
 */
export type VerifiedInstallation = {
  readonly installationId: string;
  readonly githubUserId: string;
  readonly accountId: string;
  readonly accountLogin: string;
  readonly accountType: InstallationAccountType;
  /** `personal_owner`: the installation account is the user; `org_admin`: active org admin. */
  readonly proof: "personal_owner" | "org_admin";
  readonly verifiedVia: "user_oauth";
  /** ISO 8601. Results older than 15 minutes are rejected. */
  readonly verifiedAt: string;
  readonly [verifiedInstallationBrand]: true;
};

/** Repositories GitHub listed for an installation and user; input to `saveVerifiedListing`. */
export type VerifiedRepositoryListing = {
  readonly installationId: string;
  readonly githubUserId: string;
  readonly repos: ReadonlyArray<{ repoId: string; fullName: string; admin: boolean }>;
  readonly verifiedAt: string;
  readonly [verifiedListingBrand]: true;
};

/**
 * Proof that a repository appears, with admin rights, in an unexpired listing
 * owned by the workspace. Produced only inside `registerRepo`.
 */
export type VerifiedRepoAssociation = {
  readonly installationId: string;
  readonly repoId: string;
  readonly fullName: string;
  readonly listingId: string;
  readonly verifiedVia: "user_oauth";
  readonly verifiedAt: string;
  readonly [verifiedRepoAssociationBrand]: true;
};

export interface PageRequest {
  limit: number;
  cursor?: string;
}

// ─── Workspace context and signup ────────────────────────────────────────────

export interface BootstrapResult {
  created: boolean;
  workspaceId: string;
}

export interface TenancyOps {
  /** Reads the membership and the workspace consistently; anything not active → `null`. */
  resolveWorkspaceContext(userId: string, workspaceId: string): Promise<WorkspaceContext | null>;
  /**
   * Creates the user's profile and first workspace (self-service signup).
   * Idempotent: an existing profile is returned whatever the signup mode.
   * Refusals: `signup_paused`, `signup_not_open`, `profile_suspended`,
   * `bootstrap_contention`. Nothing is written when a request is refused.
   */
  bootstrapUser(userId: string, idpIssuer: string): Promise<BootstrapResult>;
  /**
   * Profile and active workspaces of the signed-in user, for `GET /api/me`.
   * Read-only: never creates a profile or workspace.
   */
  getMe(userId: string): Promise<MeDto>;
}

// ─── Per-user rate limiting ──────────────────────────────────────────────────

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the current window ends (0 when allowed). */
  retryAfterSeconds: number;
}

export interface RateLimitOps {
  /** Throws if the counter store fails; the caller then rejects the request with 503. */
  consumeRateLimit(userId: string, bucket: RateLimitBucket, nowMs?: number): Promise<RateLimitDecision>;
}

// ─── OAuth state (single use) ────────────────────────────────────────────────
// Protects the GitHub OAuth flow against CSRF and replay: each redirect to
// GitHub carries a random `state` bound to the user, workspace and purpose,
// and the callback is accepted only if that state can be consumed exactly once.

export type GitHubStatePurpose = "install" | "authorize";

export interface CreatedGitHubState {
  /** The nonce; placed only in the GitHub URL's `state` parameter. */
  state: string;
  /** ISO 8601: creation + 10 minutes (also the item's `ttl`). */
  expiresAt: string;
}

export type ConsumeGitHubStateResult =
  | { ok: true; purpose: GitHubStatePurpose }
  | { ok: false; reason: GitHubStateRejectReason };

export interface GitHubStateOps {
  /** Stores `GHSTATE#<nonce>` with the caller's user, workspace and purpose, expiring in 10 minutes. */
  createGitHubState(ctx: WorkspaceContext, purpose: GitHubStatePurpose, nowMs?: number): Promise<CreatedGitHubState>;
  /**
   * Validates and consumes a state in ONE conditional delete. It succeeds only
   * if the item exists, has not expired (`ttl` is checked explicitly because
   * DynamoDB deletes expired items lazily), and matches the caller's user,
   * workspace and the expected purpose. Of two concurrent calls, exactly one
   * can succeed. A caller whose binding does not match leaves the owner's
   * state untouched.
   *
   * Must run BEFORE exchanging the OAuth code; on `ok: false` the caller
   * answers `state_invalid` and does not contact GitHub.
   */
  consumeGitHubState(
    ctx: WorkspaceContext,
    state: string | undefined,
    expectedPurpose: GitHubStatePurpose,
    nowMs?: number,
  ): Promise<ConsumeGitHubStateResult>;
}

// ─── Installations ───────────────────────────────────────────────────────────

export interface InstallationRecord {
  installationId: string;
  workspaceId: string;
  accountId: string;
  accountLogin: string;
  accountType: InstallationAccountType;
  claimedByGithubUserId: string;
  status: "active" | "deleted";
  verifiedAt: string;
  createdAt: string;
}

export interface ClaimInstallationResult {
  /** `false` when the workspace already owned the installation (nothing changed). */
  created: boolean;
  installation: InstallationRecord;
}

export interface InstallationOps {
  /**
   * Claims a verified installation for the workspace in one DynamoDB
   * transaction that also enforces: one GitHub account per workspace, one
   * workspace per GitHub account, one workspace per installation, and the
   * per-workspace installation limit. Re-claiming an installation the
   * workspace already owns changes nothing.
   *
   * Refusals: `installation_claimed`, `github_identity_mismatch`,
   * `github_identity_in_use`, `installation_limit_reached`,
   * `not_installation_owner` (verification too old).
   */
  claimInstallation(ctx: WorkspaceContext, verified: VerifiedInstallation): Promise<ClaimInstallationResult>;
  getInstallation(ctx: WorkspaceContext, installationId: string): Promise<InstallationRecord | null>;
  listInstallations(ctx: WorkspaceContext, page: PageRequest): Promise<Page<InstallationRecord>>;
}

// ─── Repository listings and repositories ────────────────────────────────────

export interface ListingSnapshot {
  listingId: string;
  installationId: string;
  githubUserId: string;
  repos: ReadonlyArray<{ repoId: string; fullName: string; admin: boolean }>;
  verifiedAt: string;
  expiresAt: string;
}

export interface RepoRecord {
  repoId: string;
  fullName: string;
  installationId: string;
  workspaceId: string;
  watchedBranch: string;
  isActive: boolean;
  destinationId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterRepoInput {
  listingId: string;
  repoId: string;
  watchedBranch?: string;
  destinationId?: string;
}

export interface UpdateRepoInput {
  watchedBranch?: string;
  isActive?: boolean;
  /** `null` removes the destination attribute (it is never stored as null). */
  destinationId?: string | null;
}

export interface RepoOps {
  /**
   * Saves a 15-minute snapshot of the repositories GitHub listed for the user.
   * The installation must be claimed by this workspace and the GitHub account
   * must be the one linked to the workspace. No GitHub token is stored.
   */
  saveVerifiedListing(ctx: WorkspaceContext, listing: VerifiedRepositoryListing): Promise<ListingSnapshot>;
  /** Returns `null` if the snapshot is unknown, expired or owned by another workspace. */
  getVerifiedListing(ctx: WorkspaceContext, listingId: string): Promise<ListingSnapshot | null>;
  /**
   * Registers a repository from an unexpired snapshot in which the user is an
   * admin of it. Refusals: `listing_invalid`, `repo_not_verified`,
   * `repo_claimed`, `repo_limit_reached`, `not_found` (destination),
   * `destination_not_active`.
   */
  registerRepo(ctx: WorkspaceContext, input: RegisterRepoInput): Promise<RepoRecord>;
  /** Deactivating frees a slot in the repository limit; reactivating needs a free slot. */
  updateRepo(ctx: WorkspaceContext, repoId: string, patch: UpdateRepoInput): Promise<RepoRecord>;
  getRepo(ctx: WorkspaceContext, repoId: string): Promise<RepoRecord | null>;
  listRepos(ctx: WorkspaceContext, page: PageRequest): Promise<Page<RepoRecord>>;
}

// ─── Destinations and the webhook-URL secret store ───────────────────────────
// Discord webhook URLs are secrets (anyone holding one can post to the
// channel). Each is stored as its own encrypted SSM SecureString parameter;
// DynamoDB keeps only a reference to it.
//
// The interfaces in this section are frozen: the writer (dashboard) and reader
// (sender) implementations and the IAM permission tests for both roles are
// built on them. Treat any change as a contract change.

/** Reference to the SSM parameter holding a webhook URL. Never returned by the API. */
export interface SecretRef {
  name: string;
  version: number;
}

export interface DestinationRecord {
  destinationId: string;
  workspaceId: string;
  provider: "discord";
  displayName: string;
  status: "pending_secret" | "active" | "inactive";
  webhookId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Write side (dashboard). Can only write parameters, never read them. The name
 * is always derived from the caller's workspace and the destination ID.
 * SSM throttling → `secret_store_busy`.
 */
export interface DestinationSecretWriter {
  put(name: string, value: string, opts: { overwrite: boolean }): Promise<{ version: number }>;
}

/**
 * Read side (webhook sender). Reads the exact version referenced. The caller
 * passes the stored reference AND the name derived from the repository's
 * workspace; if they differ, the read is refused before SSM is called.
 * Failures → `secret_unavailable` or `secret_store_busy`, and nothing is sent.
 */
export interface DestinationSecretReader {
  read(ref: SecretRef, expectedName: string): Promise<string>;
}

export interface DestinationOps {
  /**
   * SSM and DynamoDB cannot share a transaction, so creation is done in steps:
   * 1. reserve the destination in DynamoDB as `pending_secret`, checking the
   *    workspace and service-wide limits;
   * 2. store the URL in SSM (never overwriting an existing parameter);
   * 3. mark the destination `active` with the parameter version.
   * If a later step fails, the earlier ones are undone. A `pending_secret`
   * destination never receives notifications.
   *
   * Refusals: `invalid_webhook_url`, `destination_limit_reached`,
   * `destination_capacity_reached`, `secret_store_busy`, `secret_unavailable`.
   */
  createDestination(
    ctx: WorkspaceContext,
    input: { displayName: string; webhookUrl: string },
    writer: DestinationSecretWriter,
  ): Promise<DestinationRecord>;
  updateDestination(
    ctx: WorkspaceContext,
    destinationId: string,
    patch: { displayName?: string; isActive?: boolean },
  ): Promise<DestinationRecord>;
  /** Writes a new parameter version, then points the destination at that version. */
  replaceDestinationWebhook(
    ctx: WorkspaceContext,
    destinationId: string,
    webhookUrl: string,
    writer: DestinationSecretWriter,
  ): Promise<DestinationRecord>;
  getDestination(ctx: WorkspaceContext, destinationId: string): Promise<DestinationRecord | null>;
  listDestinations(ctx: WorkspaceContext, page: PageRequest): Promise<Page<DestinationRecord>>;
}

// ─── Delivery history ────────────────────────────────────────────────────────

export interface HistoryOps {
  listDeliveries(ctx: WorkspaceContext, page: PageRequest): Promise<Page<DeliveryDto>>;
}

// ─── GitHub verification (user-to-server tokens only) ────────────────────────
// The dashboard proves ownership with the user's own short-lived GitHub token
// and never uses the GitHub App's private key.

export interface GitHubTransportResponse {
  status: number;
  body: unknown;
  /** Lower-cased header names (e.g. `link`). */
  headers: Record<string, string>;
}

/** Injected HTTP layer: production uses fetch with a timeout; tests use a fake. */
export interface GitHubTransport {
  request(
    method: "GET" | "POST",
    url: string,
    opts: { userToken?: string; form?: Record<string, string> },
  ): Promise<GitHubTransportResponse>;
}

/** Held in memory only; never stored, logged or returned. */
export interface GitHubUserToken {
  readonly accessToken: string;
}

export interface GitHubVerificationLibrary {
  exchangeInstallCode(transport: GitHubTransport, input: { code: string }): Promise<GitHubUserToken>;
  getAuthenticatedGitHubUser(
    transport: GitHubTransport,
    token: GitHubUserToken,
  ): Promise<{ githubUserId: string; login: string }>;
  verifyUserInstallation(
    transport: GitHubTransport,
    token: GitHubUserToken,
    input: { installationId: string },
  ): Promise<VerifiedInstallation>;
  verifyUserOrgAdmin(
    transport: GitHubTransport,
    token: GitHubUserToken,
    input: { orgLogin: string; orgId: string },
  ): Promise<void>;
  listUserInstallationRepositories(
    transport: GitHubTransport,
    token: GitHubUserToken,
    input: { installationId: string; githubUserId: string },
  ): Promise<VerifiedRepositoryListing>;
}
