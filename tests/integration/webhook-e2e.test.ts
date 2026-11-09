/**
 * End-to-End Integration Tests for Syncro
 *
 * Verifies the entire pipeline end-to-end:
 * API Gateway HTTP Request
 *   ➔ HMAC-SHA256 Signature Validation (crypto.timingSafeEqual)
 *   ➔ Delivery Deduplication & Idempotency Lock (DynamoDB attribute_not_exists)
 *   ➔ Event Routing (Push & Pull Request)
 *   ➔ Commit Enrichment (GitHub API Octokit)
 *   ➔ DynamoDB Persistence (Commits, Deliveries, Notification Logs)
 *   ➔ Rich Embed Generation & Outbound Dispatch (Discord REST API)
 */

import { handler } from "../../src/handler";
import { APIGatewayProxyEvent, Context } from "aws-lambda";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { ddb } from "../../src/db/client";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutCommand, GetCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

jest.mock("../../src/db/client", () => ({
  ddb: {
    send: jest.fn(),
  },
}));

const TEST_SECRET = "test-webhook-secret-xyz";

describe("Webhook Pipeline E2E Integration Tests", () => {
  // In-memory DynamoDB store: key = `${PK}##${SK}`
  const dbStore = new Map<string, any>();
  let discordCalls: Array<{ url: string; payload: any }> = [];

  const mockContext: Context = {
    awsRequestId: "e2e-aws-request-id-999",
  } as any;

  function storeKey(pk: string, sk: string): string {
    return `${pk}##${sk}`;
  }

  function signPayload(rawBody: string, secret = TEST_SECRET): string {
    return "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  }

  function createApiGatewayEvent(options: {
    body: string;
    signature?: string;
    eventType?: string;
    deliveryId?: string;
  }): APIGatewayProxyEvent {
    const signature = options.signature ?? signPayload(options.body);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
    };

    if (options.eventType) {
      headers["x-github-event"] = options.eventType;
    }
    if (options.deliveryId) {
      headers["x-github-delivery"] = options.deliveryId;
    }

    return {
      httpMethod: "POST",
      path: "/webhooks/github",
      headers,
      multiValueHeaders: {},
      queryStringParameters: null,
      multiValueQueryStringParameters: null,
      pathParameters: null,
      stageVariables: null,
      requestContext: {} as any,
      resource: "",
      body: options.body,
      isBase64Encoded: false,
    };
  }

  beforeEach(() => {
    dbStore.clear();
    discordCalls = [];

    // Seed active watched repository in in-memory DynamoDB
    const repoConfig = {
      PK: "REPO#987654321",
      SK: "CONFIG",
      github_repo_id: "987654321",
      github_full_name: "acme/syncro",
      github_url: "https://github.com/acme/syncro",
      discord_webhook_url: "https://discord.com/api/webhooks/e2e-channel",
      watched_branch: "main",
      is_active: true,
      GSI1PK: "TYPE#REPO",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    dbStore.set(storeKey(repoConfig.PK, repoConfig.SK), { ...repoConfig });

    // Mock DynamoDB send to operate against in-memory store
    (ddb.send as jest.Mock).mockImplementation(async (command: any) => {
      if (command instanceof PutCommand) {
        const item = command.input.Item as any;
        const condition = command.input.ConditionExpression;

        if (!item) return {};

        // Atomic check: attribute_not_exists(PK)
        if (condition === "attribute_not_exists(PK)") {
          for (const stored of dbStore.values()) {
            if (stored.PK === item.PK) {
              throw new ConditionalCheckFailedException({
                $metadata: {},
                message: "The conditional request failed",
              });
            }
          }
        }

        dbStore.set(storeKey(item.PK, item.SK), { ...item });
        return {};
      }

      if (command instanceof GetCommand) {
        const key = command.input.Key as any;
        const PK = key?.PK;
        const SK = key?.SK;
        const item = PK && SK ? dbStore.get(storeKey(PK, SK)) : undefined;
        return { Item: item ? { ...item } : undefined };
      }

      if (command instanceof UpdateCommand) {
        const key = command.input.Key as any;
        const PK = key?.PK;
        const SK = key?.SK;
        if (!PK || !SK) return {};

        const sKey = storeKey(PK, SK);
        const existing = dbStore.get(sKey);
        const condition = command.input.ConditionExpression;

        // Simulate conditional checks for claimDelivery and notifications
        if (condition && condition.includes("attribute_not_exists(PK)")) {
          if (existing) {
            if (existing.status === "processed" || existing.status === "ignored") {
              throw new ConditionalCheckFailedException({
                $metadata: {},
                message: "Already processed or ignored",
              });
            }
            if (
              existing.status === "processing" &&
              existing.lease_expires_at &&
              existing.lease_expires_at >= Date.now()
            ) {
              throw new ConditionalCheckFailedException({
                $metadata: {},
                message: "Active lease held",
              });
            }
          }
        }

        const item = existing ? { ...existing } : { PK, SK };
        const exprValues = command.input.ExpressionAttributeValues || {};

        if (exprValues[":status"]) {
          item.status = exprValues[":status"];
        }
        if (exprValues[":processedAt"]) {
          item.processed_at = exprValues[":processedAt"];
        }
        if (exprValues[":error"]) {
          item.error_message = exprValues[":error"];
        }
        if (exprValues[":messageId"]) {
          item.message_id = exprValues[":messageId"];
        }
        if (exprValues[":repoId"]) {
          item.github_repo_id = exprValues[":repoId"];
        }
        if (exprValues[":eventType"]) {
          item.event_type = exprValues[":eventType"];
        }
        if (exprValues[":leaseExpires"]) {
          item.lease_expires_at = exprValues[":leaseExpires"];
        }
        if (exprValues[":nowIso"]) {
          item.last_attempt_at = exprValues[":nowIso"];
          if (!item.received_at) item.received_at = exprValues[":nowIso"];
        }

        dbStore.set(sKey, item);
        return { Attributes: item };
      }

      if (command instanceof QueryCommand) {
        return { Items: Array.from(dbStore.values()) };
      }

      return {};
    });

    // Mock global fetch to capture Discord webhook requests
    global.fetch = jest.fn().mockImplementation(async (url: string, options: any) => {
      discordCalls.push({
        url,
        payload: JSON.parse(options.body),
      });
      return {
        ok: true,
        status: 204,
      } as any;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── 1. Push Event E2E Pipeline ──────────────────────────────────────────

  describe("Push Event Pipeline", () => {
    it("processes a signed push event, enriches commits, updates DynamoDB, and dispatches Discord embed", async () => {
      const fixturePath = path.resolve(__dirname, "../fixtures/push-event.json");
      const rawPayload = fs.readFileSync(fixturePath, "utf-8");

      const event = createApiGatewayEvent({
        body: rawPayload,
        eventType: "push",
        deliveryId: "deliv-push-e2e-001",
      });

      const response = await handler(event, mockContext);

      // 1. Ingress & HTTP response check
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).message).toBe("OK");

      // 2. DynamoDB: Delivery record claimed and marked processed
      const deliveryRecord = dbStore.get(storeKey("DELIVERY#deliv-push-e2e-001", "DELIVERY#deliv-push-e2e-001"));
      expect(deliveryRecord).toBeDefined();
      expect(deliveryRecord.status).toBe("processed");
      expect(deliveryRecord.event_type).toBe("push");

      // 3. DynamoDB: Commits persisted with enrichment stats
      const commitRecord = dbStore.get(
        storeKey("REPO#987654321", "COMMIT#a81f23c9b42e1f6c3d8290456ae182736f45b2c1"),
      );
      expect(commitRecord).toBeDefined();
      expect(commitRecord.short_sha).toBe("a81f23c");
      expect(commitRecord.additions).toBe(10);
      expect(commitRecord.deletions).toBe(2);

      // 4. DynamoDB: Notification log record created and marked sent
      const notifRecords = Array.from(dbStore.values()).filter(
        (item) => item.PK === "REPO#987654321" && item.SK.startsWith("NOTIF#"),
      );
      expect(notifRecords.length).toBe(1);
      expect(notifRecords[0].status).toBe("sent");

      // 5. Discord Webhook: Received rich embed with pull command at configured repo URL
      expect(discordCalls.length).toBe(1);
      expect(discordCalls[0].url).toBe("https://discord.com/api/webhooks/e2e-channel");
      const discordEmbed = discordCalls[0].payload.embeds[0];
      expect(discordEmbed.title).toContain("MAIN updated - BuggyPratiK/project-x");
      expect(discordEmbed.fields.some((f: any) => f.value.includes("git pull origin main"))).toBe(true);
    });

    it("enforces atomic idempotency — duplicate delivery returns 200 without duplicate Discord notification", async () => {
      const fixturePath = path.resolve(__dirname, "../fixtures/push-event.json");
      const rawPayload = fs.readFileSync(fixturePath, "utf-8");

      const event = createApiGatewayEvent({
        body: rawPayload,
        eventType: "push",
        deliveryId: "deliv-duplicate-001",
      });

      // First delivery: processes normally
      const firstResponse = await handler(event, mockContext);
      expect(firstResponse.statusCode).toBe(200);
      expect(discordCalls.length).toBe(1);

      // Second duplicate delivery: GitHub retry burst
      const secondResponse = await handler(event, mockContext);
      expect(secondResponse.statusCode).toBe(200);
      expect(JSON.parse(secondResponse.body).message).toBe("Already processed");

      // Discord was NOT notified a second time
      expect(discordCalls.length).toBe(1);
    });
  });

  // ─── 2. Pull Request Event E2E Pipeline ──────────────────────────────────

  describe("Pull Request Event Pipeline", () => {
    it("processes a signed pull_request opened event and dispatches rich PR embed to Discord", async () => {
      const fixturePath = path.resolve(__dirname, "../fixtures/pr-event.json");
      const rawPayload = fs.readFileSync(fixturePath, "utf-8");

      const event = createApiGatewayEvent({
        body: rawPayload,
        eventType: "pull_request",
        deliveryId: "deliv-pr-e2e-001",
      });

      const response = await handler(event, mockContext);

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).message).toBe("OK");

      // Delivery record updated
      const deliveryRecord = dbStore.get(storeKey("DELIVERY#deliv-pr-e2e-001", "DELIVERY#deliv-pr-e2e-001"));
      expect(deliveryRecord).toBeDefined();
      expect(deliveryRecord.status).toBe("processed");
      expect(deliveryRecord.event_type).toBe("pull_request");

      // Notification log saved
      const notifRecords = Array.from(dbStore.values()).filter(
        (item) => item.PK === "REPO#987654321" && item.SK.startsWith("NOTIF#"),
      );
      expect(notifRecords.length).toBe(1);
      expect(notifRecords[0].status).toBe("sent");

      // Discord received formatted PR embed
      expect(discordCalls.length).toBe(1);
      expect(discordCalls[0].url).toBe("https://discord.com/api/webhooks/e2e-channel");
      const embed = discordCalls[0].payload.embeds[0];
      expect(embed.title).toContain("PR #42 opened - acme/syncro");
      expect(embed.description).toContain("feat: add user authentication");
      expect(embed.fields.some((f: any) => f.name === "🎯 Branches")).toBe(true);
      expect(embed.fields.some((f: any) => f.name === "👀 Review Required")).toBe(true);
    });

    it("processes a pull_request closed & merged event with purple embed and git pull instruction", async () => {
      const fixturePath = path.resolve(__dirname, "../fixtures/pr-event.json");
      const parsed = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
      parsed.action = "closed";
      parsed.pull_request.state = "closed";
      parsed.pull_request.merged = true;
      const rawPayload = JSON.stringify(parsed);

      const event = createApiGatewayEvent({
        body: rawPayload,
        eventType: "pull_request",
        deliveryId: "deliv-pr-merged-001",
      });

      const response = await handler(event, mockContext);

      expect(response.statusCode).toBe(200);
      expect(discordCalls.length).toBe(1);
      expect(discordCalls[0].url).toBe("https://discord.com/api/webhooks/e2e-channel");
      const embed = discordCalls[0].payload.embeds[0];
      expect(embed.title).toContain("PR #42 merged into main - acme/syncro");
      expect(embed.color).toBe(0x8250df);
      expect(embed.fields.some((f: any) => f.value.includes("git pull origin main"))).toBe(true);
    });
  });

  // ─── 3. Cryptographic Security & Error Handling E2E ──────────────────────

  describe("Security & Validation", () => {
    it("rejects request with invalid signature with 401 Unauthorized before touching DB or Discord", async () => {
      const payload = JSON.stringify({ repository: { id: 987654321 } });
      const event = createApiGatewayEvent({
        body: payload,
        signature: "sha256=0000000000000000000000000000000000000000000000000000000000000000",
        eventType: "push",
        deliveryId: "deliv-invalid-sig",
      });

      const response = await handler(event, mockContext);

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body).error).toBe("Unauthorized");

      // Verify zero interaction with Discord or Delivery records
      expect(discordCalls.length).toBe(0);
      expect(dbStore.get(storeKey("DELIVERY#deliv-invalid-sig", "DELIVERY#deliv-invalid-sig"))).toBeUndefined();
    });

    it("rejects request with missing X-GitHub-Delivery header with 400 Bad Request", async () => {
      const payload = JSON.stringify({ repository: { id: 987654321 } });
      const event = createApiGatewayEvent({
        body: payload,
        eventType: "push",
        // deliveryId omitted
      });

      const response = await handler(event, mockContext);

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toContain("Missing X-GitHub-Delivery header");
      expect(discordCalls.length).toBe(0);
    });

    it("responds 200 for health check without touching webhook logic", async () => {
      const event: APIGatewayProxyEvent = {
        httpMethod: "GET",
        path: "/health",
        headers: {},
        multiValueHeaders: {},
        queryStringParameters: null,
        multiValueQueryStringParameters: null,
        pathParameters: null,
        stageVariables: null,
        requestContext: {} as any,
        resource: "",
        body: null,
        isBase64Encoded: false,
      };

      const response = await handler(event, mockContext);

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).status).toBe("ok");
      expect(JSON.parse(response.body).service).toBe("syncro");
    });
  });
});

