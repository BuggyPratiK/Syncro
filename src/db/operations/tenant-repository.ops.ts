/**
 * Repositories registered by workspaces (`REPO#<id>/CONFIG` with a
 * `workspace_id`).
 *
 * Registration requires proof, from an unexpired listing snapshot of this
 * workspace, that the user is an admin of the repository on GitHub
 * (`VerifiedRepoAssociation`, produced only inside `registerRepo`). Writes are
 * transactions that also:
 * - check the installation is still this workspace's and active;
 * - keep `active_repo_count` within `WORKSPACE_LIMITS.activeRepos`
 *   (register and reactivate take a slot, deactivate frees one);
 * - check an assigned destination is this workspace's and active.
 * A repository owned by another workspace, or an existing record without a
 * workspace, can never be taken over. Clearing the destination REMOVEs the
 * attribute (never stores null); no webhook URL is ever written here.
 */

import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../client";
import { tableName, tenantGsiKeys, tenantKeys } from "../table";
import { decodeCursor, encodeCursor } from "../cursor";
import { DEFAULT_WATCHED_BRANCH, WORKSPACE_LIMITS } from "../../contracts/constants";
import { ContractError } from "../../contracts/errors";
import { isValidId } from "../../contracts/ids";
import { fieldSchemas } from "../../contracts/schemas";
import type {
  PageRequest,
  RegisterRepoInput,
  RepoRecord,
  UpdateRepoInput,
  VerifiedRepoAssociation,
  WorkspaceContext,
} from "../../contracts/data-ops";
import type { Page } from "../../contracts/dto";
import type { TenantRepoConfigItem } from "../../types/tenant.types";
import { requireRole } from "../../tenancy/context";
import { cancellationReasons } from "../dynamo-errors";
import { getVerifiedListing } from "./listing.ops";

type TxItem = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>[number];

function toRecord(item: TenantRepoConfigItem): RepoRecord {
  return {
    repoId: item.github_repo_id,
    fullName: item.github_full_name,
    installationId: item.installation_id,
    workspaceId: item.workspace_id,
    watchedBranch: item.watched_branch,
    isActive: item.is_active === true,
    ...(item.discord_destination_id ? { destinationId: item.discord_destination_id } : {}),
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

function validBranch(branch: string | undefined): string {
  const value = branch ?? DEFAULT_WATCHED_BRANCH;
  if (!fieldSchemas.branch.safeParse(value).success) throw new ContractError("invalid_request");
  return value;
}

async function readRepo(repoId: string): Promise<TenantRepoConfigItem | undefined> {
  const out = await ddb.send(new GetCommand({ TableName: tableName(), Key: tenantKeys.repo(repoId), ConsistentRead: true }));
  return out.Item as TenantRepoConfigItem | undefined;
}

/** Proof that `repoId` is in an unexpired listing of this workspace with admin rights. */
async function verifyRepoAssociation(
  ctx: WorkspaceContext,
  listingId: string,
  repoId: string,
  nowMs: number,
): Promise<VerifiedRepoAssociation> {
  const listing = await getVerifiedListing(ctx, listingId, nowMs);
  if (!listing) throw new ContractError("listing_invalid");
  const repo = listing.repos.find((r) => r.repoId === repoId);
  if (!repo || repo.admin !== true) throw new ContractError("repo_not_verified");
  return {
    installationId: listing.installationId,
    repoId,
    fullName: repo.fullName,
    listingId,
    verifiedVia: "user_oauth",
    verifiedAt: listing.verifiedAt,
  } as VerifiedRepoAssociation;
}

const installationCheck = (ctx: WorkspaceContext, installationId: string): TxItem => ({
  ConditionCheck: {
    TableName: tableName(),
    Key: tenantKeys.installation(installationId),
    ConditionExpression: "workspace_id = :ws AND #status = :active",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":ws": ctx.workspaceId, ":active": "active" },
  },
});

const destinationCheck = (ctx: WorkspaceContext, destinationId: string): TxItem => ({
  ConditionCheck: {
    TableName: tableName(),
    Key: tenantKeys.destination(ctx.workspaceId, destinationId),
    ConditionExpression: "attribute_exists(PK) AND #status = :active",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":active": "active" },
  },
});

