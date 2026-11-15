/**
 * GitHub App installations claimed by workspaces.
 *
 * Ownership rules enforced here, in DynamoDB, so they hold under concurrency:
 * - one GitHub account per workspace: the first claim sets
 *   `WS#<ws>/META.github_user_id`; later claims must come from the same account;
 * - one workspace per GitHub account: `GHUSER#<id>/LINK` is created
 *   conditionally and can only ever point at one workspace;
 * - one workspace per installation: `INSTALLATION#<id>/META` is created
 *   conditionally;
 * - at most `WORKSPACE_LIMITS.installations` installations per workspace.
 *
 * Claim procedure:
 * 0. Consistent read of the installation. Already owned by this workspace →
 *    idempotent success, nothing written, no counter change (after checking
 *    the GitHub account still matches).
 * 1. One transaction:
 *      [0] WS#<ws>/META: bind github_user_id if unset, count += 1
 *          (workspace active, same account, count below the limit)
 *      [1] GHUSER#<gid>/LINK → this workspace (absent, or already this workspace)
 *      [2] INSTALLATION#<id>/META (absent, or previously deleted)
 *    The installation condition deliberately does NOT accept "already owned by
 *    this workspace": that case is handled in step 0, so two concurrent
 *    re-claims can never count the same installation twice. The losing request
 *    sees [2] fail, re-reads, and returns the idempotent result.
 * The ownership proof itself (`VerifiedInstallation`) comes from the GitHub
 * verification functions and must be at most 15 minutes old.
 */

import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../client";
import { tableName, tenantGsiKeys, tenantKeys } from "../table";
import { decodeCursor, encodeCursor } from "../cursor";
import {
  GITHUB_ONBOARDING,
  ORG_INSTALLATIONS_SUPPORTED,
  WORKSPACE_LIMITS,
} from "../../contracts/constants";
import { ContractError } from "../../contracts/errors";
import { assertId } from "../../contracts/ids";
import type {
  ClaimInstallationResult,
  InstallationRecord,
  PageRequest,
  VerifiedInstallation,
  WorkspaceContext,
} from "../../contracts/data-ops";
import type { Page } from "../../contracts/dto";
import type { InstallationItem, WorkspaceItem } from "../../types/tenant.types";
import { requireRole } from "../../tenancy/context";
import { backoffMs, cancellationReasons, isTransient, sleep } from "../dynamo-errors";

const MAX_ATTEMPTS = 3;
const CLOCK_SKEW_MS = 60_000;

function toRecord(item: InstallationItem): InstallationRecord {
  return {
    installationId: item.installation_id,
    workspaceId: item.workspace_id,
    accountId: item.account_id,
    accountLogin: item.account_login,
    accountType: item.account_type,
    claimedByGithubUserId: item.claimed_by_github_user_id,
    status: item.status,
    verifiedAt: item.verified_at,
    createdAt: item.created_at,
  };
}

/** Rejects a missing, malformed, stale or future-dated verification. */
export function assertFreshVerification(verifiedAt: string, nowMs: number): void {
  const at = Date.parse(verifiedAt);
  if (
    Number.isNaN(at) ||
    at > nowMs + CLOCK_SKEW_MS ||
    nowMs - at > GITHUB_ONBOARDING.verificationMaxAgeSeconds * 1000
  ) {
    throw new ContractError("not_installation_owner");
  }
}

async function readInstallation(installationId: string): Promise<InstallationItem | undefined> {
  const out = await ddb.send(
    new GetCommand({ TableName: tableName(), Key: tenantKeys.installation(installationId), ConsistentRead: true }),
  );
  return out.Item as InstallationItem | undefined;
}

async function readWorkspace(workspaceId: string): Promise<WorkspaceItem | undefined> {
  const out = await ddb.send(
    new GetCommand({ TableName: tableName(), Key: tenantKeys.workspace(workspaceId), ConsistentRead: true }),
  );
  return out.Item as WorkspaceItem | undefined;
}

/** The idempotent result for an installation this workspace already owns. */
async function existingClaim(
  ctx: WorkspaceContext,
  item: InstallationItem,
  githubUserId: string,
): Promise<ClaimInstallationResult> {
  const ws = await readWorkspace(ctx.workspaceId);
  if (!ws || ws.status !== "active") throw new ContractError("not_found");
  if (ws.github_user_id !== undefined && ws.github_user_id !== githubUserId) {
    throw new ContractError("github_identity_mismatch");
  }
  return { created: false, installation: toRecord(item) };
}

function ownedActive(item: InstallationItem | undefined, workspaceId: string): item is InstallationItem {
  return item !== undefined && item.workspace_id === workspaceId && item.status === "active";
}

