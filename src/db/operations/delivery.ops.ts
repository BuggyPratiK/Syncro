/**
 * DynamoDB operations for delivery deduplication and lifecycle items.
 */

import { UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { ddb } from "../client";
import { tableName, keys } from "../table";
import { DeliveryItem } from "../../types/dynamodb.types";
import { ttlInDays } from "../../utils/format";

/**
 * Default lease duration for active webhook processing: 60 seconds.
 * Since Lambda timeout is 15 seconds, a 60-second lease gives ample time
 * for normal execution while allowing safe recovery if the Lambda execution
 * crashes, is abruptly killed, or times out.
 */
export const DEFAULT_LEASE_DURATION_MS = 60_000;

/**
 * Atomically claims a delivery for processing.
 *
 * Safe and recoverable states:
 * - Brand new delivery: attribute_not_exists(PK) -> claimed
 * - Failed delivery: #status = :failed -> re-claimed for safe recovery
 * - Stale processing delivery: #status = :processing AND lease_expires_at < :nowEpochMs -> re-claimed
 *
 * Unclaimable states (returns false):
 * - Already "processed": guarantees deduplication against GitHub retries
 * - Already "ignored": guarantees deduplication for filtered/unsupported events
 * - Currently "processing" with an active, unexpired lease: prevents concurrent duplicate processors
 */
export async function claimDelivery(
  deliveryId: string,
  githubRepoId: string,
  eventType: string,
  leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
): Promise<boolean> {
  const itemKeys = keys.delivery(deliveryId);
  const now = new Date();
  const nowIso = now.toISOString();
  const nowEpochMs = now.getTime();
  const leaseExpiresAt = nowEpochMs + leaseDurationMs;
  const ttl = ttlInDays(30);

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: itemKeys,
        UpdateExpression:
          "SET #status = :processing, github_repo_id = :repoId, event_type = :eventType, " +
          "last_attempt_at = :nowIso, lease_expires_at = :leaseExpires, " +
          "received_at = if_not_exists(received_at, :nowIso), #ttl = if_not_exists(#ttl, :ttl) " +
          "ADD attempt_count :inc",
        ConditionExpression:
          "attribute_not_exists(PK) OR #status = :failed OR (#status = :processing AND lease_expires_at < :nowEpochMs)",
        ExpressionAttributeNames: {
          "#status": "status",
          "#ttl": "ttl",
        },
        ExpressionAttributeValues: {
          ":processing": "processing",
          ":repoId": githubRepoId,
          ":eventType": eventType,
          ":nowIso": nowIso,
          ":leaseExpires": leaseExpiresAt,
          ":nowEpochMs": nowEpochMs,
          ":failed": "failed",
          ":ttl": ttl,
          ":inc": 1,
        },
      }),
    );
    return true; // Successfully claimed or re-claimed
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return false; // Already processed, ignored, or active lease held by another processor
    }
    throw error;
  }
}

/**
 * Marks a delivery as successfully processed.
 */
export async function markDeliveryProcessed(deliveryId: string): Promise<void> {
  const itemKeys = keys.delivery(deliveryId);
  await ddb.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: itemKeys,
      UpdateExpression: "SET #status = :status, processed_at = :processedAt",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "processed",
        ":processedAt": new Date().toISOString(),
      },
    }),
  );
}

/**
 * Marks a delivery as failed, recording the error reason so it can be recovered or audited.
 */
export async function markDeliveryFailed(
  deliveryId: string,
  reason: string,
): Promise<void> {
  const itemKeys = keys.delivery(deliveryId);
  await ddb.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: itemKeys,
      UpdateExpression:
        "SET #status = :status, processed_at = :processedAt, error_message = :error",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "failed",
        ":processedAt": new Date().toISOString(),
        ":error": reason,
      },
    }),
  );
}

/**
 * Marks a delivery as intentionally ignored (e.g. unsupported event type, unmonitored branch, inactive repo).
 * This terminates the "processing" lease and prevents duplicate processing of future retries.
 */
export async function markDeliveryIgnored(
  deliveryId: string,
  reason?: string,
): Promise<void> {
  const itemKeys = keys.delivery(deliveryId);
  await ddb.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: itemKeys,
      UpdateExpression:
        "SET #status = :status, processed_at = :processedAt" +
        (reason ? ", error_message = :reason" : ""),
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "ignored",
        ":processedAt": new Date().toISOString(),
        ...(reason ? { ":reason": reason } : {}),
      },
    }),
  );
}

/**
 * Retrieves a delivery item by delivery ID.
 */
export async function getDelivery(
  deliveryId: string,
): Promise<DeliveryItem | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName(),
      Key: keys.delivery(deliveryId),
    }),
  );
  return result.Item as DeliveryItem | undefined;
}
