/**
 * DynamoDB DocumentClient singleton.
 *
 * CRITICAL: Initialized OUTSIDE the Lambda handler so it is reused
 * across warm invocations. This avoids per-request TCP handshake overhead.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { getEnv } from "../config/env";

function createClient(): DynamoDBDocumentClient {
  const env = getEnv();

  const rawClient = new DynamoDBClient({
    region: env.AWS_REGION,
    // Only set endpoint for local DynamoDB development
    ...(env.DYNAMODB_ENDPOINT ? { endpoint: env.DYNAMODB_ENDPOINT } : {}),
    // Retry configuration for transient failures
    maxAttempts: 3,
  });

  return DynamoDBDocumentClient.from(rawClient, {
    marshallOptions: {
      removeUndefinedValues: true, // Don't store undefined as null
      convertEmptyValues: false,
    },
    unmarshallOptions: {
      wrapNumbers: false,
    },
  });
}

// Module-level singleton — reused across warm Lambda invocations
export const ddb = createClient();
