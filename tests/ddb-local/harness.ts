/**
 * DynamoDB Local test harness.
 *
 * `createTestTable` creates this file's table with the same key schema, index
 * and TTL attribute as the CDK stack (infra/lib/syncro-stack.ts), so
 * conditional writes, transactions and `type-index` queries behave as in
 * production. `Scan` is used here for assertions only; application code
 * never scans.
 */

import {
  CreateTableCommand,
  type CreateTableCommandInput,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

function rawClient(): DynamoDBClient {
  return new DynamoDBClient({
    endpoint: process.env.DYNAMODB_ENDPOINT,
    region: process.env.AWS_REGION ?? "ap-southeast-2",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
}

export function tableName(): string {
  const name = process.env.DYNAMODB_TABLE_NAME;
  if (!name) throw new Error("DYNAMODB_TABLE_NAME is not set (tests/ddb-local/setup-env.ts)");
  return name;
}

/**
 * Key schema, attributes, index and billing of the production table
 * (infra/lib/syncro-stack.ts). A unit test checks this against the
 * CDK-synthesized template so the two cannot drift.
 */
export const TABLE_SCHEMA: Omit<CreateTableCommandInput, "TableName"> = {
  BillingMode: "PAY_PER_REQUEST",
  AttributeDefinitions: [
    { AttributeName: "PK", AttributeType: "S" },
    { AttributeName: "SK", AttributeType: "S" },
    { AttributeName: "GSI1PK", AttributeType: "S" },
    { AttributeName: "created_at", AttributeType: "S" },
  ],
  KeySchema: [
    { AttributeName: "PK", KeyType: "HASH" },
    { AttributeName: "SK", KeyType: "RANGE" },
  ],
  GlobalSecondaryIndexes: [
    {
      IndexName: "type-index",
      KeySchema: [
        { AttributeName: "GSI1PK", KeyType: "HASH" },
        { AttributeName: "created_at", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    },
  ],
};

export async function createTestTable(): Promise<void> {
  const client = rawClient();
  try {
    await client.send(
      new CreateTableCommand({
        TableName: tableName(),
        ...TABLE_SCHEMA,
      }),
    );
    await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName() });
  } finally {
    client.destroy();
  }
}

export async function deleteTestTable(): Promise<void> {
  const client = rawClient();
  try {
    await client.send(new DeleteTableCommand({ TableName: tableName() }));
  } catch {
    // Already gone; nothing to clean up.
  } finally {
    client.destroy();
  }
}

/** A document client for test-side reads and fixtures (call `.destroy()` when done). */
export function testDocClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(rawClient());
}

/** Every item in the table (assertions only). */
export async function scanAll(): Promise<Array<Record<string, unknown>>> {
  const client = rawClient();
  const doc = DynamoDBDocumentClient.from(client);
  const items: Array<Record<string, unknown>> = [];
  let startKey: Record<string, unknown> | undefined;
  try {
    do {
      const page = await doc.send(
        new ScanCommand({
          TableName: tableName(),
          ConsistentRead: true,
          ExclusiveStartKey: startKey,
        }),
      );
      items.push(...((page.Items ?? []) as Array<Record<string, unknown>>));
      startKey = page.LastEvaluatedKey;
    } while (startKey);
  } finally {
    client.destroy();
  }
  return items;
}

/** Items whose PK starts with `pkPrefix` (and SK with `skPrefix`, if given). */
export async function itemsWith(
  pkPrefix: string,
  skPrefix = "",
): Promise<Array<Record<string, unknown>>> {
  return (await scanAll()).filter(
    (i) => String(i.PK).startsWith(pkPrefix) && String(i.SK).startsWith(skPrefix),
  );
}

/** Registers the per-file table lifecycle. Call once at the top of a suite file. */
export function useTestTable(): void {
  beforeAll(createTestTable, 60_000);
  afterAll(deleteTestTable, 60_000);
}
