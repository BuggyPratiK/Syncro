/**
 * DynamoDB operations for notification log items.
 */

import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../client";
import { tableName, keys } from "../table";
import { NotificationItem } from "../../types/dynamodb.types";

/**
 * Creates a notification record with "pending" status before sending.
 */
export async function createNotificationRecord(
  githubRepoId: string,
  deliveryId: string,
  channel: string,
): Promise<string> {
  const timestamp = new Date().toISOString();
  const item: NotificationItem = {
    ...keys.notification(githubRepoId, timestamp),
    delivery_id: deliveryId,
    channel,
    status: "pending",
    retry_count: 0,
  };

  await ddb.send(new PutCommand({ TableName: tableName(), Item: item }));
  return timestamp; // Return timestamp as the sort key for subsequent updates
}

/**
 * Updates the notification record to "sent" status.
 */
export async function markNotificationSent(
  githubRepoId: string,
  timestamp: string,
  messageId?: string,
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: keys.notification(githubRepoId, timestamp),
      UpdateExpression:
        "SET #status = :status, sent_at = :sentAt" +
        (messageId ? ", message_id = :messageId" : ""),
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "sent",
        ":sentAt": new Date().toISOString(),
        ...(messageId ? { ":messageId": messageId } : {}),
      },
    }),
  );
}

/**
 * Updates the notification record to "failed" status.
 */
export async function markNotificationFailed(
  githubRepoId: string,
  timestamp: string,
  errorMessage: string,
  retryCount = 0,
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: keys.notification(githubRepoId, timestamp),
      UpdateExpression:
        "SET #status = :status, failed_at = :failedAt, error_message = :error, retry_count = :retries",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "failed",
        ":failedAt": new Date().toISOString(),
        ":error": errorMessage,
        ":retries": retryCount,
      },
    }),
  );
}
