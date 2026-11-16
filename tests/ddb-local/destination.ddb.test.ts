/**
 * Destinations against DynamoDB Local with a fake SSM writer: the URL goes
 * only to SSM under the derived name, the three-step create with
 * compensation, per-workspace and service-wide limits, URL replacement, and
 * workspace isolation.
 */

import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../src/db/client";
import {
  createDestination,
  getDestination,
  listDestinations,
  replaceDestinationWebhook,
  updateDestination,
} from "../../src/db/operations/tenant-destination.ops";
import { deriveDestinationParamName } from "../../src/secrets/param-names";
import { ContractError, SSM_DESTINATION_PARAMS, WORKSPACE_LIMITS, type WorkspaceContext } from "../../src/contracts";
import { VALID_WEBHOOK, asRole, fakeWriter, newOwner, openSignups } from "./fixtures";
import { scanAll, tableName, useTestTable } from "./harness";

useTestTable();
beforeAll(openSignups);

const TOKEN = "AbCdEf-secret_token";

async function code(p: Promise<unknown>): Promise<string> {
  const e = await p.then(() => undefined, (err: unknown) => err);
  return e instanceof ContractError ? e.code : `not a ContractError: ${String(e)}`;
}

async function workspaceCount(ctx: WorkspaceContext): Promise<number | undefined> {
  const out = await ddb.send(new GetCommand({ TableName: tableName(), Key: { PK: `WS#${ctx.workspaceId}`, SK: "META" }, ConsistentRead: true }));
  return out.Item?.active_destination_count as number | undefined;
}

async function globalCount(): Promise<number | undefined> {
  const out = await ddb.send(new GetCommand({ TableName: tableName(), Key: { PK: "SYSTEM#COUNTERS", SK: "SSM_DEST_PARAMS" }, ConsistentRead: true }));
  return out.Item?.count as number | undefined;
}

async function setGlobalCount(count: number): Promise<void> {
  await ddb.send(new PutCommand({ TableName: tableName(), Item: { PK: "SYSTEM#COUNTERS", SK: "SSM_DEST_PARAMS", count } }));
}

async function destItems(ctx: WorkspaceContext) {
  return (await scanAll()).filter((i) => i.PK === `WS#${ctx.workspaceId}` && String(i.SK).startsWith("DEST#"));
}

beforeEach(() => setGlobalCount(0));

describe("createDestination", () => {
  it("writes the URL only to SSM under the derived name and stores just a reference", async () => {
    const ctx = await newOwner();
    const writer = fakeWriter();

    const dest = await createDestination(ctx, { displayName: " Alerts ", webhookUrl: `${VALID_WEBHOOK}?wait=true` }, writer);

    const expectedName = deriveDestinationParamName(ctx.workspaceId, dest.destinationId, "/syncro/prod");
    expect(writer.calls).toEqual([{ name: expectedName, value: VALID_WEBHOOK, overwrite: false }]);
    expect(dest).toMatchObject({ displayName: "Alerts", status: "active", webhookId: "123456789012345678" });
    expect(JSON.stringify(dest)).not.toContain(TOKEN);
    expect(dest).not.toHaveProperty("secretRef");

    const [item] = await destItems(ctx);
    expect(item).toMatchObject({ status: "active", secret_ref: { name: expectedName, version: 1 } });
    expect(JSON.stringify(await scanAll())).not.toContain(TOKEN); // no URL or token anywhere in DynamoDB
    expect(await workspaceCount(ctx)).toBe(1);
    expect(await globalCount()).toBe(1);
  });

  it("refuses an invalid URL without calling SSM or writing anything", async () => {
    const ctx = await newOwner();
    const writer = fakeWriter();
    for (const url of ["http://discord.com/api/webhooks/123456789012345678/x", "https://evil.example/api/webhooks/1/x", "u".repeat(300)]) {
      expect(await code(createDestination(ctx, { displayName: "X", webhookUrl: url }, writer))).toBe("invalid_webhook_url");
    }
    expect(writer.calls).toHaveLength(0);
    expect(await destItems(ctx)).toHaveLength(0);
  });

  it.each(["secret_store_busy", "secret_unavailable"] as const)(
    "SSM failure (%s) is compensated: no item left and both counters restored",
    async (failure) => {
      const ctx = await newOwner();
      await createDestination(ctx, { displayName: "Kept", webhookUrl: VALID_WEBHOOK }, fakeWriter());

      expect(await code(createDestination(ctx, { displayName: "Lost", webhookUrl: VALID_WEBHOOK }, fakeWriter({ failWith: failure })))).toBe(failure);

      const items = await destItems(ctx);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ display_name: "Kept", status: "active" });
      expect(await workspaceCount(ctx)).toBe(1);
      expect(await globalCount()).toBe(1);
    },
  );

  it(`allows ${WORKSPACE_LIMITS.activeDestinations} active destinations per workspace, including deactivate and reactivate`, async () => {
    const ctx = await newOwner();
    const created = [];
    for (let i = 0; i < WORKSPACE_LIMITS.activeDestinations; i++) {
      created.push(await createDestination(ctx, { displayName: `D${i}`, webhookUrl: VALID_WEBHOOK }, fakeWriter()));
    }
    const writer = fakeWriter();
    expect(await code(createDestination(ctx, { displayName: "One too many", webhookUrl: VALID_WEBHOOK }, writer))).toBe("destination_limit_reached");
    expect(writer.calls).toHaveLength(0); // refused before SSM

    await updateDestination(ctx, created[0].destinationId, { isActive: false });
    expect(await workspaceCount(ctx)).toBe(WORKSPACE_LIMITS.activeDestinations - 1);
    await createDestination(ctx, { displayName: "Fits now", webhookUrl: VALID_WEBHOOK }, fakeWriter());
    expect(await code(updateDestination(ctx, created[0].destinationId, { isActive: true }))).toBe("destination_limit_reached");

    await updateDestination(ctx, created[1].destinationId, { isActive: false });
    await expect(updateDestination(ctx, created[0].destinationId, { isActive: true })).resolves.toMatchObject({ status: "active" });
    expect(await workspaceCount(ctx)).toBe(WORKSPACE_LIMITS.activeDestinations);
    // Deactivation keeps the parameter, so service-wide usage only grows.
    expect(await globalCount()).toBe(WORKSPACE_LIMITS.activeDestinations + 1);
  }, 60_000);

  it(`refuses new destinations at the service-wide ceiling (${SSM_DESTINATION_PARAMS.ceiling})`, async () => {
    const ctx = await newOwner();
    await setGlobalCount(SSM_DESTINATION_PARAMS.ceiling - 1);
    await createDestination(ctx, { displayName: "Last", webhookUrl: VALID_WEBHOOK }, fakeWriter());
    expect(await globalCount()).toBe(SSM_DESTINATION_PARAMS.ceiling);

    const writer = fakeWriter();
    expect(await code(createDestination(ctx, { displayName: "Over", webhookUrl: VALID_WEBHOOK }, writer))).toBe("destination_capacity_reached");
    expect(writer.calls).toHaveLength(0);
    expect(await workspaceCount(ctx)).toBe(1);
  });

  it("a member may not create, an admin may, and a suspended workspace cannot", async () => {
    const ctx = await newOwner();
    expect(await code(createDestination(asRole(ctx, "member"), { displayName: "X", webhookUrl: VALID_WEBHOOK }, fakeWriter()))).toBe("forbidden");
    await expect(createDestination(asRole(ctx, "admin"), { displayName: "By admin", webhookUrl: VALID_WEBHOOK }, fakeWriter())).resolves.toMatchObject({ status: "active" });
    await ddb.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { PK: `WS#${ctx.workspaceId}`, SK: "META" },
        UpdateExpression: "SET #s = :s",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": "suspended" },
      }),
    );
    expect(await code(createDestination(ctx, { displayName: "X", webhookUrl: VALID_WEBHOOK }, fakeWriter()))).toBe("not_found");
  });
});

