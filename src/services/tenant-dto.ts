/**
 * Mapping from data-layer records to the public API response shapes.
 *
 * Every dashboard response is built here, from explicit field lists, so a new
 * internal attribute can never leak by accident. In particular a response
 * never contains: a webhook URL or token, `secret_ref` (SSM name/version), a
 * GitHub token, or raw DynamoDB keys.
 */

import type {
  ClaimInstallationResponseDto,
  DestinationDto,
  InstallationDto,
  RepoDto,
  RepoListingDto,
} from "../contracts/dto";
import type {
  ClaimInstallationResult,
  DestinationRecord,
  InstallationRecord,
  ListingSnapshot,
  RepoRecord,
} from "../contracts/data-ops";

export function toInstallationDto(r: InstallationRecord): InstallationDto {
  return {
    installationId: r.installationId,
    accountLogin: r.accountLogin,
    accountType: r.accountType,
    status: r.status,
    claimedAt: r.createdAt,
  };
}

export function toRepoListingDto(s: ListingSnapshot): RepoListingDto {
  return {
    listingId: s.listingId,
    installationId: s.installationId,
    expiresAt: s.expiresAt,
    repos: s.repos.map((r) => ({ repoId: r.repoId, fullName: r.fullName, admin: r.admin })),
  };
}

export function toClaimInstallationResponseDto(
  claim: ClaimInstallationResult,
  listing: ListingSnapshot,
): ClaimInstallationResponseDto {
  return { created: claim.created, installation: toInstallationDto(claim.installation), listing: toRepoListingDto(listing) };
}

export function toRepoDto(r: RepoRecord): RepoDto {
  return {
    repoId: r.repoId,
    fullName: r.fullName,
    installationId: r.installationId,
    watchedBranch: r.watchedBranch,
    isActive: r.isActive,
    ...(r.destinationId ? { destinationId: r.destinationId } : {}),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** Masked display built only from the non-secret webhook ID; the token is never known here. */
export function maskedWebhookUrl(webhookId: string): string {
  return `discord.com/api/webhooks/${webhookId}/••••`;
}

export function toDestinationDto(r: DestinationRecord): DestinationDto {
  return {
    destinationId: r.destinationId,
    provider: r.provider,
    displayName: r.displayName,
    status: r.status,
    webhookUrlMasked: maskedWebhookUrl(r.webhookId),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
