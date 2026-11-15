/**
 * Delivery history (the ledger).
 *
 * A delivery appears in a workspace's history only once it has been stamped
 * for that workspace (processed or failed on the workspace delivery path).
 * Ignored deliveries are never stamped and never listed; deliveries from
 * before a repository belonged to a workspace stay invisible.
 *
 * Children (notifications and commits) are readable only through a delivery
 * stamped with the caller's workspace, and every child must itself carry the
 * same `workspace_id`. Access depends on the delivery's stamp, not on who owns
 * the repository today, so a workspace keeps its own history and never sees
 * another workspace's.
 */

import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../client";
import { keys, tableName, tenantGsiKeys } from "../table";
import { decodeCursor, encodeCursor } from "../cursor";
import type { PageRequest, WorkspaceContext } from "../../contracts/data-ops";
import type { DeliveryDto, DeliverySummaryDto, Page } from "../../contracts/dto";
import type { CommitItem, DeliveryItem, NotificationItem } from "../../types/dynamodb.types";
import type { DeliverySummaryAttribute } from "../../types/tenant.types";
import { sanitizeErrorForStorage } from "../../utils/redact";

/** Commit partitions grow over time; reading children scans at most this many pages. */
const MAX_COMMIT_PAGES = 5;

function deliveryIdOf(item: { PK: string }): string {
  return item.PK.slice("DELIVERY#".length);
}

function toSummaryDto(s: DeliverySummaryAttribute | undefined, fallbackEvent: string): DeliverySummaryDto {
  return {
    repoFullName: s?.repo_full_name ?? "",
    eventType: s?.event_type ?? fallbackEvent,
    ...(s?.branch !== undefined ? { branch: s.branch } : {}),
    ...(s?.action !== undefined ? { action: s.action } : {}),
    ...(s?.commit_count !== undefined ? { commitCount: s.commit_count } : {}),
    ...(s?.head_short_sha !== undefined ? { headShortSha: s.head_short_sha } : {}),
    ...(s?.pr_number !== undefined ? { prNumber: s.pr_number } : {}),
  };
}

function toDeliveryDto(item: DeliveryItem): DeliveryDto {
  return {
    deliveryId: deliveryIdOf(item),
    status: item.status as DeliveryDto["status"],
    receivedAt: item.received_at,
    ...(item.processed_at ? { processedAt: item.processed_at } : {}),
    summary: toSummaryDto(item.summary, item.event_type),
    // Stored text is already masked; masking again on read is a cheap second guard.
    ...(item.error_message ? { errorMessage: sanitizeErrorForStorage(item.error_message) } : {}),
  };
}

/** The workspace's ledger, newest first. Only processed or failed deliveries stamped for it. */
export async function listDeliveries(ctx: WorkspaceContext, page: PageRequest): Promise<Page<DeliveryDto>> {
  const gsi = tenantGsiKeys.deliveries(ctx.workspaceId);
  const startKey = decodeCursor(
    ctx.workspaceId,
    page.cursor,
    (k) => k.GSI1PK === gsi && k.PK?.startsWith("DELIVERY#") && k.SK === k.PK && typeof k.created_at === "string",
  );
  const out = await ddb.send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: "type-index",
      KeyConditionExpression: "GSI1PK = :gsi",
      ExpressionAttributeValues: { ":gsi": gsi },
      ScanIndexForward: false,
      Limit: page.limit,
      ExclusiveStartKey: startKey,
    }),
  );
  const items = ((out.Items ?? []) as DeliveryItem[]).filter(
    (d) => d.workspace_id === ctx.workspaceId && (d.status === "processed" || d.status === "failed"),
  );
  return { items: items.map(toDeliveryDto), nextCursor: encodeCursor(ctx.workspaceId, out.LastEvaluatedKey) };
}

export interface DeliveryChildren {
  notifications: Array<{
    channel: string;
    destinationId?: string;
    status: NotificationItem["status"];
    retryCount: number;
    sentAt?: string;
    failedAt?: string;
    errorMessage?: string;
  }>;
  commits: Array<{
    sha: string;
    shortSha: string;
    message: string;
    authorName: string;
    branch: string;
    additions: number;
    deletions: number;
    filesChanged: number;
    url: string;
    committedAt: string;
  }>;
}

/**
 * Notifications and commits of one delivery, or `null` when the delivery is
 * not stamped for the caller's workspace. Internal: no public route or DTO yet.
 */
export async function getDeliveryChildren(ctx: WorkspaceContext, deliveryId: string): Promise<DeliveryChildren | null> {
  if (typeof deliveryId !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(deliveryId)) return null;
  const out = await ddb.send(new GetCommand({ TableName: tableName(), Key: keys.delivery(deliveryId), ConsistentRead: true }));
  const delivery = out.Item as DeliveryItem | undefined;
  if (!delivery || delivery.workspace_id !== ctx.workspaceId) return null;
  if (delivery.status !== "processed" && delivery.status !== "failed") return null;

  const repoPk = `REPO#${delivery.github_repo_id}`;
  const notifOut = await ddb.send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": repoPk, ":prefix": `NOTIF#${deliveryId}#` },
    }),
  );
  const notifications = ((notifOut.Items ?? []) as NotificationItem[])
    .filter((n) => n.workspace_id === ctx.workspaceId)
    .map((n) => ({
      channel: n.channel,
      ...(n.destination_id ? { destinationId: n.destination_id } : {}),
      status: n.status,
      retryCount: n.retry_count,
      ...(n.sent_at ? { sentAt: n.sent_at } : {}),
      ...(n.failed_at ? { failedAt: n.failed_at } : {}),
      ...(n.error_message ? { errorMessage: sanitizeErrorForStorage(n.error_message) } : {}),
    }));

  const commits: DeliveryChildren["commits"] = [];
  let startKey: Record<string, unknown> | undefined;
  for (let pageNo = 0; pageNo < MAX_COMMIT_PAGES; pageNo++) {
    const page = await ddb.send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        FilterExpression: "delivery_id = :d AND workspace_id = :ws",
        ExpressionAttributeValues: { ":pk": repoPk, ":prefix": "COMMIT#", ":d": deliveryId, ":ws": ctx.workspaceId },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const c of (page.Items ?? []) as CommitItem[]) {
      commits.push({
        sha: c.sha,
        shortSha: c.short_sha,
        message: c.message,
        authorName: c.author_name,
        branch: c.branch,
        additions: c.additions,
        deletions: c.deletions,
        filesChanged: c.files_changed,
        url: c.github_url,
        committedAt: c.committed_at,
      });
    }
    startKey = page.LastEvaluatedKey;
    if (!startKey) break;
  }

  return { notifications, commits };
}
