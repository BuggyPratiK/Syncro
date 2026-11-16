/**
 * `getMe` against DynamoDB Local: profile and active workspaces only,
 * strictly read-only.
 */

import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../src/db/client";
import { getMe } from "../../src/db/operations/tenancy.ops";
import { newOwner, newUserId, openSignups } from "./fixtures";
import { scanAll, tableName, useTestTable } from "./harness";

useTestTable();
beforeAll(openSignups);

async function setStatus(key: { PK: string; SK: string }, status: string) {
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

describe("getMe", () => {
  it("returns the profile and the owner workspace in the existing MeDto shape", async () => {
    const ctx = await newOwner();
    const me = await getMe(ctx.userId);
    expect(me).toEqual({
      profile: { status: "active", createdAt: expect.any(String) },
      workspaces: [{ workspaceId: ctx.workspaceId, role: "owner" }],
    });
  });

  it("returns no profile and no workspaces for a user who never signed up, without writing anything", async () => {
    const before = (await scanAll()).length;
    await expect(getMe(newUserId())).resolves.toEqual({ workspaces: [] });
    expect((await scanAll()).length).toBe(before);
  });

  it("omits a suspended workspace and a removed membership", async () => {
    const a = await newOwner();
    await setStatus({ PK: `WS#${a.workspaceId}`, SK: "META" }, "suspended");
    expect((await getMe(a.userId)).workspaces).toEqual([]);

    const b = await newOwner();
    await setStatus({ PK: `WS#${b.workspaceId}`, SK: `MEMBER#${b.userId}` }, "removed");
    expect((await getMe(b.userId)).workspaces).toEqual([]);
  });

  it("reports a suspended profile", async () => {
    const ctx = await newOwner();
    await setStatus({ PK: `USER#${ctx.userId}`, SK: "PROFILE" }, "suspended");
    expect((await getMe(ctx.userId)).profile?.status).toBe("suspended");
  });

  it("is read-only", async () => {
    const ctx = await newOwner();
    const before = JSON.stringify(await scanAll());
    await getMe(ctx.userId);
    await getMe(ctx.userId);
    expect(JSON.stringify(await scanAll())).toBe(before);
  });
});