/** Takes (+1) or frees (-1) one active-repository slot on the workspace. */
const repoSlot = (ctx: WorkspaceContext, delta: 1 | -1): TxItem => ({
  Update: {
    TableName: tableName(),
    Key: tenantKeys.workspace(ctx.workspaceId),
    UpdateExpression: "ADD active_repo_count :delta",
    ConditionExpression:
      delta === 1
        ? "#status = :active AND (attribute_not_exists(active_repo_count) OR active_repo_count < :max)"
        : "active_repo_count > :zero",
    ExpressionAttributeNames: delta === 1 ? { "#status": "status" } : undefined,
    ExpressionAttributeValues:
      delta === 1
        ? { ":delta": 1, ":active": "active", ":max": WORKSPACE_LIMITS.activeRepos }
        : { ":delta": -1, ":zero": 0 },
    ReturnValuesOnConditionCheckFailure: "ALL_OLD",
  },
});

async function destinationFailure(ctx: WorkspaceContext, destinationId: string): Promise<ContractError> {
  const out = await ddb.send(
    new GetCommand({ TableName: tableName(), Key: tenantKeys.destination(ctx.workspaceId, destinationId), ConsistentRead: true }),
  );
  return new ContractError(out.Item ? "destination_not_active" : "not_found");
}

export async function registerRepo(
  ctx: WorkspaceContext,
  input: RegisterRepoInput,
  nowMs: number = Date.now(),
): Promise<RepoRecord> {
  // Data-layer minimum is admin (owner or admin); the HTTP route table may require more.
  requireRole(ctx, "admin");
  if (!isValidId("githubId", input.repoId) || !isValidId("listingId", input.listingId)) {
    throw new ContractError("invalid_request");
  }
  if (input.destinationId !== undefined && !isValidId("destinationId", input.destinationId)) {
    throw new ContractError("invalid_request");
  }
  const branch = validBranch(input.watchedBranch);
  const verified = await verifyRepoAssociation(ctx, input.listingId, input.repoId, nowMs);

  const existing = await readRepo(verified.repoId);
  if (existing) {
    if (existing.workspace_id !== ctx.workspaceId) throw new ContractError("repo_claimed");
    if (existing.is_active === true) return toRecord(existing); // already registered and active
  }

  const now = new Date(nowMs).toISOString();
  const sets = [
    "github_repo_id = :id",
    "github_full_name = :name",
    "github_url = :url",
    "workspace_id = :ws",
    "installation_id = :inst",
    "watched_branch = :branch",
    "is_active = :true",
    "ownership_verified_at = :verifiedAt",
    "GSI1PK = :gsi",
    "created_at = if_not_exists(created_at, :now)",
    "updated_at = :now",
  ];
  if (input.destinationId) sets.push("discord_destination_id = :dest");
  const update =
    `SET ${sets.join(", ")}` + (input.destinationId ? " REMOVE discord_webhook_url" : " REMOVE discord_destination_id, discord_webhook_url");

  const items: TxItem[] = [
    installationCheck(ctx, verified.installationId),
    repoSlot(ctx, 1),
    {
      Update: {
        TableName: tableName(),
        Key: tenantKeys.repo(verified.repoId),
        UpdateExpression: update,
        // New repository, or this workspace's own inactive one (reactivation).
        ConditionExpression: "attribute_not_exists(PK) OR (workspace_id = :ws AND is_active = :false)",
        ExpressionAttributeValues: {
          ":id": verified.repoId,
          ":name": verified.fullName,
          ":url": `https://github.com/${verified.fullName}`,
          ":ws": ctx.workspaceId,
          ":inst": verified.installationId,
          ":branch": branch,
          ":true": true,
          ":false": false,
          ":verifiedAt": verified.verifiedAt,
          ":gsi": tenantGsiKeys.repos(ctx.workspaceId),
          ":now": now,
          ...(input.destinationId ? { ":dest": input.destinationId } : {}),
        },
      },
    },
  ];
  if (input.destinationId) items.push(destinationCheck(ctx, input.destinationId));

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    const reasons = cancellationReasons(error);
    if (reasons[0]?.code === "ConditionalCheckFailed") throw new ContractError("not_installation_owner");
    if (reasons[1]?.code === "ConditionalCheckFailed") {
      throw new ContractError(reasons[1].item?.status === "active" ? "repo_limit_reached" : "not_found");
    }
    if (reasons[2]?.code === "ConditionalCheckFailed") {
      const after = await readRepo(verified.repoId);
      if (after && after.workspace_id === ctx.workspaceId && after.is_active === true) return toRecord(after);
      throw new ContractError("repo_claimed");
    }
    if (reasons[3]?.code === "ConditionalCheckFailed") throw await destinationFailure(ctx, input.destinationId!);
    throw error;
  }
  const saved = await readRepo(verified.repoId);
  return toRecord(saved!);
}

