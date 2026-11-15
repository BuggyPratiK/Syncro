/**
 * Workspace context against DynamoDB Local: only an active member of an
 * active workspace gets a context; changes apply on the very next call.
 */

import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../src/db/client";
import { bootstrapUser, setTenancyDepsForTests } from "../../src/db/operations/tenancy.ops";
import { resolveWorkspaceContext } from "../../src/tenancy/context";
import { parseArgs, run } from "../../scripts/set-signup-mode";
import { tableName, testDocClient, useTestTable } from "./harness";

useTestTable();

const ISS = "https://tenant.logto.app/oidc";
const ALICE = "logto:alice0000001";
const BOB = "logto:bob000000001";

let aliceWs: string;
let bobWs: string;

async function setStatus(key: { PK: string; SK: string }, status: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: key,
      UpdateExpression: "SET #s = :s",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": status },
    }),
  );
}

beforeAll(async () => {
  const doc = testDocClient();
  await run(doc, { ...parseArgs(["--mode", "open", "--yes"], {}), table: tableName() });
  doc.destroy();
  setTenancyDepsForTests(undefined);
  aliceWs = (await bootstrapUser(ALICE, ISS)).workspaceId;
  bobWs = (await bootstrapUser(BOB, ISS)).workspaceId;
});

describe("resolveWorkspaceContext", () => {
  it("resolves the owner of their own workspace", async () => {
    await expect(resolveWorkspaceContext(ALICE, aliceWs)).resolves.toEqual({
      userId: ALICE,
      workspaceId: aliceWs,
      role: "owner",
    });
  });

  it("returns null for another user's workspace (both directions)", async () => {
    await expect(resolveWorkspaceContext(ALICE, bobWs)).resolves.toBeNull();
    await expect(resolveWorkspaceContext(BOB, aliceWs)).resolves.toBeNull();
  });

  it("returns null for a workspace that does not exist", async () => {
    await expect(resolveWorkspaceContext(ALICE, "ws_99999999-9999-4999-8999-999999999999")).resolves.toBeNull();
  });

  it("returns null as soon as the workspace is suspended, and again resolves once reactivated", async () => {
    await setStatus({ PK: `WS#${bobWs}`, SK: "META" }, "suspended");
    await expect(resolveWorkspaceContext(BOB, bobWs)).resolves.toBeNull();
    await setStatus({ PK: `WS#${bobWs}`, SK: "META" }, "active");
    await expect(resolveWorkspaceContext(BOB, bobWs)).resolves.toMatchObject({ role: "owner" });
  });

  it("returns null as soon as the membership is removed", async () => {
    await setStatus({ PK: `WS#${aliceWs}`, SK: `MEMBER#${ALICE}` }, "removed");
    await expect(resolveWorkspaceContext(ALICE, aliceWs)).resolves.toBeNull();
    await setStatus({ PK: `WS#${aliceWs}`, SK: `MEMBER#${ALICE}` }, "active");
  });
});
