/**
 * Dashboard API response shapes. They never contain: Discord webhook URLs or
 * tokens, SSM parameter names/versions (`secret_ref`), ciphertext, GitHub
 * tokens or codes, state nonces of other users, or raw DynamoDB keys.
 */

import type { Role } from "./roles";
import type { SignupMode } from "./constants";

export interface Page<T> {
  items: T[];
  /** Opaque base64url cursor, valid only for the same workspace. Absent on the last page. */
  nextCursor?: string;
}

// ─── Me / bootstrap ──────────────────────────────────────────────────────────

export type ProfileStatus = "active" | "suspended";
export type WorkspaceStatus = "active" | "suspended";

export interface WorkspaceMembershipDto {
  workspaceId: string;
  role: Role;
}

/** `GET /api/me`. `profile` is absent until bootstrap. */
export interface MeDto {
  profile?: {
    status: ProfileStatus;
    createdAt: string;
  };
  /** Active memberships of active workspaces only. */
  workspaces: WorkspaceMembershipDto[];
}

/** `POST /api/me/bootstrap`. Idempotent: an existing profile returns `created: false`. */
export interface BootstrapResponseDto {
  created: boolean;
  workspaceId: string;
}

/** Operator-only view (`scripts/set-signup-mode.ts`); never served over HTTP. */
export interface SignupConfigDto {
  mode: SignupMode;
  dailyCap: number;
  prelaunchAllowCount: number;
}

// ─── GitHub onboarding ───────────────────────────────────────────────────────

/** `POST …/github/install-url` and `POST …/github/authorize-url`. */
export interface GitHubRedirectUrlDto {
  /** GitHub URL including the single-use `state`; expires with the state. */
  url: string;
  expiresAt: string;
}

export type InstallationAccountType = "User" | "Organization";
export type InstallationStatus = "active" | "deleted";

export interface InstallationDto {
  installationId: string;
  accountLogin: string;
  accountType: InstallationAccountType;
  status: InstallationStatus;
  claimedAt: string;
}

export interface ListingRepoDto {
  repoId: string;
  fullName: string;
  admin: boolean;
}

/** A verified listing snapshot (`GHLISTING#`); no token is stored or returned. */
export interface RepoListingDto {
  listingId: string;
  installationId: string;
  expiresAt: string;
  repos: ListingRepoDto[];
}

/** `POST …/github/claim`. `created: false` on an idempotent re-claim. */
export interface ClaimInstallationResponseDto {
  created: boolean;
  installation: InstallationDto;
  listing: RepoListingDto;
}

// ─── Repositories ────────────────────────────────────────────────────────────

export interface RepoDto {
  repoId: string;
  fullName: string;
  installationId: string;
  watchedBranch: string;
  isActive: boolean;
  /** Absent when no destination is assigned (zero targets). */
  destinationId?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Destinations ────────────────────────────────────────────────────────────

export type DestinationStatus = "pending_secret" | "active" | "inactive";

export interface DestinationDto {
  destinationId: string;
  provider: "discord";
  displayName: string;
  /** `pending_secret` is never a delivery target. */
  status: DestinationStatus;
  /** Built from the non-secret `webhook_id`, e.g. `discord.com/api/webhooks/1234…/••••`. */
  webhookUrlMasked: string;
  createdAt: string;
  updatedAt: string;
}

// ─── History (ledger) ────────────────────────────────────────────────────────

export type LedgerDeliveryStatus = "processed" | "failed";

/** Non-sensitive delivery summary; optional fields are omitted when not applicable. */
export interface DeliverySummaryDto {
  repoFullName: string;
  eventType: string;
  branch?: string;
  action?: string;
  commitCount?: number;
  headShortSha?: string;
  prNumber?: number;
}

/** `GET …/deliveries`. Ignored deliveries are never listed. */
export interface DeliveryDto {
  deliveryId: string;
  status: LedgerDeliveryStatus;
  receivedAt: string;
  processedAt?: string;
  summary: DeliverySummaryDto;
  /** Masked, length-capped error text; never a URL, token or credential. */
  errorMessage?: string;
}
