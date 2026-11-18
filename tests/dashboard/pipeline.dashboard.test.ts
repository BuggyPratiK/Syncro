/**
 * Dashboard request pipeline: route registry and default deny, step order,
 * membership (404/403), rate limiting, body cap, strict validation, the
 * error envelope and audit lines. Dependencies are stubs; no AWS, no network.
 */

import * as fs from "fs";
import * as path from "path";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { ROUTES, type RouteId, type RouteSpec } from "../../src/contracts/routes";
import { API_ERROR_CODES, API_ERROR_STATUS, ContractError } from "../../src/contracts/errors";
import { REQUEST_LIMITS } from "../../src/contracts/constants";
import type { WorkspaceContext } from "../../src/contracts/data-ops";
import type { Role } from "../../src/contracts/roles";
import { AuthError } from "../../src/dashboard/auth";
import { createDashboardHandler, type PipelineDeps, type RouteHandler } from "../../src/dashboard/pipeline";
import { matchRoute, ROUTE_SCHEMAS } from "../../src/dashboard/registry";
import { handler as lambdaHandler } from "../../src/dashboard/handler";
import { resetEnvCacheForTests } from "../../src/config/env";

const UID = "logto:abcdef123456";
const WS = "ws_11111111-1111-4111-8111-111111111111";
const DEST = "8c0e6f1a-2b3c-4d5e-8f90-a1b2c3d4e5f6";
const LISTING = "3f2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d";
const TOKEN = "eyJhbGciOiJFUzM4NCJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
const WEBHOOK_URL = "https://discord.com/api/webhooks/123456789012345678/very-secret-token-value";
const STATE = "A".repeat(43);

/** A concrete path and a valid body for each route. */
const SAMPLES: Record<RouteId, { path: string; body?: unknown; query?: Record<string, string> }> = {
  "me.get": { path: "/api/me" },
  "me.bootstrap": { path: "/api/me/bootstrap", body: {} },
  "github.installUrl": { path: `/api/workspaces/${WS}/github/install-url`, body: {} },
  "github.claim": {
    path: `/api/workspaces/${WS}/github/claim`,
    body: { code: "abc123", installationId: "42", state: STATE },
  },
  "github.authorizeUrl": { path: `/api/workspaces/${WS}/github/authorize-url`, body: {} },
  "github.repoListing": {
    path: `/api/workspaces/${WS}/github/repo-listing`,
    body: { code: "abc123", installationId: "42", state: STATE },
  },
  "installations.list": { path: `/api/workspaces/${WS}/installations`, query: { limit: "10" } },
  "repos.list": { path: `/api/workspaces/${WS}/repos` },
  "repos.register": { path: `/api/workspaces/${WS}/repos`, body: { listingId: LISTING, repoId: "77" } },
  "repos.update": { path: `/api/workspaces/${WS}/repos/77`, body: { isActive: false } },
  "destinations.list": { path: `/api/workspaces/${WS}/destinations` },
  "destinations.create": { path: `/api/workspaces/${WS}/destinations`, body: { displayName: "Alerts", webhookUrl: WEBHOOK_URL } },
  "destinations.update": { path: `/api/workspaces/${WS}/destinations/${DEST}`, body: { displayName: "Renamed" } },
  "destinations.replaceWebhook": { path: `/api/workspaces/${WS}/destinations/${DEST}/webhook`, body: { webhookUrl: WEBHOOK_URL } },
  "deliveries.list": { path: `/api/workspaces/${WS}/deliveries` },
};

const spec = (id: RouteId) => ROUTES.find((r) => r.id === id) as RouteSpec;

function event(
  method: string,
  rawPath: string,
  o: { body?: unknown; rawBody?: string; base64?: boolean; auth?: string | null; query?: Record<string, string>; routeKey?: string } = {},
): APIGatewayProxyEventV2 {
  const text = o.rawBody ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
  return {
    version: "2.0",
    routeKey: o.routeKey ?? "$default",
    rawPath,
    rawQueryString: "",
    headers: o.auth === null ? {} : { authorization: o.auth ?? `Bearer ${TOKEN}` },
    queryStringParameters: o.query,
    requestContext: { requestId: "req-1", http: { method, path: rawPath } } as APIGatewayProxyEventV2["requestContext"],
    body: text === undefined ? undefined : o.base64 ? Buffer.from(text).toString("base64") : text,
    isBase64Encoded: Boolean(o.base64),
  };
}

