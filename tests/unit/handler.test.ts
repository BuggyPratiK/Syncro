import { handler } from "../../src/handler";
import { APIGatewayProxyEvent, Context } from "aws-lambda";
import * as validator from "../../src/webhooks/validator";
import * as deliveryOps from "../../src/db/operations/delivery.ops";
import * as router from "../../src/webhooks/router";

jest.mock("../../src/webhooks/validator");
jest.mock("../../src/db/operations/delivery.ops");
jest.mock("../../src/webhooks/router");

describe("Lambda handler", () => {
  const mockContext: Context = {
    awsRequestId: "req-12345",
  } as any;

  function createEvent(overrides: Partial<APIGatewayProxyEvent>): APIGatewayProxyEvent {
    return {
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
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("GET /health", () => {
    it("returns 200 with status ok and service name", async () => {
      const event = createEvent({ httpMethod: "GET", path: "/health" });
      const result = await handler(event, mockContext);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.status).toBe("ok");
      expect(body.service).toBe("syncro");
      expect(body.requestId).toBe("req-12345");
    });
  });

  describe("Unknown routes", () => {
    it("returns 404 for unknown path", async () => {
      const event = createEvent({ httpMethod: "GET", path: "/unknown" });
      const result = await handler(event, mockContext);

      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body).error).toBe("Not found");
    });
  });

  describe("POST /webhooks/github", () => {
    it("returns 401 when signature validation fails", async () => {
      jest.spyOn(validator, "validateWebhookSignature").mockReturnValueOnce({
        valid: false,
        rawBody: "",
        error: "Invalid signature",
      });

      const event = createEvent({
        httpMethod: "POST",
        path: "/webhooks/github",
        body: "{}",
      });

      const result = await handler(event, mockContext);
      expect(result.statusCode).toBe(401);
      expect(JSON.parse(result.body).error).toBe("Unauthorized");
    });

    it("returns 400 when payload is not valid JSON", async () => {
      jest.spyOn(validator, "validateWebhookSignature").mockReturnValueOnce({
        valid: true,
        rawBody: "invalid-json{",
      });

      const event = createEvent({
        httpMethod: "POST",
        path: "/webhooks/github",
        body: "invalid-json{",
      });

      const result = await handler(event, mockContext);
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toBe("Invalid JSON payload");
    });

    it("returns 400 when X-GitHub-Delivery header is missing", async () => {
      jest.spyOn(validator, "validateWebhookSignature").mockReturnValueOnce({
        valid: true,
        rawBody: '{"action":"test"}',
      });

      const event = createEvent({
        httpMethod: "POST",
        path: "/webhooks/github",
        headers: {},
        body: '{"action":"test"}',
      });

      const result = await handler(event, mockContext);
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toBe("Missing X-GitHub-Delivery header");
    });

    it("returns 200 with 'Already processed' when delivery is duplicate", async () => {
      jest.spyOn(validator, "validateWebhookSignature").mockReturnValueOnce({
        valid: true,
        rawBody: '{"repository":{"id":123}}',
      });
      jest.spyOn(deliveryOps, "claimDelivery").mockResolvedValueOnce(false);

      const event = createEvent({
        httpMethod: "POST",
        path: "/webhooks/github",
        headers: {
          "x-github-delivery": "deliv-dup-123",
          "x-github-event": "push",
        },
        body: '{"repository":{"id":123}}',
      });

      const result = await handler(event, mockContext);
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body).message).toBe("Already processed");
      expect(router.routeWebhookEvent).not.toHaveBeenCalled();
    });

    it("returns 200 with 'Event received but not handled' for unhandled event types", async () => {
      jest.spyOn(validator, "validateWebhookSignature").mockReturnValueOnce({
        valid: true,
        rawBody: '{"zen":"Responsive is better than fast."}',
      });
      jest.spyOn(deliveryOps, "claimDelivery").mockResolvedValueOnce(true);
      jest.spyOn(router, "routeWebhookEvent").mockResolvedValueOnce({
        handled: false,
        eventType: "ping",
      });

      const event = createEvent({
        httpMethod: "POST",
        path: "/webhooks/github",
        headers: {
          "x-github-delivery": "deliv-ping-1",
          "x-github-event": "ping",
        },
        body: '{"zen":"Responsive is better than fast."}',
      });

      const result = await handler(event, mockContext);
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body).message).toBe("Event received but not handled");
      expect(deliveryOps.markDeliveryIgnored).toHaveBeenCalledWith(
        "deliv-ping-1",
        expect.stringContaining("Unsupported event: ping"),
      );
    });

    it("returns 200 with 'OK' when push event is processed successfully", async () => {
      jest.spyOn(validator, "validateWebhookSignature").mockReturnValueOnce({
        valid: true,
        rawBody: '{"repository":{"id":123}}',
      });
      jest.spyOn(deliveryOps, "claimDelivery").mockResolvedValueOnce(true);
      jest.spyOn(router, "routeWebhookEvent").mockResolvedValueOnce({
        handled: true,
        eventType: "push",
      });

      const event = createEvent({
        httpMethod: "POST",
        path: "/webhooks/github",
        headers: {
          "x-github-delivery": "deliv-push-1",
          "x-github-event": "push",
        },
        body: '{"repository":{"id":123}}',
      });

      const result = await handler(event, mockContext);
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body).message).toBe("OK");
    });

    it("returns 500 when event processing throws an unexpected error", async () => {
      jest.spyOn(validator, "validateWebhookSignature").mockReturnValueOnce({
        valid: true,
        rawBody: '{"repository":{"id":123}}',
      });
      jest.spyOn(deliveryOps, "claimDelivery").mockResolvedValueOnce(true);
      jest.spyOn(router, "routeWebhookEvent").mockRejectedValueOnce(new Error("Unexpected failure"));

      const event = createEvent({
        httpMethod: "POST",
        path: "/webhooks/github",
        headers: {
          "x-github-delivery": "deliv-push-err",
          "x-github-event": "push",
        },
        body: '{"repository":{"id":123}}',
      });

      const result = await handler(event, mockContext);
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).error).toBe("Internal server error");
      expect(deliveryOps.markDeliveryFailed).toHaveBeenCalledWith(
        "deliv-push-err",
        "Unexpected failure",
      );
    });
  });
});