describe("replaceDestinationWebhook", () => {
  it("overwrites the same derived parameter and points the destination at the new version", async () => {
    const ctx = await newOwner();
    const writer = fakeWriter();
    const dest = await createDestination(ctx, { displayName: "A", webhookUrl: VALID_WEBHOOK }, writer);
    const newUrl = "https://discord.com/api/webhooks/987654321098765432/Other-token";

    const updated = await replaceDestinationWebhook(ctx, dest.destinationId, newUrl, writer);

    expect(writer.calls[1]).toEqual({ name: writer.calls[0].name, value: newUrl, overwrite: true });
    expect(updated.webhookId).toBe("987654321098765432");
    const [item] = await destItems(ctx);
    expect(item.secret_ref).toEqual({ name: writer.calls[0].name, version: 2 });
    expect(await globalCount()).toBe(1); // same parameter, no new capacity used
  });

  it("refuses an inactive destination and a stored reference that does not match the derived name", async () => {
    const ctx = await newOwner();
    const writer = fakeWriter();
    const a = await createDestination(ctx, { displayName: "A", webhookUrl: VALID_WEBHOOK }, writer);
    await updateDestination(ctx, a.destinationId, { isActive: false });
    expect(await code(replaceDestinationWebhook(ctx, a.destinationId, VALID_WEBHOOK, writer))).toBe("destination_not_active");

    const b = await createDestination(ctx, { displayName: "B", webhookUrl: VALID_WEBHOOK }, writer);
    await ddb.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { PK: `WS#${ctx.workspaceId}`, SK: `DEST#${b.destinationId}` },
        UpdateExpression: "SET secret_ref.#n = :n",
        ExpressionAttributeNames: { "#n": "name" },
        ExpressionAttributeValues: { ":n": "/syncro/prod/sender/github-webhook-secret" },
      }),
    );
    const before = writer.calls.length;
    expect(await code(replaceDestinationWebhook(ctx, b.destinationId, VALID_WEBHOOK, writer))).toBe("secret_unavailable");
    expect(writer.calls).toHaveLength(before); // nothing written to SSM
  });
});

describe("destination isolation", () => {
  it("another workspace can neither read, list, update nor replace a destination", async () => {
    const [a, b] = [await newOwner(), await newOwner()];
    const writer = fakeWriter();
    const dests = [];
    for (let i = 0; i < 3; i++) dests.push(await createDestination(a, { displayName: `A${i}`, webhookUrl: VALID_WEBHOOK }, writer));
    const id = dests[0].destinationId;

    expect(await getDestination(b, id)).toBeNull();
    expect(await code(updateDestination(b, id, { displayName: "hijack" }))).toBe("not_found");
    const before = writer.calls.length;
    expect(await code(replaceDestinationWebhook(b, id, VALID_WEBHOOK, writer))).toBe("not_found");
    expect(writer.calls).toHaveLength(before);
    expect((await listDestinations(b, { limit: 50 })).items).toHaveLength(0);

    const p1 = await listDestinations(a, { limit: 2 });
    const p2 = await listDestinations(a, { limit: 2, cursor: p1.nextCursor });
    expect([...p1.items, ...p2.items].map((d) => d.destinationId).sort()).toEqual(dests.map((d) => d.destinationId).sort());
    expect(await code(listDestinations(b, { limit: 2, cursor: p1.nextCursor }))).toBe("invalid_request");
  });
});
