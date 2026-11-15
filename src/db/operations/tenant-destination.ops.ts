/**
 * Discord destinations owned by workspaces (`WS#<ws>/DEST#<uuid>`).
 *
 * The webhook URL itself never touches DynamoDB, logs or API responses: it
 * goes only to SSM through a `DestinationSecretWriter`, under a parameter name
 * derived here from the caller's workspace and the destination ID. DynamoDB
 * keeps `secret_ref {name, version}` plus the non-secret webhook ID for a
 * masked display.
 *
 * SSM and DynamoDB cannot share a transaction, so creation runs in steps:
 * 1. one transaction reserves capacity and writes the item as `pending_secret`:
 *    item absent; workspace active with fewer than `activeDestinations`;
 *    service-wide parameter count below the ceiling;
 * 2. the URL is written to SSM (never overwriting an existing parameter);
 * 3. the item becomes `active` with the parameter version.
 * If step 2 fails, step 1 is undone (item deleted, both counters restored). If
 * step 3 fails, the item and the workspace slot are released but the global
 * count is kept, because the parameter now exists and still uses quota.
 * A `pending_secret` destination never receives notifications.
 *
 * Deactivation keeps the parameter (deleting parameters is not supported yet),
 * so it frees a workspace slot but not service-wide capacity.
 *
 * PROVISIONAL: these operations and their types may still change once the
 * IAM permission tests for the writer and reader roles are in place.
 */

import { randomUUID } from "crypto";
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../client";
import { DEST_SK_PREFIX, tableName, tenantKeys } from "../table";
import { decodeCursor, encodeCursor } from "../cursor";
import { getBaseEnv } from "../../config/env";
import { REQUEST_LIMITS, SSM_DESTINATION_PARAMS, WORKSPACE_LIMITS } from "../../contracts/constants";
import { ContractError } from "../../contracts/errors";
import { isValidId } from "../../contracts/ids";
import { fieldSchemas } from "../../contracts/schemas";
import type {
  DestinationRecord,
  DestinationSecretWriter,
  PageRequest,
  WorkspaceContext,
} from "../../contracts/data-ops";
import type { Page } from "../../contracts/dto";
import type { TenantDestinationItem } from "../../types/tenant.types";
import { deriveDestinationParamName } from "../../secrets/param-names";
import { validateDiscordWebhookUrl } from "../../utils/url-validator";
import { requireRole } from "../../tenancy/context";
import { cancellationReasons, isConditionalCheckFailed } from "../dynamo-errors";
import { logger } from "../../utils/logger";

type TxItem = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>[number];

/** True when a destination may receive notifications (never while `pending_secret`). */
export function isDeliverableDestination(item: Pick<TenantDestinationItem, "status" | "secret_ref"> | undefined): boolean {
  return item?.status === "active" && item.secret_ref !== undefined;
}

