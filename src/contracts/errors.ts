/**
 * API error codes.
 *
 * Every dashboard API error response has the shape `{ "error": <code> }` with
 * the HTTP status given in `API_ERROR_STATUS`. Handlers take codes only from
 * here. Error responses never echo secrets, tokens, OAuth codes, webhook URLs
 * or SSM parameter values.
 */

export const API_ERROR_STATUS = {
  // ── Generic ────────────────────────────────────────────────────────────────
  /** Request failed strict validation (unknown key, `workspace_id` in the body, string boolean, out of bounds). */
  invalid_request: 400,
  /** Missing or invalid access token. */
  unauthenticated: 401,
  /** Member of the workspace, but the role is not sufficient. */
  forbidden: 403,
  /**
   * Unknown route, not a member, workspace not active, or a resource owned by
   * another workspace. All look the same so workspace existence is not leaked.
   */
  not_found: 404,
  /** Request body is larger than `REQUEST_LIMITS.maxBodyBytes` (dashboard routes only). */
  payload_too_large: 413,
  /** Per-user rate limit hit; the response carries `Retry-After`. */
  rate_limited: 429,
  /** Rate-limit store unavailable; the request is refused rather than allowed unchecked. */
  rate_limit_unavailable: 503,
  /** Unexpected failure; no detail is returned. */
  internal_error: 500,

  // ── Signup and workspace creation ──────────────────────────────────────────
  /** Signups are paused, or today's new-workspace cap has been reached. */
  signup_paused: 503,
  /** Signups are in pre-launch mode and the user is not on the allowlist. */
  signup_not_open: 403,
  /** The user's profile is suspended. */
  profile_suspended: 403,
  /** Workspace creation kept conflicting with concurrent requests; safe to retry. */
  bootstrap_contention: 503,

  // ── GitHub onboarding ──────────────────────────────────────────────────────
  /** OAuth `state` missing, unknown, already used, expired, or issued for another user, workspace or purpose. */
  state_invalid: 400,
  /** GitHub rejected the OAuth `code`. */
  github_code_invalid: 400,
  /** GitHub was unreachable or returned an unexpected response; nothing is treated as verified. */
  github_unavailable: 502,
  /** The installation is not visible to the user, belongs to another App, is suspended, or is not owned/administered by the user. */
  not_installation_owner: 403,
  /** Organization installation while organization support is disabled. */
  org_not_supported: 403,
  /** The installation is already claimed by another workspace. */
  installation_claimed: 409,
  /** This workspace is already linked to a different GitHub account. */
  github_identity_mismatch: 409,
  /** This GitHub account is already linked to another workspace. */
  github_identity_in_use: 409,
  /** The workspace already has the maximum number of installations. */
  installation_limit_reached: 409,
  /** Repository-listing snapshot missing, expired, owned by another workspace, or for another installation or GitHub account. */
  listing_invalid: 400,

  // ── Repositories ───────────────────────────────────────────────────────────
  /** Repository not in the verified listing, or the user is not an admin of it. */
  repo_not_verified: 403,
  /** Repository already registered to another workspace. */
  repo_claimed: 409,
  /** The workspace already has the maximum number of active repositories. */
  repo_limit_reached: 409,

  // ── Destinations and stored secrets ────────────────────────────────────────
  /** The Discord webhook URL failed validation (the value is never echoed). */
  invalid_webhook_url: 400,
  /** The workspace already has the maximum number of active destinations. */
  destination_limit_reached: 409,
  /** The service-wide destination capacity has been reached. */
  destination_capacity_reached: 503,
  /** The destination is not active, so it cannot be assigned or updated. */
  destination_not_active: 409,
  /** SSM Parameter Store is throttling writes; retry later. */
  secret_store_busy: 503,
  /** Storing the webhook URL failed for another reason; the change was rolled back. */
  secret_unavailable: 503,
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_STATUS;

export const API_ERROR_CODES = Object.keys(API_ERROR_STATUS) as ApiErrorCode[];

export interface ApiErrorBody {
  error: ApiErrorCode;
  /** Invalid field paths only, never their values (for `invalid_request`). */
  fields?: string[];
}

/** Expected refusal thrown by a data operation; the HTTP layer maps it to a response. */
export class ContractError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode) {
    super(code);
    this.name = "ContractError";
    this.code = code;
    this.status = API_ERROR_STATUS[code];
  }
}

// ─── Internal reason codes (logged, never returned as-is) ────────────────────

/**
 * Why an OAuth `state` was rejected. The API always answers `state_invalid` so
 * callers learn nothing about other users' states. `not_found` covers both an
 * unknown and an already-used state: a state is deleted when it is used, so
 * the two cannot be told apart.
 */
export const GITHUB_STATE_REJECT_REASONS = [
  "missing",
  "malformed",
  "not_found",
  "expired",
  "purpose_mismatch",
  "binding_mismatch",
] as const;
export type GitHubStateRejectReason = (typeof GITHUB_STATE_REJECT_REASONS)[number];

/** Why GitHub ownership verification failed; mapped to API codes by the HTTP layer. */
export const GITHUB_VERIFICATION_REJECT_REASONS = [
  "installation_not_listed",
  "app_id_mismatch",
  "installation_suspended",
  "account_not_user",
  "org_not_supported",
  "membership_http_403",
  "membership_http_404",
  "membership_not_active",
  "membership_not_admin",
  "membership_org_mismatch",
  "repo_not_listed",
  "repo_not_admin",
  "verification_stale",
  "count_mismatch",
  "schema_mismatch",
  "http_error",
  "timeout",
] as const;
export type GitHubVerificationRejectReason = (typeof GITHUB_VERIFICATION_REJECT_REASONS)[number];

/**
 * Why a GitHub webhook delivery ended without sending a notification. Such
 * deliveries are marked ignored and never appear in a workspace's history.
 * `repo_not_tenant`: the repository record has no owning workspace.
 */
export const WEBHOOK_IGNORE_REASONS = [
  "repo_not_found",
  "repo_inactive",
  "repo_not_tenant",
  "workspace_not_active",
  "installation_mismatch",
  "installation_not_active",
  "branch_not_watched",
  "event_not_supported",
] as const;
export type WebhookIgnoreReason = (typeof WEBHOOK_IGNORE_REASONS)[number];

/** The sender could not read a destination's webhook URL, so nothing is sent. */
export const SENDER_SECRET_FAILURES = ["secret_unavailable", "secret_store_busy"] as const;
export type SenderSecretFailure = (typeof SENDER_SECRET_FAILURES)[number];