function sampleEvent(id: RouteId, extra: Parameters<typeof event>[2] = {}) {
  const s = SAMPLES[id];
  return event(spec(id).method, s.path, { body: s.body, query: s.query, ...extra });
}

function setup(o: { role?: Role | null; rate?: "allow" | "deny" | "fail"; handlers?: PipelineDeps["handlers"] } = {}) {
  const calls: string[] = [];
  const handlerFn = jest.fn<ReturnType<RouteHandler>, Parameters<RouteHandler>>(async () => ({ status: 200, body: { ok: true } }));
  const deps: PipelineDeps = {
    authenticate: jest.fn(async (h: string | undefined) => {
      calls.push("auth");
      if (h !== `Bearer ${TOKEN}`) throw new AuthError("invalid_token");
      return { userId: UID, issuer: "https://tenant.logto.app/oidc" };
    }),
    resolveWorkspaceContext: jest.fn(async (userId: string, workspaceId: string) => {
      calls.push("membership");
      const role = o.role === undefined ? "owner" : o.role;
      return role ? ({ userId, workspaceId, role } as WorkspaceContext) : null;
    }),
    consumeRateLimit: jest.fn(async () => {
      calls.push("rate");
      if (o.rate === "fail") throw new Error("store down");
      return o.rate === "deny" ? { allowed: false, retryAfterSeconds: 17 } : { allowed: true, retryAfterSeconds: 0 };
    }),
    handlers:
      o.handlers ??
      (Object.fromEntries(ROUTES.map((r) => [r.id, handlerFn])) as PipelineDeps["handlers"]),
  };
  return { handle: createDashboardHandler(() => deps), deps, calls, handlerFn };
}

const bodyOf = (r: { body?: string }) => JSON.parse(r.body ?? "null");

let logs: string[];
beforeEach(() => {
  logs = [];
  jest.spyOn(console, "log").mockImplementation((line: string) => void logs.push(String(line)));
});
afterEach(() => jest.restoreAllMocks());

