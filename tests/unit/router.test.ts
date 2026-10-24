import { routeWebhookEvent } from "../../src/webhooks/router";
import * as handlers from "../../src/webhooks/handlers";
import { APIGatewayProxyEvent } from "aws-lambda";

jest.mock("../../src/webhooks/handlers", () => ({
  handlePushEvent: jest.fn().mockResolvedValue(undefined),
}));

describe("routeWebhookEvent", () => {
  function createEvent(headers: Record<string, string>): APIGatewayProxyEvent {
    return {
      headers,
      multiValueHeaders: {},
      httpMethod: "POST",
      isBase64Encoded: false,
      path: "/webhooks/github",
      pathParameters: null,
      queryStringParameters: null,
      multiValueQueryStringParameters: null,
      stageVariables: null,
      requestContext: {} as any,
      resource: "",
      body: null,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns handled: false when X-GitHub-Event header is missing", async () => {
    const event = createEvent({});
    const result = await routeWebhookEvent(event, {}, "delivery-1");
    expect(result.handled).toBe(false);
    expect(handlers.handlePushEvent).not.toHaveBeenCalled();
  });

  it("returns handled: false for unsupported events (e.g., issues)", async () => {
    const event = createEvent({ "x-github-event": "issues" });
    const result = await routeWebhookEvent(event, {}, "delivery-1");
    expect(result.handled).toBe(false);
    expect(result.eventType).toBe("issues");
    expect(handlers.handlePushEvent).not.toHaveBeenCalled();
  });

  it("dispatches push events to handlePushEvent and returns handled: true", async () => {
    const event = createEvent({ "x-github-event": "push" });
    const payload = {
      repository: { id: 12345 },
      installation: { id: 9999 },
    };

    const result = await routeWebhookEvent(event, payload, "delivery-1");
    expect(result.handled).toBe(true);
    expect(result.eventType).toBe("push");
    expect(handlers.handlePushEvent).toHaveBeenCalledWith(payload, "delivery-1", 9999);
  });
});