export async function updateRepo(
  ctx: WorkspaceContext,
  repoId: string,
  patch: UpdateRepoInput,
  nowMs: number = Date.now(),
): Promise<RepoRecord> {
  // Data-layer minimum is admin (owner or admin); the HTTP route table may require more.
  requireRole(ctx, "admin");
  if (!isValidId("githubId", repoId)) throw new ContractError("not_found");
  if (patch.isActive !== undefined && typeof patch.isActive !== "boolean") throw new ContractError("invalid_request");
  if (patch.destinationId && !isValidId("destinationId", patch.destinationId)) throw new ContractError("invalid_request");
  if (patch.watchedBranch !== undefined) validBranch(patch.watchedBranch);
  if (patch.watchedBranch === undefined && patch.isActive === undefined && patch.destinationId === undefined) {
    throw new ContractError("invalid_request");
  }

  const current = await readRepo(repoId);
  if (!current || current.workspace_id !== ctx.workspaceId) throw new ContractError("not_found");

  const sets = ["updated_at = :now"];
  const removes: string[] = [];
  const values: Record<string, unknown> = { ":ws": ctx.workspaceId, ":now": new Date(nowMs).toISOString() };
  let condition = "workspace_id = :ws";
  const items: TxItem[] = [];

  if (patch.watchedBranch !== undefined) {
    sets.push("watched_branch = :branch");
    values[":branch"] = patch.watchedBranch;
  }

  const activating = patch.isActive === true && current.is_active !== true;
  const deactivating = patch.isActive === false && current.is_active === true;
  if (activating || deactivating) {
    sets.push("is_active = :active");
    values[":active"] = patch.isActive;
    values[":was"] = current.is_active === true;
    condition += " AND is_active = :was";
  }

  if (patch.destinationId === null) {
    removes.push("discord_destination_id", "discord_webhook_url");
  } else if (patch.destinationId !== undefined) {
    sets.push("discord_destination_id = :dest");
    values[":dest"] = patch.destinationId;
    removes.push("discord_webhook_url");
  }

  items.push({
    Update: {
      TableName: tableName(),
      Key: tenantKeys.repo(repoId),
      UpdateExpression: `SET ${sets.join(", ")}` + (removes.length ? ` REMOVE ${removes.join(", ")}` : ""),
      ConditionExpression: condition,
      ExpressionAttributeValues: values,
    },
  });
  if (activating) items.push(repoSlot(ctx, 1), installationCheck(ctx, current.installation_id));
  if (deactivating) items.push(repoSlot(ctx, -1));
  const destIndex = items.length;
  if (typeof patch.destinationId === "string") items.push(destinationCheck(ctx, patch.destinationId));

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    const reasons = cancellationReasons(error);
    if (reasons[0]?.code === "ConditionalCheckFailed") throw new ContractError("not_found"); // changed concurrently
    if (activating && reasons[1]?.code === "ConditionalCheckFailed") {
      throw new ContractError(reasons[1].item?.status === "active" ? "repo_limit_reached" : "not_found");
    }
    if (activating && reasons[2]?.code === "ConditionalCheckFailed") throw new ContractError("not_installation_owner");
    if (typeof patch.destinationId === "string" && reasons[destIndex]?.code === "ConditionalCheckFailed") {
      throw await destinationFailure(ctx, patch.destinationId);
    }
    throw error;
  }
  return toRecord((await readRepo(repoId))!);
}

export async function getRepo(ctx: WorkspaceContext, repoId: string): Promise<RepoRecord | null> {
  if (!isValidId("githubId", repoId)) return null;
  const item = await readRepo(repoId);
  return item && item.workspace_id === ctx.workspaceId ? toRecord(item) : null;
}

export async function listRepos(ctx: WorkspaceContext, page: PageRequest): Promise<Page<RepoRecord>> {
  const gsi = tenantGsiKeys.repos(ctx.workspaceId);
  const startKey = decodeCursor(ctx.workspaceId, page.cursor, (k) => k.GSI1PK === gsi && k.PK?.startsWith("REPO#") && k.SK === "CONFIG");
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
  const items = ((out.Items ?? []) as TenantRepoConfigItem[]).filter((i) => i.workspace_id === ctx.workspaceId);
  return { items: items.map(toRecord), nextCursor: encodeCursor(ctx.workspaceId, out.LastEvaluatedKey) };
}
