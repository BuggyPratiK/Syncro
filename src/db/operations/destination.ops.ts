/**
 * DynamoDB operations for Discord destination entities.
 */

import { randomUUID } from "crypto";
import {
  PutCommand,
  GetCommand,
  UpdateCommand,
  QueryCommand,
  QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { ddb } from "../client";
import { tableName, keys, gsiKeys } from "../table";
import {
  DiscordDestinationItem,
  CreateDestinationInput,
  UpdateDestinationInput,
  PaginationParams,
  PaginatedResult,
} from "../../types/dynamodb.types";
import { validateDiscordWebhookUrl } from "../../utils/url-validator";
import { encodeNextToken, decodeNextToken } from "../../utils/pagination";

/**
 * Creates a new Discord destination item in DynamoDB.
 * Throws an error if URL validation fails or if the destination already exists.
 */
export async function createDiscordDestination(
  input: CreateDestinationInput,
): Promise<DiscordDestinationItem> {
  const validation = validateDiscordWebhookUrl(input.discord_webhook_url);
  if (!validation.valid || !validation.cleanedUrl) {
    throw new Error(validation.error ?? "Invalid Discord webhook URL");
  }

  const destinationId = input.destination_id ?? randomUUID();
  const now = new Date().toISOString();

  const item: DiscordDestinationItem = {
    ...keys.destination(destinationId),
    destination_id: destinationId,
    provider: "discord",
    display_name: input.display_name.trim(),
    discord_webhook_url: validation.cleanedUrl,
    is_active: true,
    GSI1PK: gsiKeys.allDestinations(),
    created_at: now,
    updated_at: now,
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName(),
        Item: item,
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
    return item;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      throw new Error(`Discord destination with ID '${destinationId}' already exists`);
    }
    throw error;
  }
}

/**
 * Retrieves a Discord destination by its ID.
 * Returns null if not found.
 */
export async function getDiscordDestination(
  destinationId: string,
): Promise<DiscordDestinationItem | null> {
  if (!destinationId || typeof destinationId !== "string") {
    return null;
  }

  const result = await ddb.send(
    new GetCommand({
      TableName: tableName(),
      Key: keys.destination(destinationId),
    }),
  );

  if (!result.Item) return null;
  return result.Item as DiscordDestinationItem;
}

/**
 * Lists Discord destinations using the type-index GSI.
 * Supports pagination via LastEvaluatedKey / nextToken.
 */
export async function listDiscordDestinations(
  params?: PaginationParams,
): Promise<PaginatedResult<DiscordDestinationItem>> {
  const exclusiveStartKey = decodeNextToken(params?.nextToken);
  const limit = params?.limit && params.limit > 0 ? params.limit : undefined;

  const queryInput: QueryCommandInput = {
    TableName: tableName(),
    IndexName: "type-index",
    KeyConditionExpression: "GSI1PK = :gsi1pk",
    ExpressionAttributeValues: {
      ":gsi1pk": gsiKeys.allDestinations(),
    },
    ScanIndexForward: false, // Newest first
    ...(limit ? { Limit: limit } : {}),
    ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
  };

  if (params?.activeOnly) {
    queryInput.FilterExpression = "#active = :isActive";
    queryInput.ExpressionAttributeNames = { "#active": "is_active" };
    queryInput.ExpressionAttributeValues = {
      ...queryInput.ExpressionAttributeValues,
      ":isActive": true,
    };
  }

  const result = await ddb.send(new QueryCommand(queryInput));
  const items = (result.Items ?? []) as DiscordDestinationItem[];

  return {
    items,
    nextToken: encodeNextToken(result.LastEvaluatedKey),
  };
}

/**
 * Updates mutable fields of a Discord destination.
 * Allowlist: display_name, discord_webhook_url, is_active.
 * Prevents mutation of destination_id, provider, created_at, PK, SK, GSI1PK.
 */
export async function updateDiscordDestination(
  destinationId: string,
  updates: UpdateDestinationInput,
): Promise<DiscordDestinationItem> {
  const updateParts: string[] = [];
  const exprNames: Record<string, string> = {};
  const exprValues: Record<string, unknown> = {};

  if (updates.display_name !== undefined) {
    updateParts.push("#name = :name");
    exprNames["#name"] = "display_name";
    exprValues[":name"] = updates.display_name.trim();
  }

  if (updates.discord_webhook_url !== undefined) {
    const validation = validateDiscordWebhookUrl(updates.discord_webhook_url);
    if (!validation.valid || !validation.cleanedUrl) {
      throw new Error(validation.error ?? "Invalid Discord webhook URL");
    }
    updateParts.push("#url = :url");
    exprNames["#url"] = "discord_webhook_url";
    exprValues[":url"] = validation.cleanedUrl;
  }

  if (updates.is_active !== undefined) {
    updateParts.push("#active = :active");
    exprNames["#active"] = "is_active";
    exprValues[":active"] = Boolean(updates.is_active);
  }

  const now = new Date().toISOString();
  updateParts.push("#updatedAt = :now");
  exprNames["#updatedAt"] = "updated_at";
  exprValues[":now"] = now;

  try {
    const result = await ddb.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: keys.destination(destinationId),
        UpdateExpression: `SET ${updateParts.join(", ")}`,
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeNames: exprNames,
        ExpressionAttributeValues: exprValues,
        ReturnValues: "ALL_NEW",
      }),
    );

    return result.Attributes as DiscordDestinationItem;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      throw new Error(`Discord destination '${destinationId}' not found`);
    }
    throw error;
  }
}

/**
 * Soft-deactivates a Discord destination.
 * Preserves the record and its configuration history while preventing new dispatches.
 */
export async function deactivateDiscordDestination(
  destinationId: string,
): Promise<DiscordDestinationItem> {
  return updateDiscordDestination(destinationId, { is_active: false });
}