function toRecord(item: TenantDestinationItem): DestinationRecord {
  return {
    destinationId: item.destination_id,
    workspaceId: item.workspace_id,
    provider: "discord",
    displayName: item.display_name,
    status: item.status,
    webhookId: item.webhook_id,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

function parseDisplayName(raw: unknown): string {
  const parsed = fieldSchemas.displayName.safeParse(raw);
  if (!parsed.success) throw new ContractError("invalid_request");
  return parsed.data;
}

/** Validates a Discord webhook URL; returns the canonical URL and its non-secret webhook ID. */
function parseWebhookUrl(raw: unknown): { url: string; webhookId: string } {
  if (typeof raw !== "string" || raw.length > REQUEST_LIMITS.webhookUrlMax) throw new ContractError("invalid_webhook_url");
  const result = validateDiscordWebhookUrl(raw);
  const match = result.cleanedUrl?.match(/\/api\/webhooks\/(\d+)\//);
  if (!result.valid || !result.cleanedUrl || !match) throw new ContractError("invalid_webhook_url");
  return { url: result.cleanedUrl, webhookId: match[1] };
}

function paramName(ctx: WorkspaceContext, destinationId: string): string {
  return deriveDestinationParamName(ctx.workspaceId, destinationId, getBaseEnv().SSM_PARAM_PREFIX);
}

async function readDestination(ctx: WorkspaceContext, destinationId: string): Promise<TenantDestinationItem | undefined> {
  const out = await ddb.send(
    new GetCommand({ TableName: tableName(), Key: tenantKeys.destination(ctx.workspaceId, destinationId), ConsistentRead: true }),
  );
  const item = out.Item as TenantDestinationItem | undefined;
  return item && item.workspace_id === ctx.workspaceId ? item : undefined;
}

const destinationSlot = (ctx: WorkspaceContext, delta: 1 | -1): TxItem => ({
  Update: {
    TableName: tableName(),
    Key: tenantKeys.workspace(ctx.workspaceId),
    UpdateExpression: "ADD active_destination_count :delta",
    ConditionExpression:
      delta === 1
        ? "#status = :active AND (attribute_not_exists(active_destination_count) OR active_destination_count < :max)"
        : "active_destination_count > :zero",
    ...(delta === 1 ? { ExpressionAttributeNames: { "#status": "status" } } : {}),
    ExpressionAttributeValues:
      delta === 1
        ? { ":delta": 1, ":active": "active", ":max": WORKSPACE_LIMITS.activeDestinations }
        : { ":delta": -1, ":zero": 0 },
    ReturnValuesOnConditionCheckFailure: "ALL_OLD",
  },
});

const globalCounter = (delta: 1 | -1): TxItem => ({
  Update: {
    TableName: tableName(),
    Key: tenantKeys.ssmDestParamCounter(),
    UpdateExpression: "ADD #count :delta",
    ConditionExpression: delta === 1 ? "attribute_not_exists(#count) OR #count < :ceiling" : "#count > :zero",
    ExpressionAttributeNames: { "#count": "count" },
    ExpressionAttributeValues: delta === 1 ? { ":delta": 1, ":ceiling": SSM_DESTINATION_PARAMS.ceiling } : { ":delta": -1, ":zero": 0 },
  },
});

/** Undo step 1 (or release after a failed step 3). Never throws; logs on failure. */
async function release(ctx: WorkspaceContext, destinationId: string, alsoGlobal: boolean): Promise<void> {
  const items: TxItem[] = [
    {
      Delete: {
        TableName: tableName(),
        Key: tenantKeys.destination(ctx.workspaceId, destinationId),
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":pending": "pending_secret" },
      },
    },
    destinationSlot(ctx, -1),
  ];
  if (alsoGlobal) items.push(globalCounter(-1));
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: items }));
  } catch {
    // The item stays `pending_secret`: never a delivery target. Counters may be
    // overstated by one until an operator corrects them.
    logger.error("Destination create compensation failed", { destinationId });
  }
}

export async function createDestination(
  ctx: WorkspaceContext,
  input: { displayName: string; webhookUrl: string },
  writer: DestinationSecretWriter,
  nowMs: number = Date.now(),
): Promise<DestinationRecord> {
  requireRole(ctx, "owner");
  const displayName = parseDisplayName(input.displayName);
  const { url, webhookId } = parseWebhookUrl(input.webhookUrl);

  const destinationId = randomUUID();
  const name = paramName(ctx, destinationId);
  const now = new Date(nowMs).toISOString();
  const item: TenantDestinationItem = {
    ...tenantKeys.destination(ctx.workspaceId, destinationId),
    destination_id: destinationId,
    workspace_id: ctx.workspaceId,
    provider: "discord",
    display_name: displayName,
    status: "pending_secret",
    webhook_id: webhookId,
    created_at: now,
    updated_at: now,
  };

  // Step 1: reserve.
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: tableName(), Item: item, ConditionExpression: "attribute_not_exists(PK)" } },
          destinationSlot(ctx, 1),
          globalCounter(1),
        ],
      }),
    );
  } catch (error) {
    const reasons = cancellationReasons(error);
    if (reasons[1]?.code === "ConditionalCheckFailed") {
      throw new ContractError(reasons[1].item?.status === "active" ? "destination_limit_reached" : "not_found");
    }
    if (reasons[2]?.code === "ConditionalCheckFailed") {
      logger.error("Service-wide destination capacity reached");
      throw new ContractError("destination_capacity_reached");
    }
    throw error;
  }

  // Step 2: store the URL.
  let version: number;
  try {
    ({ version } = await writer.put(name, url, { overwrite: false }));
  } catch (error) {
    await release(ctx, destinationId, true);
    throw error instanceof ContractError ? error : new ContractError("secret_unavailable");
  }

  // Step 3: activate.
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: tenantKeys.destination(ctx.workspaceId, destinationId),
        UpdateExpression: "SET #status = :active, secret_ref = :ref, updated_at = :now",
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":active": "active", ":pending": "pending_secret", ":ref": { name, version }, ":now": now },
      }),
    );
  } catch {
    await release(ctx, destinationId, false);
    throw new ContractError("secret_unavailable");
  }

  return toRecord({ ...item, status: "active", secret_ref: { name, version } });
}

