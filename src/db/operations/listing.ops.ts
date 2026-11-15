/**
 * Verified repository-listing snapshots (`GHLISTING#<listingId>`).
 *
 * After the user authorizes on GitHub, the dashboard lists the repositories
 * of an installation with the user's own short-lived token and saves the
 * result here for 15 minutes. Repository registration later reads only this
 * snapshot, so no GitHub token is ever stored and the browser's word is never
 * taken for which repositories the user administers.
 *
 * A snapshot is bound to the workspace, the installation and the GitHub
 * account. It can only be saved for an installation this workspace has
 * claimed, by the GitHub account linked to the workspace. Expiry is checked
 * explicitly against `ttl` (DynamoDB deletes expired items only eventually).
 */

import { randomUUID } from "crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../client";
import { tableName, tenantKeys } from "../table";
import { GITHUB_ONBOARDING } from "../../contracts/constants";
import { ContractError } from "../../contracts/errors";
import { assertId, isValidId } from "../../contracts/ids";
import type { ListingSnapshot, VerifiedRepositoryListing, WorkspaceContext } from "../../contracts/data-ops";
import type { GitHubListingItem, InstallationItem, WorkspaceItem } from "../../types/tenant.types";
import { requireRole } from "../../tenancy/context";
import { assertFreshVerification } from "./installation.ops";

/**
 * Upper bound on repositories per snapshot, keeping the item well under
 * DynamoDB's 400 KB item limit (each entry is roughly 150 bytes).
 */
export const MAX_LISTING_REPOS = 1000;

/**
 * The installation lists more repositories than one snapshot can hold. The
 * listing is never truncated or filtered (that would silently hide
 * repositories); nothing is stored and the request fails.
 *
 * It is a `ContractError` with the public code `listing_too_large` (HTTP 422),
 * so the HTTP layer maps it like every other contract error, to
 * `{ "error": "listing_too_large" }`. `repoCount` is for logs only and is not
 * part of the public response.
 */
export class ListingTooLargeError extends ContractError {
  readonly repoCount: number;
  constructor(repoCount: number) {
    super("listing_too_large");
    this.name = "ListingTooLargeError";
    this.repoCount = repoCount;
  }
}

const FULL_NAME = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;

function toSnapshot(item: GitHubListingItem): ListingSnapshot {
  return {
    listingId: item.listing_id,
    installationId: item.installation_id,
    githubUserId: item.github_user_id,
    repos: item.repos.map((r) => ({ repoId: r.id, fullName: r.full_name, admin: r.admin })),
    verifiedAt: item.verified_at,
    expiresAt: new Date(item.ttl * 1000).toISOString(),
  };
}

export async function saveVerifiedListing(
  ctx: WorkspaceContext,
  listing: VerifiedRepositoryListing,
  nowMs: number = Date.now(),
): Promise<ListingSnapshot> {
  // Data-layer minimum is admin (owner or admin); the HTTP route table may require more.
  requireRole(ctx, "admin");
  assertFreshVerification(listing.verifiedAt, nowMs);
  const installationId = assertId("githubId", listing.installationId);
  const githubUserId = assertId("githubId", listing.githubUserId);
  if (listing.repos.length > MAX_LISTING_REPOS) {
    throw new ListingTooLargeError(listing.repos.length);
  }
  const repos = listing.repos.map((r) => {
    if (!isValidId("githubId", r.repoId) || !FULL_NAME.test(r.fullName) || typeof r.admin !== "boolean") {
      throw new Error("Malformed repository in listing");
    }
    return { id: r.repoId, full_name: r.fullName, admin: r.admin };
  });

  const [inst, ws] = await Promise.all([
    ddb.send(new GetCommand({ TableName: tableName(), Key: tenantKeys.installation(installationId), ConsistentRead: true })),
    ddb.send(new GetCommand({ TableName: tableName(), Key: tenantKeys.workspace(ctx.workspaceId), ConsistentRead: true })),
  ]);
  const installation = inst.Item as InstallationItem | undefined;
  const workspace = ws.Item as WorkspaceItem | undefined;
  if (!installation || installation.workspace_id !== ctx.workspaceId || installation.status !== "active") {
    throw new ContractError("not_installation_owner");
  }
  if (!workspace || workspace.github_user_id !== githubUserId) {
    throw new ContractError("github_identity_mismatch");
  }

  const listingId = randomUUID();
  const item: GitHubListingItem = {
    ...tenantKeys.githubListing(listingId),
    listing_id: listingId,
    workspace_id: ctx.workspaceId,
    installation_id: installationId,
    github_user_id: githubUserId,
    repos,
    verified_at: listing.verifiedAt,
    ttl: Math.floor(Date.parse(listing.verifiedAt) / 1000) + GITHUB_ONBOARDING.listingTtlSeconds,
  };
  await ddb.send(new PutCommand({ TableName: tableName(), Item: item, ConditionExpression: "attribute_not_exists(PK)" }));
  return toSnapshot(item);
}

export async function getVerifiedListing(
  ctx: WorkspaceContext,
  listingId: string,
  nowMs: number = Date.now(),
): Promise<ListingSnapshot | null> {
  if (!isValidId("listingId", listingId)) return null;
  const out = await ddb.send(
    new GetCommand({ TableName: tableName(), Key: tenantKeys.githubListing(listingId), ConsistentRead: true }),
  );
  const item = out.Item as GitHubListingItem | undefined;
  if (!item || item.workspace_id !== ctx.workspaceId || item.ttl <= Math.floor(nowMs / 1000)) return null;
  return toSnapshot(item);
}
