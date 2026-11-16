/**
 * Harness self-check: the suite talks to DynamoDB Local (never AWS), the test
 * table mirrors the production schema, and the application client uses it.
 */

import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../src/db/client";
import { tableName as appTableName } from "../../src/db/table";
import { tableName, useTestTable } from "./harness";

useTestTable();

describe("DynamoDB Local harness", () => {
  it("points the application at a local endpoint and this file's own table", () => {
    expect(["localhost", "127.0.0.1", "dynamodb"]).toContain(new URL(process.env.DYNAMODB_ENDPOINT!).hostname);
    expect(appTableName()).toBe(tableName());
    expect(tableName()).toMatch(/^syncro-test-[0-9a-f-]{36}$/);
  });

  it("creates the table with the production key schema, type-index and on-demand billing", async () => {
    const client = new DynamoDBClient({
      endpoint: process.env.DYNAMODB_ENDPOINT,
      region: "ap-southeast-2",
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    });
    const { Table } = await client.send(new DescribeTableCommand({ TableName: tableName() }));
    client.destroy();

    expect(Table?.KeySchema).toEqual([
      { AttributeName: "PK", KeyType: "HASH" },
      { AttributeName: "SK", KeyType: "RANGE" },
    ]);
    const gsi = Table?.GlobalSecondaryIndexes?.find((g) => g.IndexName === "type-index");
    expect(gsi?.KeySchema).toEqual([
      { AttributeName: "GSI1PK", KeyType: "HASH" },
      { AttributeName: "created_at", KeyType: "RANGE" },
    ]);
    expect(gsi?.Projection?.ProjectionType).toBe("ALL");
    expect(Table?.BillingModeSummary?.BillingMode).toBe("PAY_PER_REQUEST");
  });

  it("supports conditional writes and type-index queries through the application client", async () => {
    const item = { PK: "PROBE#1", SK: "META", GSI1PK: "PROBE", created_at: "2026-11-15T00:00:00Z" };
    await ddb.send(new PutCommand({ TableName: tableName(), Item: item, ConditionExpression: "attribute_not_exists(PK)" }));
    await expect(
      ddb.send(new PutCommand({ TableName: tableName(), Item: item, ConditionExpression: "attribute_not_exists(PK)" })),
    ).rejects.toMatchObject({ name: "ConditionalCheckFailedException" });

    const got = await ddb.send(new GetCommand({ TableName: tableName(), Key: { PK: "PROBE#1", SK: "META" }, ConsistentRead: true }));
    expect(got.Item).toMatchObject(item);

    const q = await ddb.send(
      new QueryCommand({
        TableName: tableName(),
        IndexName: "type-index",
        KeyConditionExpression: "GSI1PK = :p",
        ExpressionAttributeValues: { ":p": "PROBE" },
      }),
    );
    expect(q.Items).toHaveLength(1);
  });
});