export async function updateDestination(
  ctx: WorkspaceContext,
  destinationId: string,
  patch: { displayName?: string; isActive?: boolean },
  nowMs: number = Date.now(),
): Promise<DestinationRecord> {
  requireRole(ctx, "owner");
  if (!isValidId("destinationId", destinationId)) throw new ContractError("not_found");
  if (patch.displayName === undefined && patch.isActive === undefined) throw new ContractError("invalid_request");
  if (patch.isActive !== undefined && typeof patch.isActive !== "boolean") throw new ContractError("invalid_request");
  const displayName = patch.displayName === undefined ? undefined : parseDisplayName(patch.displayName);

  const current = await readDestination(ctx, destinationId);
  if (!current) throw new ContractError("not_found");
  if (current.status === "pending_secret") throw new ContractError("destination_not_active");

  const activating = patch.isActive === true && current.status === "inactive";
  const deactivating = patch.isActive === false && current.status === "active";
  const sets = ["updated_at = :now"];
  const values: Record<string, unknown> = { ":now": new Date(nowMs).toISOString(), ":was": current.status };
  if (displayName !== undefined) {
    sets.push("display_name = :name");
    values[":name"] = displayName;
  }
  if (activating || deactivating) {
    sets.push("#status = :next");
    values[":next"] = activating ? "active" : "inactive";
  }

  const items: TxItem[] = [
    {
      Update: {
        TableName: tableName(),
        Key: tenantKeys.destination(ctx.workspaceId, destinationId),
        UpdateExpression: `SET ${sets.join(", ")}`,
        ConditionExpression: "#status = :was",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: values,
      },
    },
  ];
  if (activating) items.push(destinationSlot(ctx, 1));
  if (deactivating) items.push(destinationSlot(ctx, -1));

  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    const reasons = cancellationReasons(error);
    if (reasons[0]?.code === "ConditionalCheckFailed") throw new ContractError("not_found"); // changed concurrently
    if (activating && reasons[1]?.code === "ConditionalCheckFailed") {
      throw new ContractError(reasons[1].item?.status === "active" ? "destination_limit_reached" : "not_found");
    }
    throw error;
  }
  return toRecord((await readDestination(ctx, destinationId))!);
}

export async function replaceDestinationWebhook(
  ctx: WorkspaceContext,
  destinationId: string,
  webhookUrl: string,
  writer: DestinationSecretWriter,
  nowMs: number = Date.now(),
): Promise<DestinationRecord> {
  requireRole(ctx, "owner");
  if (!isValidId("destinationId", destinationId)) throw new ContractError("not_found");
  const { url, webhookId } = parseWebhookUrl(webhookUrl);

  const current = await readDestination(ctx, destinationId);
  if (!current) throw new ContractError("not_found");
  if (current.status !== "active") throw new ContractError("destination_not_active");
  const name = paramName(ctx, destinationId);
  if (current.secret_ref?.name !== name) {
    logger.error("Stored destination secret reference does not match its derived name", { destinationId });
    throw new ContractError("secret_unavailable");
  }

  const { version } = await writer.put(name, url, { overwrite: true });

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: tenantKeys.destination(ctx.workspaceId, destinationId),
        UpdateExpression: "SET secret_ref = :ref, webhook_id = :hook, updated_at = :now",
        ConditionExpression: "#status = :active AND secret_ref.#name = :name",
        ExpressionAttributeNames: { "#status": "status", "#name": "name" },
        ExpressionAttributeValues: {
          ":ref": { name, version },
          ":hook": webhookId,
          ":now": new Date(nowMs).toISOString(),
          ":active": "active",
          ":name": name,
        },
      }),
    );
  } catch (error) {
    // The new version exists but is not referenced: delivery keeps using the old one.
    if (isConditionalCheckFailed(error)) throw new ContractError("destination_not_active");
    throw new ContractError("secret_unavailable");
  }
  return toRecord((await readDestination(ctx, destinationId))!);
}

export async function getDestination(ctx: WorkspaceContext, destinationId: string): Promise<DestinationRecord | null> {
  if (!isValidId("destinationId", destinationId)) return null;
  const item = await readDestination(ctx, destinationId);
  return item ? toRecord(item) : null;
}

export async function listDestinations(ctx: WorkspaceContext, page: PageRequest): Promise<Page<DestinationRecord>> {
  const pk = tenantKeys.workspace(ctx.workspaceId).PK;
  const startKey = decodeCursor(ctx.workspaceId, page.cursor, (k) => k.PK === pk && k.SK?.startsWith(DEST_SK_PREFIX));
  const out = await ddb.send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :dest)",
      ExpressionAttributeValues: { ":pk": pk, ":dest": DEST_SK_PREFIX },
      Limit: page.limit,
      ExclusiveStartKey: startKey,
    }),
  );
  const items = (out.Items ?? []) as TenantDestinationItem[];
  return { items: items.map(toRecord), nextCursor: encodeCursor(ctx.workspaceId, out.LastEvaluatedKey) };
}
