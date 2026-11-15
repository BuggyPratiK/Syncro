/**
 * Fails fast with a clear message when DynamoDB Local is not running.
 */

import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";

export default async function globalSetup(): Promise<void> {
  const endpoint = process.env.DDB_LOCAL_ENDPOINT ?? "http://localhost:8000";
  // Never contact anything but a local DynamoDB, not even to probe it.
  const host = new URL(endpoint).hostname;
  if (!["localhost", "127.0.0.1", "dynamodb"].includes(host)) {
    throw new Error(`Refusing to run DynamoDB tests against a non-local endpoint: ${host}`);
  }
  const client = new DynamoDBClient({
    endpoint,
    region: "ap-southeast-2",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
    maxAttempts: 1,
  });
  try {
    await client.send(new ListTablesCommand({ Limit: 1 }), { abortSignal: AbortSignal.timeout(5000) });
  } catch {
    throw new Error(
      `DynamoDB Local is not reachable at ${endpoint}. Start it with "npm run local:dynamo" ` +
        `(Docker) or set DDB_LOCAL_ENDPOINT.`,
    );
  } finally {
    client.destroy();
  }
}
