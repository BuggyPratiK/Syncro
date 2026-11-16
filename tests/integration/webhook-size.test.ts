/**
 * Webhook body size at the handler level: there is no application body cap on
 * the webhook route (the platform's ~6 MB limit applies), a correctly signed
 * 1 MB body is accepted, and an invalid signature on a large body is rejected
 * before the body is parsed.
 */

import { createHmac } from "crypto";
import { APIGatewayProxyEvent, Context } from "aws-lambda";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { handler } from "../../src/handler";
import { ddb } from "../../src/db/client";
import { setParameterReaderForTests } from "../../src/config/secrets";

jest.mock("../../src/db/client", () => ({ ddb: { send: jest.fn() } }));

const SECRET = "size-test-webhook-secret";
setParameterReaderForTests(async (name) => (name.endsWith("/sender/github-webhook-secret") ? SECRET : "dummy-private-key"));

const context = { awsRequestId: "size-req", getRemainingTimeInMillis: () => 15_000 } as unknown as Context;

/** A push payload padded to roughly `bytes` with a long commit message. */
function bigPushBody(bytes: number): string {
  const base = {
    ref: "refs/heads/main",
    after: "a".repeat(40),
    repository: { id: 4242, full_name: "acme/big", name: "big", owner: { login: "acme" }, html_url: "https://github.com/acme/big" },
    installation: { id: 77 },
    commits: [{ id: "a".repeat(40), message: "", distinct: true, added: [], removed: [], modified: [] }],
  };
  const skeleton = JSON.stringify(base).length;
  base.commits[0].message = "x".repeat(Math.max(0, bytes - skeleton));
  return JSON.stringify(base);
}

function event(body: string, signature: string): APIGatewayProxyEvent {
  return {
    httpMethod: "POST",
    path: "/webhooks/github",
    body,
    isBase64Encoded: false,
    headers: { "x-hub-signature-256": signature, "x-github-event": "push", "x-github-delivery": "size-delivery-1" },
    multiValueHeaders: {},
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as never,
    resource: "",
  };
}

const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

describe("webhook body size", () => {
  beforeEach(() => {
    (ddb.send as jest.Mock).mockReset().mockImplementation(async (cmd: unknown) => (cmd instanceof GetCommand ? { Item: undefined } : {}));
  });

  it("accepts a correctly signed 1 MB body", async () => {
    const body = bigPushBody(1024 * 1024);
    expect(Buffer.byteLength(body)).toBeGreaterThanOrEqual(1024 * 1024);

    const res = await handler(event(body, sign(body)), context);

    expect(res.statusCode).toBe(200); // processed (here: ignored, the repo is not registered)
    expect(ddb.send).toHaveBeenCalled();
  });

  it("rejects an invalid signature on a large body before parsing it or touching the database", async () => {
    const body = bigPushBody(1024 * 1024);
    const parse = jest.spyOn(JSON, "parse");

    const res = await handler(event(body, `sha256=${"0".repeat(64)}`), context);

    expect(res.statusCode).toBe(401);
    expect(parse.mock.calls.some(([text]) => typeof text === "string" && text.length > 1000)).toBe(false);
    expect(ddb.send).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it("rejects a body altered after signing (no truncation is ever accepted)", async () => {
    const body = bigPushBody(256 * 1024);
    const res = await handler(event(body.slice(0, -10), sign(body)), context);
    expect(res.statusCode).toBe(401);
  });
});
