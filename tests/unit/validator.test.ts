import { createHmac } from "crypto";
import { verifyGitHubSignature } from "../../src/utils/crypto";
import { validateWebhookSignature } from "../../src/webhooks/validator";
import { APIGatewayProxyEvent } from "aws-lambda";

describe("verifyGitHubSignature", () => {
  const SECRET = "test-webhook-secret-12345";
  const BODY = JSON.stringify({ ref: "refs/heads/main", repository: { id: 1 } });

  function makeSignature(secret: string, body: string): string {
    const hex = createHmac("sha256", secret).update(body, "utf8").digest("hex");
    return `sha256=${hex}`;
  }

  it("returns true for a valid signature", () => {
    const sig = makeSignature(SECRET, BODY);
    expect(verifyGitHubSignature(SECRET, BODY, sig)).toBe(true);
  });

  it("returns false for a wrong secret", () => {
    const sig = makeSignature("wrong-secret", BODY);
    expect(verifyGitHubSignature(SECRET, BODY, sig)).toBe(false);
  });

  it("returns false for a tampered body", () => {
    const sig = makeSignature(SECRET, BODY);
    expect(verifyGitHubSignature(SECRET, BODY + "tampered", sig)).toBe(false);
  });

  it("returns false for a missing sha256= prefix", () => {
    const sig = createHmac("sha256", SECRET).update(BODY, "utf8").digest("hex");
    expect(verifyGitHubSignature(SECRET, BODY, sig)).toBe(false);
  });

  it("returns false for an empty signature", () => {
    expect(verifyGitHubSignature(SECRET, BODY, "")).toBe(false);
  });
});

describe("validateWebhookSignature", () => {
  const originalEnv = process.env;
  const SECRET = "test-webhook-secret-xyz";

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      DYNAMODB_TABLE_NAME: "test-table",
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "dummy-key",
      GITHUB_WEBHOOK_SECRET: SECRET,
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/test",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  function makeSig(body: string): string {
    const hex = createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
    return `sha256=${hex}`;
  }

  function createMockEvent(headers: Record<string, string>, body: string, isBase64 = false): APIGatewayProxyEvent {
    return {
      body: isBase64 ? Buffer.from(body).toString("base64") : body,
      headers,
      multiValueHeaders: {},
      httpMethod: "POST",
      isBase64Encoded: isBase64,
      path: "/webhooks/github",
      pathParameters: null,
      queryStringParameters: null,
      multiValueQueryStringParameters: null,
      stageVariables: null,
      requestContext: {} as any,
      resource: "",
    };
  }

  it("returns valid = false when signature header is missing", () => {
    const event = createMockEvent({}, "{}");
    const result = validateWebhookSignature(event);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Missing X-Hub-Signature-256 header");
  });

  it("returns valid = true for correctly signed request", () => {
    const body = '{"action":"created"}';
    const sig = makeSig(body);
    const event = createMockEvent({ "x-hub-signature-256": sig }, body);
    const result = validateWebhookSignature(event);
    expect(result.valid).toBe(true);
    expect(result.rawBody).toBe(body);
  });

  it("handles uppercase X-Hub-Signature-256 header", () => {
    const body = '{"action":"created"}';
    const sig = makeSig(body);
    const event = createMockEvent({ "X-Hub-Signature-256": sig }, body);
    const result = validateWebhookSignature(event);
    expect(result.valid).toBe(true);
  });

  it("returns valid = false when signature is invalid", () => {
    const event = createMockEvent({ "x-hub-signature-256": "sha256=invalid" }, '{"action":"test"}');
    const result = validateWebhookSignature(event);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid webhook signature");
  });

  it("decodes base64-encoded request bodies before validation", () => {
    const body = '{"ref":"refs/heads/main"}';
    const sig = makeSig(body);
    const event = createMockEvent({ "x-hub-signature-256": sig }, body, true);
    const result = validateWebhookSignature(event);
    expect(result.valid).toBe(true);
    expect(result.rawBody).toBe(body);
  });
});