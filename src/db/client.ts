/**
 * DynamoDB DocumentClient singleton.
 *
 * CRITICAL: Initialized OUTSIDE the Lambda handler so it is reused
 * across warm invocations. This avoids per-request TCP handshake overhead.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { getEnv } from "../config/env";

let _rawClient: DynamoDBClient | undefined;
let _ddb: DynamoDBDocumentClient | undefined;

export function getDdbDocClient(): DynamoDBDocumentClient {
  if (!_ddb) {
    const env = getEnv();
    _rawClient = new DynamoDBClient({
      region: env.AWS_REGION,
      // Only set endpoint for local DynamoDB development
      ...(env.DYNAMODB_ENDPOINT ? { endpoint: env.DYNAMODB_ENDPOINT } : {}),
      // Retry configuration for transient failures
      maxAttempts: 3,
    });

    _ddb = DynamoDBDocumentClient.from(_rawClient, {
      marshallOptions: {
        removeUndefinedValues: true,
        convertEmptyValues: false,
      },
      unmarshallOptions: {
        wrapNumbers: false,
      },
    });
  }
  return _ddb;
}

export function destroyClient(): void {
  if (_rawClient) {
    _rawClient.destroy();
    _rawClient = undefined;
    _ddb = undefined;
  }
}

/**
 * Lazy DocumentClient proxy. Avoids opening network sockets on file import,
 * initializing only on first actual operation.
 */
export const ddb = new Proxy({} as DynamoDBDocumentClient, {
  get(_target, prop) {
    const client = getDdbDocClient();
    const val = Reflect.get(client, prop);
    return typeof val === "function" ? val.bind(client) : val;
  },
});
