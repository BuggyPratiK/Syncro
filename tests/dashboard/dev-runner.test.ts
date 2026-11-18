/**
 * Local dashboard runner: configuration guards, isolation from AWS, the local
 * secret store, CORS parity with the deployed HTTP API, and HTTP translation.
 * No AWS and no external network (the HTTP tests talk to 127.0.0.1 only).
 */

import type { AddressInfo } from "net";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { SyncroStack } from "../../infra/lib/syncro-stack";
import { TABLE_SCHEMA } from "../ddb-local/harness";
import {
  LOCAL_TABLE_SCHEMA,
  RUNNER_CORS,
  RunnerConfigError,
  createLocalSecretStore,
  createRunnerServer,
  isolateFromAws,
  loadRunnerConfig,
} from "../../scripts/dev-dashboard-runner";

const BASE_ENV = {
  LOGTO_ISSUER: "https://dev-tenant.logto.app/oidc",
  LOGTO_JWKS_URI: "https://dev-tenant.logto.app/oidc/jwks",
  API_AUDIENCE: "https://api.syncro.local",
  LOGTO_SPA_CLIENT_ID: "devspaclient01",
  GITHUB_APP_ID: "777",
  GITHUB_APP_CLIENT_ID: "Iv23liDevApp01",
  GITHUB_APP_SLUG: "syncro-dev",
};

const WS = "ws_11111111-1111-4111-8111-111111111111";
const DEST = "8c0e6f1a-2b3c-4d5e-8f90-a1b2c3d4e5f6";
const DEST_PARAM = `/syncro/local/ws/${WS}/dest/${DEST}/discord-webhook-url`;

describe("runner configuration", () => {
  it("uses local defaults", () => {
    const c = loadRunnerConfig(BASE_ENV);
    expect(c).toMatchObject({
      port: 8787,
      corsOrigin: "http://localhost:5173",
      dynamodbEndpoint: "http://localhost:8000",
      tableName: "syncro-local",
      oauthClientSecret: undefined,
      openSignups: false,
    });
    expect(loadRunnerConfig(BASE_ENV, ["--open-signups", "--port", "9000"])).toMatchObject({ openSignups: true, port: 9000 });
  });

  it("names missing variables without printing any values", () => {
    expect(() => loadRunnerConfig({ ...BASE_ENV, LOGTO_ISSUER: "", GITHUB_APP_SLUG: undefined })).toThrow(
      "Missing environment variables: LOGTO_ISSUER, GITHUB_APP_SLUG",
    );
  });

  it.each([
    "https://dynamodb.ap-southeast-2.amazonaws.com",
    "http://10.0.0.5:8000",
    "http://dynamodb:8000",
    "not a url",
  ])("refuses a non-local DynamoDB endpoint: %s", (endpoint) => {
    expect(() => loadRunnerConfig({ ...BASE_ENV, DYNAMODB_ENDPOINT: endpoint })).toThrow(RunnerConfigError);
  });

  it.each(["*", "https://syncro.vercel.app", "http://evil.example:5173", "http://localhost"])("refuses CORS origin %s", (origin) => {
    expect(() => loadRunnerConfig({ ...BASE_ENV, CORS_ORIGIN: origin })).toThrow("CORS_ORIGIN");
  });

  it("requires https Logto URLs and a numeric App ID", () => {
    expect(() => loadRunnerConfig({ ...BASE_ENV, LOGTO_ISSUER: "http://dev-tenant.logto.app/oidc" })).toThrow("LOGTO_ISSUER");
    expect(() => loadRunnerConfig({ ...BASE_ENV, GITHUB_APP_ID: "abc" })).toThrow("GITHUB_APP_ID");
  });
});

describe("isolation from AWS", () => {
  const originalSend = SSMClient.prototype.send;
  afterEach(() => {
    SSMClient.prototype.send = originalSend;
  });

  it("replaces credentials and profiles, disables instance metadata and pins DynamoDB Local", () => {
    const env: NodeJS.ProcessEnv = {
      AWS_ACCESS_KEY_ID: "AKIAREALKEY",
      AWS_SECRET_ACCESS_KEY: "real-secret",
      AWS_SESSION_TOKEN: "real-session",
      AWS_PROFILE: "prod-admin",
      AWS_DEFAULT_PROFILE: "prod-admin",
    };
    isolateFromAws(env, loadRunnerConfig(BASE_ENV));
    expect(env).toMatchObject({
      AWS_ACCESS_KEY_ID: "local",
      AWS_SECRET_ACCESS_KEY: "local",
      AWS_EC2_METADATA_DISABLED: "true",
      DYNAMODB_ENDPOINT: "http://localhost:8000",
      DYNAMODB_TABLE_NAME: "syncro-local",
      SSM_PARAM_PREFIX: "/syncro/local",
    });
    for (const k of ["AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_DEFAULT_PROFILE"]) expect(env[k]).toBeUndefined();
  });

  it("makes every SSM call fail", async () => {
    isolateFromAws({}, loadRunnerConfig(BASE_ENV));
    const client = new SSMClient({ region: "ap-southeast-2" });
    await expect(client.send(new GetParameterCommand({ Name: "/syncro/prod/sender/github-webhook-secret" }))).rejects.toThrow(
      "SSM is not available in the local runner",
    );
  });
});

