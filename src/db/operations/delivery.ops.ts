/**
 * DynamoDB operations for delivery deduplication items.
 */

import { UpdateCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { ddb } from "../client";
import { tableName, keys } from "../table";
import { DeliveryItem } from "../../types/dynamodb.types";
import { ttlInDays } from "../../utils/format";

/**
 * Atomically creates a delivery record if it doesn't already exist.
 * Returns true if this is a NEW delivery (should be processed).
 * Returns false if the delivery was already seen (duplicate - skip processing).
 *
 * Uses DynamoDB Conditional PutItem: attribute_not_exists(PK)
 * This is atomic - safe against concurrent duplicate deliveries from GitHub.
 */
export async function claimDelivery(
  deliveryId: string,
  githubRepoId: string,
  eventType: string,
): Promise<boolean> {
  const itemKeys = keys.delivery(deliveryId);

  const item: DeliveryItem = {
    ...itemKeys,
    github_repo_id: githubRepoId,
    event_type: eventType,
    status: "processing",
    received_at: new Date().toISOString(),
    ttl: ttlInDays(30),
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName(),
        Item: item,
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
    return true; // New delivery - proceed with processing
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return false; // Already processed - skip
    }
    throw error; // Unexpected error - propagate
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
 * Marks a delivery as failed.
 */
export async function markDeliveryFailed(deliveryId: string, reason: string): Promise<void> {
  const itemKeys = keys.delivery(deliveryId);
  await ddb.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: itemKeys,
      UpdateExpression: "SET #status = :status, processed_at = :processedAt, error_message = :error",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "failed",
        ":processedAt": new Date().toISOString(),
        ":error": reason,
      },
    }),
  );
}