describe("route registry", () => {
  it("has schemas for exactly the 15 contract routes", () => {
    expect(ROUTES).toHaveLength(15);
    expect(Object.keys(ROUTE_SCHEMAS).sort()).toEqual(ROUTES.map((r) => r.id).sort());
  });

  it.each(ROUTES.map((r) => [r.id, r] as const))("matches %s only by its own method and path", (id, r) => {
    expect(matchRoute(r.method, SAMPLES[id].path)?.spec.id).toBe(id);
    for (const other of ["GET", "POST", "PATCH", "PUT", "DELETE"].filter((m) => m !== r.method)) {
      expect(matchRoute(other, SAMPLES[id].path)?.spec.id).not.toBe(id);
    }
  });

  it.each(ROUTES.map((r) => [r.id] as const))("serves %s when a handler is registered", async (id) => {
    const { handle, handlerFn } = setup();
    const res = await handle(sampleEvent(id));
    expect(res.statusCode).toBe(200);
    expect(handlerFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["GET", "/webhooks/github"],
    ["POST", "/webhooks/github"],
    ["GET", "/health"],
    ["GET", "/api"],
    ["GET", "/api/me/"],
    ["DELETE", `/api/workspaces/${WS}/repos/77`],
    ["GET", `/api/workspaces/${WS}/repos/77/extra`],
    ["OPTIONS", "/api/me"],
  ])("answers 404 for %s %s, before authentication", async (method, p) => {
    const { handle, calls } = setup();
    const res = await handle(event(method, p));
    expect(res.statusCode).toBe(404);
    expect(bodyOf(res)).toEqual({ error: "not_found" });
    expect(calls).toEqual([]);
  });

  it("answers 404 for a known route without a handler (default deny)", async () => {
    const { handle, calls } = setup({ handlers: {} });
    for (const r of ROUTES) {
      const res = await handle(sampleEvent(r.id));
      expect(res.statusCode).toBe(404);
    }
    expect(calls).toEqual([]);
  });

  it("answers 404 when API Gateway's route key disagrees with the path", async () => {
    const { handle } = setup();
    const res = await handle(sampleEvent("me.get", { routeKey: "POST /api/me/bootstrap" }));
    expect(res.statusCode).toBe(404);
    const ok = await handle(sampleEvent("me.get", { routeKey: "GET /api/me" }));
    expect(ok.statusCode).toBe(200);
  });

  it("deploys with no handlers yet: every route is 404, and invalid configuration is 500", async () => {
    const saved = { ...process.env };
    try {
      resetEnvCacheForTests();
      expect((await lambdaHandler(sampleEvent("me.get"))).statusCode).toBe(500);

      Object.assign(process.env, {
        LOGTO_ISSUER: "https://tenant.logto.app/oidc",
        LOGTO_JWKS_URI: "https://tenant.logto.app/oidc/jwks",
        API_AUDIENCE: "https://api.syncro.test",
        LOGTO_SPA_CLIENT_ID: "spaclientid01",
        CORS_ORIGIN: "https://syncro.vercel.app",
        GITHUB_APP_CLIENT_ID: "Iv23liTestClient01",
        GITHUB_APP_SLUG: "syncro-test",
        GITHUB_OAUTH_CLIENT_SECRET_PARAM: "/syncro/prod/dashboard/github-oauth-client-secret",
      });
      resetEnvCacheForTests();
      for (const r of ROUTES) {
        const res = (await lambdaHandler(sampleEvent(r.id))) as { statusCode: number; body?: string };
        expect(res.statusCode).toBe(404);
        expect(bodyOf(res)).toEqual({ error: "not_found" });
      }
    } finally {
      process.env = saved;
      resetEnvCacheForTests();
    }
  });
});

describe("authentication", () => {
  it.each(ROUTES.map((r) => [r.id] as const))("%s requires a valid token", async (id) => {
    const { handle, handlerFn } = setup();
    for (const auth of [null, "Bearer wrong.token.value"]) {
      const res = await handle(sampleEvent(id, { auth }));
      expect(res.statusCode).toBe(401);
      expect(bodyOf(res)).toEqual({ error: "unauthenticated" });
      expect(res.headers?.["www-authenticate"]).toBe("Bearer");
    }
    expect(handlerFn).not.toHaveBeenCalled();
  });

  it("fails closed with 500 when the signing keys cannot be fetched", async () => {
    const { handle, deps } = setup();
    (deps.authenticate as jest.Mock).mockRejectedValueOnce(new AuthError("jwks_unavailable"));
    const res = await handle(sampleEvent("me.get"));
    expect(res.statusCode).toBe(500);
    expect(bodyOf(res)).toEqual({ error: "internal_error" });
  });

  it("fails closed with 500 when configuration is invalid", async () => {
    const handle = createDashboardHandler(() => {
      throw new Error("bad config");
    });
    const res = await handle(sampleEvent("me.get"));
    expect(res.statusCode).toBe(500);
    expect(bodyOf(res)).toEqual({ error: "internal_error" });
  });
});

describe("workspace membership", () => {
  const workspaceRoutes = ROUTES.filter((r) => r.access !== "token");
  const ownerRoutes = ROUTES.filter((r) => r.access === "owner");
  const memberRoutes = ROUTES.filter((r) => r.access === "member");

  it("covers 13 workspace routes and 2 user-level routes", () => {
    expect(workspaceRoutes).toHaveLength(13);
    expect(ROUTES.filter((r) => r.access === "token").map((r) => r.id).sort()).toEqual(["me.bootstrap", "me.get"]);
  });

  it.each(workspaceRoutes.map((r) => [r.id] as const))(
    "%s answers 404 to a non-member or an inactive workspace, before any other check",
    async (id) => {
      const { handle, calls, handlerFn } = setup({ role: null });
      const res = await handle(sampleEvent(id));
      expect(res.statusCode).toBe(404);
      expect(bodyOf(res)).toEqual({ error: "not_found" });
      expect(calls).toEqual(["auth", "membership"]);
      expect(handlerFn).not.toHaveBeenCalled();
    },
  );

  it.each(ownerRoutes.map((r) => [r.id] as const))("%s answers 403 to a member below owner", async (id) => {
    for (const role of ["member", "admin"] as const) {
      const { handle, handlerFn } = setup({ role });
      const res = await handle(sampleEvent(id));
      expect(res.statusCode).toBe(403);
      expect(bodyOf(res)).toEqual({ error: "forbidden" });
      expect(handlerFn).not.toHaveBeenCalled();
    }
  });

  it.each(memberRoutes.map((r) => [r.id] as const))("%s is open to every active member", async (id) => {
    const { handle } = setup({ role: "member" });
    expect((await handle(sampleEvent(id))).statusCode).toBe(200);
  });

  it("passes the membership proof to the handler and never reads membership on user-level routes", async () => {
    const { handle, deps, handlerFn } = setup();
    await handle(sampleEvent("repos.list"));
    expect(deps.resolveWorkspaceContext).toHaveBeenCalledWith(UID, WS);
    expect(handlerFn.mock.calls[0][0].ctx).toMatchObject({ userId: UID, workspaceId: WS, role: "owner" });

    const userLevel = setup();
    await userLevel.handle(sampleEvent("me.get"));
    await userLevel.handle(sampleEvent("me.bootstrap"));
    expect(userLevel.deps.resolveWorkspaceContext).not.toHaveBeenCalled();
    expect(userLevel.handlerFn.mock.calls[0][0].ctx).toBeNull();
  });

  it.each([
    `/api/workspaces/ws_not-a-uuid/repos`,
    `/api/workspaces/WS_11111111-1111-4111-8111-111111111111/repos`,
    `/api/workspaces/${WS}%23META/repos`,
  ])("answers 404 for a malformed workspace ID without a membership read: %s", async (p) => {
    const { handle, calls } = setup();
    const res = await handle(event("GET", p));
    expect(res.statusCode).toBe(404);
    expect(calls).toEqual(["auth"]);
  });

  it("answers 404 for a malformed resource ID", async () => {
    const { handle } = setup();
    expect((await handle(event("PATCH", `/api/workspaces/${WS}/repos/07`, { body: { isActive: true } }))).statusCode).toBe(404);
    expect((await handle(event("PATCH", `/api/workspaces/${WS}/destinations/not-a-uuid`, { body: { isActive: true } }))).statusCode).toBe(404);
  });
});

describe("per-user rate limits", () => {
  it.each(ROUTES.map((r) => [r.id, r.rateBucket] as const))("%s uses bucket %s", async (id, bucket) => {
    const { handle, deps } = setup();
    await handle(sampleEvent(id));
    if (bucket) expect(deps.consumeRateLimit).toHaveBeenCalledWith(UID, bucket);
    else expect(deps.consumeRateLimit).not.toHaveBeenCalled();
  });

  it("maps buckets as specified: bootstrap, four GitHub routes, five writes, reads unlimited", () => {
    const by = (b: string | null) => ROUTES.filter((r) => r.rateBucket === b).map((r) => r.id).sort();
    expect(by("bootstrap")).toEqual(["me.bootstrap"]);
    expect(by("github")).toEqual(["github.authorizeUrl", "github.claim", "github.installUrl", "github.repoListing"]);
    expect(by("write")).toEqual([
      "destinations.create",
      "destinations.replaceWebhook",
      "destinations.update",
      "repos.register",
      "repos.update",
    ]);
    expect(by(null).every((id) => spec(id as RouteId).method === "GET")).toBe(true);
  });

  it("answers 429 with Retry-After when the limit is reached, after membership", async () => {
    const { handle, calls, handlerFn } = setup({ rate: "deny" });
    const res = await handle(sampleEvent("destinations.create"));
    expect(res.statusCode).toBe(429);
    expect(bodyOf(res)).toEqual({ error: "rate_limited" });
    expect(res.headers?.["retry-after"]).toBe("17");
    expect(calls).toEqual(["auth", "membership", "rate"]);
    expect(handlerFn).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when the counter store fails", async () => {
    const { handle, handlerFn } = setup({ rate: "fail" });
    const res = await handle(sampleEvent("me.bootstrap"));
    expect(res.statusCode).toBe(503);
    expect(bodyOf(res)).toEqual({ error: "rate_limit_unavailable" });
    expect(handlerFn).not.toHaveBeenCalled();
  });

  it("does not count requests from non-members", async () => {
    const { handle, deps } = setup({ role: null });
    await handle(sampleEvent("destinations.create"));
    expect(deps.consumeRateLimit).not.toHaveBeenCalled();
  });
});

describe("request body cap", () => {
  const padded = (bytes: number) => {
    const base = JSON.stringify({ displayName: "Alerts", webhookUrl: WEBHOOK_URL, pad: "" });
    return base.replace('"pad":""', `"pad":"${"x".repeat(bytes - base.length)}"`);
  };

  it("refuses 16,385 decoded bytes with 413 before authentication or parsing", async () => {
    const { handle, calls } = setup();
    const text = padded(REQUEST_LIMITS.maxBodyBytes + 1);
    expect(Buffer.byteLength(text)).toBe(16_385);
    for (const base64 of [false, true]) {
      const res = await handle(event("POST", SAMPLES["destinations.create"].path, { rawBody: text, base64 }));
      expect(res.statusCode).toBe(413);
      expect(bodyOf(res)).toEqual({ error: "payload_too_large" });
    }
    expect(calls).toEqual([]);
  });

  it("measures multi-byte characters in bytes", async () => {
    const { handle } = setup();
    const name = "é".repeat(8193); // 16,386 bytes in UTF-8
    const res = await handle(event("POST", SAMPLES["destinations.create"].path, { rawBody: JSON.stringify({ displayName: name }) }));
    expect(res.statusCode).toBe(413);
  });

  it("lets exactly 16,384 bytes through to validation", async () => {
    const { handle, calls } = setup();
    const text = padded(REQUEST_LIMITS.maxBodyBytes);
    const res = await handle(event("POST", SAMPLES["destinations.create"].path, { rawBody: text }));
    // The extra key fails strict validation, which proves the size check passed.
    expect(res.statusCode).toBe(400);
    expect(calls).toEqual(["auth", "membership", "rate"]);
  });

  it("refuses a base64 body that is not valid UTF-8", async () => {
    const { handle } = setup();
    const e = event("POST", "/api/me/bootstrap", {});
    e.body = Buffer.from([0xff, 0xfe, 0xfd]).toString("base64");
    e.isBase64Encoded = true;
    expect((await handle(e)).statusCode).toBe(400);
  });
});

describe("strict validation", () => {
  async function invalid(id: RouteId, o: Parameters<typeof event>[2]) {
    const { handle, handlerFn } = setup();
    const res = await handle(event(spec(id).method, SAMPLES[id].path, o));
    expect(res.statusCode).toBe(400);
    expect(handlerFn).not.toHaveBeenCalled();
    return bodyOf(res) as { error: string; fields?: string[] };
  }

  it("rejects malformed JSON", async () => {
    expect(await invalid("me.bootstrap", { rawBody: "{not json" })).toEqual({ error: "invalid_request", fields: ["(root)"] });
  });

  it("rejects unknown keys, including a workspace ID, without naming them", async () => {
    const body = await invalid("destinations.create", {
      body: { displayName: "A", webhookUrl: WEBHOOK_URL, workspace_id: WS, "<script>": 1 },
    });
    expect(body).toEqual({ error: "invalid_request", fields: ["(root)"] });
  });

  it("rejects string booleans and reports field paths only", async () => {
    expect(await invalid("repos.update", { body: { isActive: "false" } })).toEqual({ error: "invalid_request", fields: ["isActive"] });
  });

  it("never echoes a submitted value", async () => {
    const res = await invalid("destinations.create", { body: { displayName: "", webhookUrl: `${WEBHOOK_URL}${"x".repeat(300)}` } });
    expect(JSON.stringify(res)).not.toContain("very-secret-token-value");
    expect(res.fields).toEqual(["displayName", "webhookUrl"]);
  });

  it("rejects a body on read routes and query parameters on routes without a query", async () => {
    expect(await invalid("repos.list", { rawBody: "{}" })).toEqual({ error: "invalid_request", fields: ["(root)"] });
    expect(await invalid("me.bootstrap", { body: {}, query: { x: "1" } })).toEqual({ error: "invalid_request", fields: ["query.(root)"] });
  });

  it("validates list queries", async () => {
    expect((await invalid("repos.list", { query: { limit: "51" } })).fields).toEqual(["query.limit"]);
    expect((await invalid("repos.list", { query: { limit: "abc" } })).fields).toEqual(["query.limit"]);
    const { handle, handlerFn } = setup();
    await handle(event("GET", SAMPLES["repos.list"].path, { query: { limit: "50", cursor: "abc_DEF-1" } }));
    expect(handlerFn.mock.calls[0][0].query).toEqual({ limit: 50, cursor: "abc_DEF-1" });
  });

  it("treats an absent body as an empty object on body routes", async () => {
    const { handle } = setup();
    expect((await handle(event("POST", "/api/me/bootstrap"))).statusCode).toBe(200);
    expect((await handle(event("POST", SAMPLES["destinations.create"].path))).statusCode).toBe(400);
  });

  it("validates after membership and rate limiting", async () => {
    const { handle, calls } = setup();
    await handle(event("POST", SAMPLES["destinations.create"].path, { body: {} }));
    expect(calls).toEqual(["auth", "membership", "rate"]);
  });
});

describe("responses", () => {
  it("maps a ContractError to its contract status and envelope", async () => {
    const handlers = { "destinations.create": jest.fn(async () => Promise.reject(new ContractError("secret_store_busy"))) };
    const { handle } = setup({ handlers });
    const res = await handle(sampleEvent("destinations.create"));
    expect(res.statusCode).toBe(503);
    expect(bodyOf(res)).toEqual({ error: "secret_store_busy" });
  });

  it("hides unexpected failures behind 500 internal_error", async () => {
    const handlers = { "repos.list": jest.fn(async () => Promise.reject(new Error(`boom ${WEBHOOK_URL}`))) };
    const { handle } = setup({ handlers });
    const res = await handle(sampleEvent("repos.list"));
    expect(res.statusCode).toBe(500);
    expect(res.body).toBe(JSON.stringify({ error: "internal_error" }));
    expect(logs.join("\n")).not.toContain("very-secret-token-value");
  });

  it("only ever returns contract error codes with their contract status", async () => {
    const scenarios: Array<[ReturnType<typeof setup>, APIGatewayProxyEventV2]> = [
      [setup(), event("GET", "/nope")],
      [setup(), sampleEvent("me.get", { auth: null })],
      [setup({ role: null }), sampleEvent("repos.list")],
      [setup({ role: "member" }), sampleEvent("repos.register")],
      [setup({ rate: "deny" }), sampleEvent("repos.register")],
      [setup({ rate: "fail" }), sampleEvent("repos.register")],
      [setup(), event("POST", "/api/me/bootstrap", { rawBody: "x".repeat(20_000) })],
      [setup(), event("POST", "/api/me/bootstrap", { rawBody: "[" })],
    ];
    for (const [s, e] of scenarios) {
      const res = await s.handle(e);
      const body = bodyOf(res);
      expect(API_ERROR_CODES).toContain(body.error);
      expect(res.statusCode).toBe(API_ERROR_STATUS[body.error as keyof typeof API_ERROR_STATUS]);
      expect(Object.keys(body).every((k) => k === "error" || k === "fields")).toBe(true);
      expect(res.headers).toMatchObject({ "content-type": "application/json", "cache-control": "no-store" });
      expect(res.headers?.["access-control-allow-origin"]).toBeUndefined();
    }
  });
});

describe("audit log", () => {
  const audits = () => logs.map((l) => JSON.parse(l)).filter((l) => l.audit === "write");

  it("writes one line per write request with identifiers and outcome only", async () => {
    const { handle } = setup();
    await handle(sampleEvent("destinations.create"));
    const lines = audits();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      requestId: "req-1",
      route: "destinations.create",
      userId: UID,
      workspaceId: WS,
      status: 200,
      outcome: "ok",
    });
    const text = logs.join("\n");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("very-secret-token-value");
    expect(text).not.toContain("discord.com/api/webhooks");
    expect(text.toLowerCase()).not.toContain("authorization");
  });

  it("records refusals too, with the returned code", async () => {
    const { handle } = setup({ role: "member" });
    await handle(sampleEvent("destinations.replaceWebhook"));
    expect(audits()).toEqual([expect.objectContaining({ route: "destinations.replaceWebhook", status: 403, outcome: "forbidden" })]);
  });

  it("writes no audit line for read routes", async () => {
    const { handle } = setup();
    await handle(sampleEvent("destinations.list"));
    expect(audits()).toEqual([]);
  });
});

describe("webhook isolation", () => {
  it("the webhook entry point does not load the dashboard pipeline", () => {
    const root = path.join(__dirname, "../../src");
    const files = fs.readdirSync(path.join(root, "webhooks"), { recursive: true }) as string[];
    const sources = [path.join(root, "handler.ts"), ...files.filter((f) => f.endsWith(".ts")).map((f) => path.join(root, "webhooks", f))];
    for (const file of sources) expect(fs.readFileSync(file, "utf8")).not.toMatch(/from ["'][./]*dashboard\//);
  });
});