describe("local secret store", () => {
  it("follows Parameter Store's write rules and never exposes values", async () => {
    const store = createLocalSecretStore();
    expect(await store.put(DEST_PARAM, "https://discord.com/api/webhooks/1/secret-a", { overwrite: false })).toEqual({ version: 1 });
    await expect(store.put(DEST_PARAM, "https://discord.com/api/webhooks/1/secret-b", { overwrite: false })).rejects.toMatchObject({
      code: "secret_unavailable",
    });
    expect(await store.put(DEST_PARAM, "https://discord.com/api/webhooks/1/secret-c", { overwrite: true })).toEqual({ version: 2 });
    expect(store.list()).toEqual([{ name: DEST_PARAM, version: 2 }]);
    expect(JSON.stringify(store)).not.toContain("secret-");
  });

  it("refuses names outside the destination namespace", async () => {
    const store = createLocalSecretStore();
    for (const name of ["/syncro/local/dashboard/github-oauth-client-secret", "/syncro/prod/sender/github-webhook-secret", "/other"]) {
      await expect(store.put(name, "x", { overwrite: true })).rejects.toThrow("non-destination");
    }
  });
});

describe("parity with the deployed API", () => {
  it("CORS matches the HTTP API in the CDK template", () => {
    const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
    const stack = new SyncroStack(app, "RunnerParity", {
      env: { account: "123456789012", region: "ap-southeast-2" },
      githubAppId: "123456",
      dashboard: {
        githubAppClientId: "Iv23liTestClient01",
        githubAppSlug: "syncro-test",
        logtoIssuer: "https://tenant.logto.app/oidc",
        logtoJwksUri: "https://tenant.logto.app/oidc/jwks",
        apiAudience: "https://api.syncro.test",
        logtoSpaClientId: "spaclientid01",
        corsOrigin: "https://syncro.vercel.app",
      },
    });
    const api = Object.values(Template.fromStack(stack).findResources("AWS::ApiGatewayV2::Api"))[0] as {
      Properties: { CorsConfiguration: Record<string, unknown> };
    };
    const cors = api.Properties.CorsConfiguration;
    expect(cors.AllowMethods).toEqual([...RUNNER_CORS.allowMethods]);
    expect(cors.AllowHeaders).toEqual([...RUNNER_CORS.allowHeaders]);
    expect(cors.ExposeHeaders).toEqual([...RUNNER_CORS.exposeHeaders]);
    expect(cors.MaxAge).toBe(RUNNER_CORS.maxAgeSeconds);
    expect(cors.AllowCredentials).toBe(false);
  });

  it("creates the local table with the production key schema and index", () => {
    expect(LOCAL_TABLE_SCHEMA).toEqual(TABLE_SCHEMA);
  });
});

describe("HTTP translation", () => {
  const ORIGIN = "http://localhost:5173";
  let events: APIGatewayProxyEventV2[];
  let logLines: string[];
  let base: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    events = [];
    logLines = [];
    const server = createRunnerServer(
      async (event) => {
        events.push(event);
        return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true }) };
      },
      ORIGIN,
      (line) => logLines.push(line),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise((r) => server.close(() => r()));
  });
  afterEach(() => close());

  it("answers a preflight from the allowed origin with the deployed CORS settings", async () => {
    const res = await fetch(`${base}/api/me/bootstrap`, {
      method: "OPTIONS",
      headers: { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-methods")).toBe("GET,POST,PATCH,PUT");
    expect(res.headers.get("access-control-allow-headers")).toBe("authorization,content-type");
    expect(res.headers.get("access-control-max-age")).toBe("600");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(events).toEqual([]);
  });

  it.each([
    ["another origin", { origin: "http://evil.example", "access-control-request-method": "POST" }],
    ["a method that is not allowed", { origin: ORIGIN, "access-control-request-method": "DELETE" }],
    ["a header that is not allowed", { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "x-api-key" }],
  ])("grants no CORS for a preflight with %s", async (_label, headers) => {
    const res = await fetch(`${base}/api/me`, { method: "OPTIONS", headers });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("passes the exact request to the handler as an API Gateway event", async () => {
    const body = JSON.stringify({ displayName: "Alerts" });
    const res = await fetch(`${base}/api/workspaces/${WS}/repos?limit=5&cursor=a&cursor=b`, {
      method: "POST",
      headers: { origin: ORIGIN, authorization: "Bearer x.y.z", "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-expose-headers")).toBe("retry-after");
    const e = events[0];
    expect(e.rawPath).toBe(`/api/workspaces/${WS}/repos`);
    expect(e.requestContext.http.method).toBe("POST");
    expect(e.queryStringParameters).toEqual({ limit: "5", cursor: "a,b" });
    expect(e.headers.authorization).toBe("Bearer x.y.z");
    expect(e.isBase64Encoded).toBe(true);
    expect(Buffer.from(e.body!, "base64").toString()).toBe(body);
  });

  it("adds no CORS headers for another origin", async () => {
    const res = await fetch(`${base}/api/me`, { headers: { origin: "http://evil.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses a body over 1 MiB without passing it on", async () => {
    const res = await fetch(`${base}/api/me/bootstrap`, { method: "POST", body: "x".repeat(1024 * 1024 + 1) }).catch(() => null);
    if (res) {
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "payload_too_large" });
    }
    expect(events).toEqual([]);
  });

  it("logs only method, path, status and timing", async () => {
    await fetch(`${base}/api/me?secret=value`, { headers: { authorization: "Bearer secret.token.value" } });
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toMatch(/^GET \/api\/me 200 \d+ms$/);
  });
});
