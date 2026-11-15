/**
 * Workspace context: the proof, required by every workspace-scoped operation,
 * that a user is an active member of an active workspace.
 *
 * `resolveWorkspaceContext` is the ONLY place a `WorkspaceContext` is created.
 * It reads the membership (`WS#<ws>/MEMBER#<uid>`) and the workspace
 * (`WS#<ws>/META`) together with a strongly consistent read, so a removal or
 * suspension takes effect on the very next request. Anything missing,
 * inactive, malformed or unreadable resolves to `null` (fail closed); callers
 * answer "not found" so workspace existence is never revealed.
 */

import { BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db/client";
import { tableName, tenantKeys } from "../db/table";
import { isValidId } from "../contracts/ids";
import { ROLES, roleSatisfies, type Role } from "../contracts/roles";
import { ContractError } from "../contracts/errors";
import type { WorkspaceContext } from "../contracts/data-ops";
import type { WorkspaceItem, WorkspaceMemberItem } from "../types/tenant.types";
import { logger } from "../utils/logger";

type Key = { PK: string; SK: string };

/** Consistent batch read of the given keys; retries unprocessed keys once. */
async function consistentBatchGet(keys: Key[]): Promise<Array<Record<string, unknown>> | null> {
  const table = tableName();
  let pending: Key[] = keys;
  const found: Array<Record<string, unknown>> = [];

  for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
    const out = await ddb.send(
      new BatchGetCommand({
        RequestItems: { [table]: { Keys: pending, ConsistentRead: true } },
      }),
    );
    found.push(...((out.Responses?.[table] ?? []) as Array<Record<string, unknown>>));
    pending = (out.UnprocessedKeys?.[table]?.Keys ?? []) as Key[];
  }

  // Still unprocessed after one retry: treat as unreadable rather than guess.
  return pending.length > 0 ? null : found;
}

export async function resolveWorkspaceContext(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceContext | null> {
  if (!isValidId("userId", userId) || !isValidId("workspaceId", workspaceId)) return null;

  const memberKey = tenantKeys.workspaceMember(workspaceId, userId);
  const workspaceKey = tenantKeys.workspace(workspaceId);

  let items: Array<Record<string, unknown>> | null;
  try {
    items = await consistentBatchGet([memberKey, workspaceKey]);
  } catch (error) {
    logger.error("Workspace context read failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
  if (!items) return null;

  const member = items.find((i) => i.SK === memberKey.SK) as WorkspaceMemberItem | undefined;
  const workspace = items.find((i) => i.SK === workspaceKey.SK) as WorkspaceItem | undefined;

  if (!member || member.status !== "active" || member.user_id !== userId) return null;
  if (!workspace || workspace.status !== "active" || workspace.workspace_id !== workspaceId) return null;
  if (!(ROLES as readonly string[]).includes(member.role)) return null;

  return { userId, workspaceId, role: member.role } as WorkspaceContext;
}

/**
 * Throws `ContractError("forbidden")` unless the context's role meets
 * `minimum`. Use after `resolveWorkspaceContext` (which already guarantees an
 * active member of an active workspace).
 */
export function requireRole(ctx: WorkspaceContext, minimum: Role): void {
  if (!roleSatisfies(ctx.role, minimum)) throw new ContractError("forbidden");
}
