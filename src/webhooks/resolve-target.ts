/**
 * Resolves which workspace (if any) a GitHub webhook delivery belongs to.
 *
 * A delivery is processed only when ALL of these hold:
 * 1. the repository is registered (`REPO#<id>/CONFIG`) AND owned by a
 *    workspace (`workspace_id`); records without a workspace are ignored as
 *    `repo_not_tenant`, never served from any older global configuration;
 * 2. the repository is active;
 * 3. the owning workspace is active (a suspended workspace is ignored);
 * 4. the payload's installation is the one the repository was registered
 *    under, and that installation is active and owned by the same workspace.
 *
 * The destination is looked up only inside the owning workspace's partition
 * (`WS#<ws>/DEST#<id>`). Whether it can actually receive notifications is
 * decided by the notification engine; a missing destination means zero
 * targets, never a fallback.
 */

import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db/client";
import { tableName, tenantKeys } from "../db/table";
import { isValidId } from "../contracts/ids";
import type { WebhookIgnoreReason } from "../contracts/errors";
import type {
  InstallationItem,
  TenantDestinationItem,
  TenantRepoConfigItem,
  WorkspaceItem,
} from "../types/tenant.types";

export interface WebhookTarget {
  repo: TenantRepoConfigItem;
  /** The repository's destination in its own workspace, if one is assigned and exists. */
  destination?: TenantDestinationItem;
}

export type ResolveResult = { ok: true; target: WebhookTarget } | { ok: false; reason: WebhookIgnoreReason };

async function get<T>(key: { PK: string; SK: string }): Promise<T | undefined> {
  const out = await ddb.send(new GetCommand({ TableName: tableName(), Key: key, ConsistentRead: true }));
  return out.Item as T | undefined;
}

export async function resolveWebhookTarget(
  githubRepoId: string,
  payloadInstallationId: number | undefined,
): Promise<ResolveResult> {
  if (!isValidId("githubId", githubRepoId)) return { ok: false, reason: "repo_not_found" };

  const repo = await get<TenantRepoConfigItem>(tenantKeys.repo(githubRepoId));
  if (!repo) return { ok: false, reason: "repo_not_found" };
  if (typeof repo.workspace_id !== "string" || !isValidId("workspaceId", repo.workspace_id)) {
    return { ok: false, reason: "repo_not_tenant" };
  }
  if (repo.is_active !== true) return { ok: false, reason: "repo_inactive" };

  const installationId = payloadInstallationId === undefined ? "" : String(payloadInstallationId);
  if (!isValidId("githubId", installationId) || installationId !== repo.installation_id) {
    return { ok: false, reason: "installation_mismatch" };
  }

  const destinationId = repo.discord_destination_id;
  const [workspace, installation, destination] = await Promise.all([
    get<WorkspaceItem>(tenantKeys.workspace(repo.workspace_id)),
    get<InstallationItem>(tenantKeys.installation(installationId)),
    destinationId && isValidId("destinationId", destinationId)
      ? get<TenantDestinationItem>(tenantKeys.destination(repo.workspace_id, destinationId))
      : Promise.resolve(undefined),
  ]);

  if (!workspace || workspace.status !== "active") return { ok: false, reason: "workspace_not_active" };
  if (!installation || installation.status !== "active" || installation.workspace_id !== repo.workspace_id) {
    return { ok: false, reason: "installation_not_active" };
  }

  const ownDestination = destination && destination.workspace_id === repo.workspace_id ? destination : undefined;
  return { ok: true, target: { repo, ...(ownDestination ? { destination: ownDestination } : {}) } };
}