export async function claimInstallation(
  ctx: WorkspaceContext,
  verified: VerifiedInstallation,
  nowMs: number = Date.now(),
): Promise<ClaimInstallationResult> {
  requireRole(ctx, "owner");
  assertFreshVerification(verified.verifiedAt, nowMs);
  const installationId = assertId("githubId", verified.installationId);
  const githubUserId = assertId("githubId", verified.githubUserId);
  const accountId = assertId("githubId", verified.accountId);
  if (verified.accountType === "Organization" && !ORG_INSTALLATIONS_SUPPORTED) {
    throw new ContractError("org_not_supported");
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Step 0: already ours → idempotent, nothing written.
    const current = await readInstallation(installationId);
    if (ownedActive(current, ctx.workspaceId)) return existingClaim(ctx, current, githubUserId);

    const now = new Date(nowMs).toISOString();
    const item: InstallationItem = {
      ...tenantKeys.installation(installationId),
      installation_id: installationId,
      workspace_id: ctx.workspaceId,
      account_id: accountId,
      account_login: verified.accountLogin,
      account_type: verified.accountType,
      claimed_by_github_user_id: githubUserId,
      claimed_by: ctx.userId,
      verified_via: "user_oauth",
      verified_at: verified.verifiedAt,
      status: "active",
      GSI1PK: tenantGsiKeys.installations(ctx.workspaceId),
      created_at: now,
      updated_at: now,
    };

    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: tableName(),
                Key: tenantKeys.workspace(ctx.workspaceId),
                UpdateExpression: "SET github_user_id = if_not_exists(github_user_id, :gid) ADD installation_count :one",
                ConditionExpression:
                  "#status = :active AND (attribute_not_exists(github_user_id) OR github_user_id = :gid) " +
                  "AND (attribute_not_exists(installation_count) OR installation_count < :max)",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":gid": githubUserId,
                  ":one": 1,
                  ":active": "active",
                  ":max": WORKSPACE_LIMITS.installations,
                },
                ReturnValuesOnConditionCheckFailure: "ALL_OLD",
              },
            },
            {
              Update: {
                TableName: tableName(),
                Key: tenantKeys.githubUserLink(githubUserId),
                UpdateExpression: "SET workspace_id = :ws, github_user_id = :gid, created_at = if_not_exists(created_at, :now)",
                ConditionExpression: "attribute_not_exists(PK) OR workspace_id = :ws",
                ExpressionAttributeValues: { ":ws": ctx.workspaceId, ":gid": githubUserId, ":now": now },
              },
            },
            {
              Put: {
                TableName: tableName(),
                Item: item,
                ConditionExpression: "attribute_not_exists(PK) OR #status = :deleted",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":deleted": "deleted" },
              },
            },
          ],
        }),
      );
      return { created: true, installation: toRecord(item) };
    } catch (error) {
      const reasons = cancellationReasons(error);
      if (reasons[0]?.code === "ConditionalCheckFailed") {
        const ws = reasons[0].item;
        if (!ws || ws.status !== "active") throw new ContractError("not_found");
        if (ws.github_user_id !== undefined && ws.github_user_id !== githubUserId) {
          throw new ContractError("github_identity_mismatch");
        }
        // Only the count condition can be left. A concurrent claim of this same
        // installation by this workspace may have just used the last slot.
        const now2 = await readInstallation(installationId);
        if (ownedActive(now2, ctx.workspaceId)) return existingClaim(ctx, now2, githubUserId);
        throw new ContractError("installation_limit_reached");
      }
      if (reasons[1]?.code === "ConditionalCheckFailed") throw new ContractError("github_identity_in_use");
      if (reasons[2]?.code === "ConditionalCheckFailed") {
        const after = await readInstallation(installationId);
        if (ownedActive(after, ctx.workspaceId)) return existingClaim(ctx, after, githubUserId);
        throw new ContractError("installation_claimed");
      }
      if (!isTransient(error) || attempt === MAX_ATTEMPTS) throw error;
      await sleep(backoffMs(attempt));
    }
  }
  throw new ContractError("internal_error");
}

export async function getInstallation(ctx: WorkspaceContext, installationId: string): Promise<InstallationRecord | null> {
  let id: string;
  try {
    id = assertId("githubId", installationId);
  } catch {
    return null;
  }
  const item = await readInstallation(id);
  return item && item.workspace_id === ctx.workspaceId ? toRecord(item) : null;
}

export async function listInstallations(ctx: WorkspaceContext, page: PageRequest): Promise<Page<InstallationRecord>> {
  const gsi = tenantGsiKeys.installations(ctx.workspaceId);
  const startKey = decodeCursor(ctx.workspaceId, page.cursor, (k) => k.GSI1PK === gsi && k.PK?.startsWith("INSTALLATION#") && k.SK === "META");
  const out = await ddb.send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: "type-index",
      KeyConditionExpression: "GSI1PK = :gsi",
      ExpressionAttributeValues: { ":gsi": gsi },
      Limit: page.limit,
      ExclusiveStartKey: startKey,
    }),
  );
  const items = ((out.Items ?? []) as InstallationItem[]).filter((i) => i.workspace_id === ctx.workspaceId);
  return { items: items.map(toRecord), nextCursor: encodeCursor(ctx.workspaceId, out.LastEvaluatedKey) };
}
