/**
 * The local dashboard runner end to end on DynamoDB Local: real HTTP server on
 * 127.0.0.1, table setup, opening signups, the full pipeline and handlers, and
 * the in-memory secret store. Tokens are signed with a local test key; GitHub
 * is never reached (no OAuth client secret is configured).
 */

import type { AddressInfo } from "net";
import { SSMClient } from "@aws-sdk/client-ssm";
import { loadRunnerConfig, isolateFromAws, startRunner, type StartedRunner } from "../../../scripts/dev-dashboard-runner";
import { newUserId } from "../fixtures";
import { itemsWith, tableName, useTestTable } from "../harness";
import { localAuthenticator, tokenFor } from "./app";

useTestTable();

const ORIGIN = "http://localhost:5173";
const WEBHOOK_TOKEN = "Runner-secret_token";
const WEBHOOK = `https://discord.com/api/webhooks/123456789012345678/${WEBHOOK_TOKEN}`;

let runner: StartedRunner;
let base: string;
const originalSend = SSMClient.prototype.send;
const realFetch = global.fetch;

beforeAll(async () => {
  const config = loadRunnerConfig(
    {
      LOGTO_ISSUER: "https://tenant.logto.app/oidc",
      LOGTO_JWKS_URI: "https://tenant.logto.app/oidc/jwks",
      API_AUDIENCE: "https://api.syncro.test",
      LOGTO_SPA_CLIENT_ID: "spaclientid01",
      GITHUB_APP_ID: "123456",
      GITHUB_APP_CLIENT_ID: "Iv23liLocal01",
      GITHUB_APP_SLUG: "syncro-local",
      DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT,
      DYNAMODB_TABLE_NAME: tableName(),
    },
    ["--open-signups", "--port", "0"],
  );
  isolateFromAws(process.env, config);
  runner = await startRunner(config, { authenticate: await localAuthenticator() });
  base = `http://127.0.0.1:${runner.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => runner.server.close(() => r()));
  SSMClient.prototype.send = originalSend;
});

beforeEach(() => {
  // Only the runner on 127.0.0.1 may be called.
  global.fetch = jest.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname !== "127.0.0.1") throw new Error(`network access is not allowed: ${url.hostname}`);
    return realFetch(input, init);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  global.fetch = realFetch;
});

async function api(method: string, path: string, uid: string | null, body?: unknown) {
  const res = await global.fetch(`${base}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      ...(uid ? { authorization: `Bearer ${await tokenFor(uid)}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: text ? JSON.parse(text) : {} };
}

it("listens on the loopback interface only", () => {
  expect((runner.server.address() as AddressInfo).address).toBe("127.0.0.1");
});

it("signs up, creates a destination in the local store and never returns the URL", async () => {
  const uid = newUserId();
  const boot = await api("POST", "/api/me/bootstrap", uid);
  expect(boot.status).toBe(200);
  expect(boot.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  const ws = boot.json.workspaceId as string;

  const created = await api("POST", `/api/workspaces/${ws}/destinations`, uid, { displayName: "Alerts", webhookUrl: WEBHOOK });
  expect(created.status).toBe(200);
  expect(created.json.webhookUrlMasked).toBe("discord.com/api/webhooks/123456789012345678/••••");
  expect(created.text).not.toContain(WEBHOOK_TOKEN);

  const name = `/syncro/local/ws/${ws}/dest/${created.json.destinationId}/discord-webhook-url`;
  expect(runner.store.list()).toContainEqual({ name, version: 1 });
  const items = await itemsWith(`WS#${ws}`, "DEST#");
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ status: "active", secret_ref: { name, version: 1 } });
  expect(JSON.stringify(items)).not.toContain(WEBHOOK_TOKEN);

  const listed = await api("GET", `/api/workspaces/${ws}/destinations`, uid);
  expect(listed.json.items).toHaveLength(1);
});

it("answers through the same pipeline: 401, 404 and contract errors with CORS", async () => {
  const unauth = await api("GET", "/api/me", null);
  expect(unauth.status).toBe(401);
  expect(unauth.json).toEqual({ error: "unauthenticated" });
  expect(unauth.headers.get("access-control-allow-origin")).toBe(ORIGIN);

  expect((await api("GET", "/api/nope", newUserId())).status).toBe(404);
  const big = await api("POST", "/api/me/bootstrap", newUserId(), { pad: "x".repeat(17_000) });
  expect(big.status).toBe(413);
  expect(big.json).toEqual({ error: "payload_too_large" });
});

it("fails closed on GitHub onboarding without a Dev App secret, and never reaches GitHub", async () => {
  const uid = newUserId();
  const ws = (await api("POST", "/api/me/bootstrap", uid)).json.workspaceId as string;
  const install = await api("POST", `/api/workspaces/${ws}/github/install-url`, uid);
  expect(install.status).toBe(200);
  expect(install.json.url).toMatch(/^https:\/\/github\.com\/apps\/syncro-local\/installations\/new\?state=[A-Za-z0-9_-]{43}$/);

  const state = new URL(install.json.url).searchParams.get("state");
  const claim = await api("POST", `/api/workspaces/${ws}/github/claim`, uid, { code: "abc123", installationId: "42", state });
  expect(claim.status).toBe(500);
  expect(claim.json).toEqual({ error: "internal_error" });
  // The state was not consumed, so the user can retry once the secret is configured.
  expect(await itemsWith(`GHSTATE#${state}`)).toHaveLength(1);
  const calls = (global.fetch as jest.Mock).mock.calls.map(([u]) => new URL(String(u)).hostname);
  expect(calls.every((h) => h === "127.0.0.1")).toBe(true);
});
