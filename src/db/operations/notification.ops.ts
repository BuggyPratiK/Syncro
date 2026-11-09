/**
 * DynamoDB operations for notification log items.
 */

import { PutCommand, UpdateCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { ddb } from "../client";
import { tableName, keys, buildNotificationId } from "../table";
import { NotificationItem } from "../../types/dynamodb.types";

/**
 * Creates or idempotently initializes a notification record with a deterministic identity.
 * Returns the notificationId (the deterministic sort key component).
 *
 * Uses conditional write to guarantee atomic, collision-free record creation.
 * If record already exists (e.g. on a delivery retry):
 * - If not already "sent", it updates to "pending", preserves created_at, and increments retry_count.
 * - If already "sent", it preserves the successful sent state idempotently.
 */
export async function createNotificationRecord(
  githubRepoId: string,
  deliveryId: string,
  channel: string,
  destinationId?: string,
): Promise<string> {
  const notificationId = buildNotificationId(deliveryId, channel, destinationId);
  const now = new Date().toISOString();
  const itemKeys = keys.notification(githubRepoId, notificationId);

  const item: NotificationItem = {
    ...itemKeys,
    delivery_id: deliveryId,
    channel,
    ...(destinationId ? { destination_id: destinationId } : {}),
    status: "pending",
    created_at: now,
    retry_count: 0,
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName(),
        Item: item,
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
    return notificationId;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      // Record already exists for this deterministic key (retry or re-attempt).
      // Idempotently update to pending and increment retry_count, unless already sent.
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: tableName(),
            Key: itemKeys,
            UpdateExpression:
              "SET #status = :pending, updated_at = :now ADD retry_count :inc",
            ConditionExpression: "attribute_not_exists(PK) OR #status <> :sent",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":pending": "pending",
              ":now": now,
              ":inc": 1,
              ":sent": "sent",
            },
          }),
        );
      } catch (updateError) {
        if (updateError instanceof ConditionalCheckFailedException) {
          // Already sent — preserve successful sent status idempotently
          return notificationId;
        }
        throw updateError;
      }
      return notificationId;
    }
    throw error;
  }
}

/**
 * Marks a notification as successfully sent.
 */
export async function markNotificationSent(
  githubRepoId: string,
  notificationId: string,
  messageId?: string,
): Promise<void> {
  const now = new Date().toISOString();
  await ddb.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: keys.notification(githubRepoId, notificationId),
      UpdateExpression:
        "SET #status = :status, sent_at = :sentAt, updated_at = :updatedAt" +
        (messageId ? ", message_id = :messageId" : ""),
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "sent",
        ":sentAt": now,
        ":updatedAt": now,
        ...(messageId ? { ":messageId": messageId } : {}),
      },
    }),
  );
}

/**
 * Marks a notification as failed.
 */
export async function markNotificationFailed(
  githubRepoId: string,
  notificationId: string,
  errorMessage: string,
  retryCount?: number,
): Promise<void> {
  const now = new Date().toISOString();
  await ddb.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: keys.notification(githubRepoId, notificationId),
      UpdateExpression:
        "SET #status = :status, failed_at = :failedAt, updated_at = :updatedAt, error_message = :error" +
        (retryCount !== undefined ? ", retry_count = :retries" : ""),
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "failed",
        ":failedAt": now,
        ":updatedAt": now,
        ":error": errorMessage,
        ...(retryCount !== undefined ? { ":retries": retryCount } : {}),
      },
    }),
  );
}

/**
 * Retrieves a notification record by repo ID and notification ID.
 */
export async function getNotificationRecord(
  githubRepoId: string,
  notificationId: string,
): Promise<NotificationItem | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName: tableName(),
      Key: keys.notification(githubRepoId, notificationId),
    }),
  );
  return result.Item as NotificationItem | undefined;
}
