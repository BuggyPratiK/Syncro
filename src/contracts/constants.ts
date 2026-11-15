/**
 * Shared limits, timeouts and safeguard values.
 *
 * These numbers are part of the API contract: the backend enforces them, and
 * the dashboard API and web app import them so every layer agrees on the same
 * values. Changing one changes user-visible behaviour, so treat edits here as
 * an API change.
 */

// ─── Per-workspace limits ────────────────────────────────────────────────────
// Enforced with conditional counters on the workspace item, so concurrent
// requests can never push a workspace past its limit.

export const WORKSPACE_LIMITS = {
  /** Maximum active repositories per workspace (`active_repo_count < 25`). */
  activeRepos: 25,
  /** Maximum active Discord destinations per workspace (`active_destination_count < 10`). */
  activeDestinations: 10,
  /** Maximum claimed GitHub App installations per workspace. There is no unclaim yet. */
  installations: 3,
} as const;

// ─── Global capacity ─────────────────────────────────────────────────────────

/**
 * Each Discord destination stores its webhook URL in its own SSM parameter.
 * AWS allows 10,000 standard parameters per account and region, so Syncro caps
 * destination parameters well below that, across all workspaces combined.
 */
export const SSM_DESTINATION_PARAMS = {
  /** Hard ceiling: new destinations are refused once this many parameters exist. */
  ceiling: 1000,
  /** Level at which operators should be warned that the ceiling is approaching. */
  warnAt: 800,
} as const;

// ─── Signup ──────────────────────────────────────────────────────────────────

export const SIGNUP = {
  /** Default maximum number of new workspaces created per day. */
  defaultDailyCap: 100,
  /** How long a per-day signup counter item is kept. */
  dayCounterTtlSeconds: 7 * 24 * 60 * 60,
  /** Days for the daily cap are UTC calendar days, the same for every user. */
  dayBoundary: "UTC",
  /** How long the signup-mode setting may be cached before it is re-read. */
  configCacheMs: 60_000,
} as const;

/**
 * Operator switch for new signups:
 * - `prelaunch`: only allowlisted users may create a workspace;
 * - `open`: anyone may sign up;
 * - `paused`: no new workspaces (abuse kill switch). Existing users are unaffected.
 */
export const SIGNUP_MODES = ["prelaunch", "open", "paused"] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

// ─── Per-user rate limits ────────────────────────────────────────────────────

/**
 * Fixed-window rate-limit buckets. Read routes deliberately have no per-user
 * bucket; they are covered by the API-wide throttle.
 */
export const RATE_LIMIT_BUCKETS = ["bootstrap", "github", "write"] as const;
export type RateLimitBucket = (typeof RATE_LIMIT_BUCKETS)[number];

/** Allowed requests per user, per bucket, per window. */
export const RATE_LIMITS: Readonly<Record<RateLimitBucket, number>> = {
  bootstrap: 5,
  github: 10,
  write: 30,
};

export const RATE_LIMIT_WINDOW_SECONDS = 60;
/** Counter items expire after two windows; older windows are never read again. */
export const RATE_LIMIT_TTL_SECONDS = 2 * RATE_LIMIT_WINDOW_SECONDS;
/**
 * If the rate-limit counter store is unavailable, requests are rejected with
 * this status instead of silently skipping the limit (fail closed).
 */
export const RATE_LIMIT_STORE_FAILURE_STATUS = 503;

// ─── Dashboard request validation ────────────────────────────────────────────

export const REQUEST_LIMITS = {
  /** Maximum decoded body size, checked before JSON parsing (dashboard routes only). */
  maxBodyBytes: 16_384,
  displayNameMin: 1,
  displayNameMax: 64,
  webhookUrlMax: 256,
  branchMin: 1,
  branchMax: 255,
  pageSizeMin: 1,
  pageSizeMax: 50,
  pageSizeDefault: 25,
  /** Maximum pagination cursor length (base64url only, bound to its workspace). */
  cursorMaxLength: 1024,
  /** Upper bound for a GitHub OAuth `code` (opaque; never logged). */
  githubCodeMaxLength: 256,
} as const;

/** Branch watched when a repository is registered without one. */
export const DEFAULT_WATCHED_BRANCH = "main";

// ─── GitHub onboarding ───────────────────────────────────────────────────────

export const GITHUB_ONBOARDING = {
  /** Lifetime of a single-use OAuth `state` value. */
  stateTtlSeconds: 10 * 60,
  /** Random bytes in a state nonce (base64url-encoded to 43 characters). */
  stateNonceBytes: 32,
  /** Lifetime of a verified repository-listing snapshot. */
  listingTtlSeconds: 15 * 60,
  /** Maximum age of a GitHub verification result when it is used to claim or register. */
  verificationMaxAgeSeconds: 15 * 60,
} as const;

/**
 * Whether installations on GitHub organizations can be claimed.
 *
 * An organization installation is accepted only when the user is an active
 * admin of that organization, which Syncro checks through GitHub's membership
 * endpoint. That endpoint requires the GitHub App to hold the
 * "Organization → Members: Read-only" permission. Until an organization has
 * approved it, GitHub answers 403 and the claim is rejected (fail closed).
 */
export const ORG_INSTALLATIONS_SUPPORTED = true;

// ─── Authentication (Logto) ──────────────────────────────────────────────────

export const AUTH = {
  /** Lifetime of a Logto API access token, in seconds. */
  accessTokenTtlSeconds: 3600,
  /** Only these JWT signing algorithms are accepted. */
  allowedAlgorithms: ["ES384"] as readonly string[],
  /** Claim that binds an access token to the dashboard's client application. */
  clientIdClaim: "client_id",
  /** Format of a Logto user ID (`sub` claim). */
  subPattern: /^[a-z0-9]{12}$/,
  /** Syncro user IDs are `"logto:" + sub`. */
  userIdPrefix: "logto:",
  clockToleranceSeconds: 5,
  jwksTimeoutMs: 3000,
} as const;

// ─── Webhook relay ───────────────────────────────────────────────────────────

export const RELAY = {
  /** Maximum time for one Discord request; also capped by the remaining Lambda time. */
  discordAttemptTimeoutMs: 5000,
  /**
   * Maximum time for one GitHub API request. If commit enrichment times out,
   * the notification is sent with the data from the webhook payload instead.
   */
  githubRequestTimeoutMs: 3000,
  /** Time kept free before the Lambda deadline so the invocation can finish cleanly. */
  deadlineSafetyReserveMs: 2000,
  /** Maximum length of a stored error message, applied after secrets are masked. */
  persistedErrorMaxChars: 500,
  /** Maximum number of commits enriched through the GitHub API per delivery. */
  enrichmentCap: 5,
} as const;

// ─── Secrets ─────────────────────────────────────────────────────────────────

export const SECRETS = {
  /**
   * How long a decrypted destination webhook URL may be cached in a Lambda
   * container. The cache key includes the SSM parameter version, so replacing
   * a URL takes effect immediately; only an out-of-band overwrite of the same
   * version can be served stale, for at most this long.
   */
  destinationUrlCacheTtlSeconds: 300,
} as const;
