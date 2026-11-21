/**
 * Client-side view of the dashboard API's error contract.
 *
 * Every API error is `{ "error": <code> }` with the contract status. The UI
 * maps each code to plain wording here; the server never sends a message, and
 * nothing a user typed (in particular a webhook URL) is ever echoed back.
 */

import {
  API_ERROR_CODES,
  WORKSPACE_LIMITS,
  type ApiErrorCode,
} from "@contracts";

/** Failures that happen before a contract response exists. */
export type ClientOnlyErrorCode = "network_error" | "unexpected_response";
export type ClientErrorCode = ApiErrorCode | ClientOnlyErrorCode;

export class ApiError extends Error {
  readonly code: ClientErrorCode;
  /** HTTP status; 0 when no response was received. */
  readonly status: number;
  /** From `Retry-After` on 429 responses, in seconds. */
  readonly retryAfterSeconds?: number;
  /** Invalid field paths for `invalid_request` (never their values). */
  readonly fields?: string[];

  constructor(
    code: ClientErrorCode,
    status: number,
    options: { retryAfterSeconds?: number; fields?: string[] } = {},
  ) {
    super(code);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
    if (options.fields !== undefined) this.fields = options.fields;
  }
}

const KNOWN_CODES = new Set<string>(API_ERROR_CODES);

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === "string" && KNOWN_CODES.has(value);
}

/**
 * Status-only fallback for responses without a contract body, e.g. API
 * Gateway's own throttling (429) or size limits (413).
 */
export function codeForStatus(status: number): ClientErrorCode {
  switch (status) {
    case 400:
      return "invalid_request";
    case 401:
      return "unauthenticated";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 413:
      return "payload_too_large";
    case 429:
      return "rate_limited";
    default:
      return status >= 500 ? "internal_error" : "unexpected_response";
  }
}

/** Parses `Retry-After` given in seconds; HTTP dates are not sent by the API. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value || !/^\d{1,6}$/.test(value.trim())) return undefined;
  const seconds = Number(value.trim());
  return seconds > 0 ? seconds : undefined;
}

/**
 * Plain wording for every contract code. Typed as a full record so adding a
 * code to the contract fails the type check until it has wording here.
 */
export const ERROR_MESSAGES: Readonly<Record<ClientErrorCode, string>> = {
  invalid_request: "Some details weren’t accepted. Check the highlighted fields and try again.",
  unauthenticated: "Your session has ended. Sign in again to continue.",
  forbidden: "Only the workspace owner can make this change.",
  not_found: "We couldn’t find that. It may have been removed, or you may not have access to it.",
  payload_too_large: "That request was too large to send. Shorten the values and try again.",
  rate_limited: "Too many requests. Wait a moment and try again.",
  rate_limit_unavailable: "Syncro can’t accept changes right now. Try again shortly.",
  internal_error: "Something went wrong on our side. Try again.",

  signup_paused: "New sign-ups are paused right now. Try again later.",
  signup_not_open: "Syncro isn’t open for new sign-ups yet.",
  profile_suspended: "This account is suspended.",
  bootstrap_contention: "We couldn’t finish setting up your workspace. Try again.",

  state_invalid: "This GitHub link has expired or was already used. Start again from Syncro.",
  github_code_invalid: "GitHub didn’t accept the authorization. Start again from Syncro.",
  github_unavailable: "GitHub couldn’t be reached. Try again in a moment.",
  not_installation_owner:
    "Syncro couldn’t confirm that you own this installation or administer its organization.",
  org_not_supported: "Organization installations are not supported yet.",
  installation_claimed: "This GitHub installation is already connected to another Syncro workspace.",
  github_identity_mismatch:
    "This workspace is linked to a different GitHub account. Sign in to GitHub with that account and try again.",
  github_identity_in_use: "This GitHub account is already linked to another Syncro workspace.",
  installation_limit_reached: `This workspace already has the maximum of ${WORKSPACE_LIMITS.installations} GitHub installations.`,
  listing_invalid: "The repository list has expired. Load it again from GitHub.",

  repo_not_verified: "You need admin access to this repository on GitHub to add it.",
  repo_claimed: "This repository is already connected to another Syncro workspace.",
  repo_limit_reached: `You’ve reached the limit of ${WORKSPACE_LIMITS.activeRepos} active repositories. Pause one to add another.`,
  listing_too_large:
    "This installation has too many repositories to list at once. Give the installation access to fewer repositories on GitHub and try again.",

  invalid_webhook_url: "That isn’t a valid Discord webhook URL. Copy it again from Discord and paste it here.",
  destination_limit_reached: `You’ve reached the limit of ${WORKSPACE_LIMITS.activeDestinations} active destinations. Deactivate one to add another.`,
  destination_capacity_reached: "Syncro can’t add new destinations right now. Try again later.",
  destination_not_active: "This destination isn’t active, so it can’t be used or changed.",
  secret_store_busy: "Syncro is busy saving webhook URLs. Try again in a moment.",
  secret_unavailable: "The webhook URL couldn’t be saved, so nothing was changed. Try again.",

  network_error: "Couldn’t reach Syncro. Check your connection and try again.",
  unexpected_response: "Syncro sent an unexpected response. Try again.",
};

/** User-facing sentence for any thrown value; never includes request data. */
export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return ERROR_MESSAGES.internal_error;
  if (error.code === "rate_limited" && error.retryAfterSeconds !== undefined) {
    const s = error.retryAfterSeconds;
    return `Too many requests. Try again in ${s} second${s === 1 ? "" : "s"}.`;
  }
  return ERROR_MESSAGES[error.code];
}

/** True for refusals worth retrying unchanged (transient server-side states). */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return [
    "network_error",
    "internal_error",
    "rate_limited",
    "rate_limit_unavailable",
    "github_unavailable",
    "secret_store_busy",
    "secret_unavailable",
    "bootstrap_contention",
    "unexpected_response",
  ].includes(error.code);
}
