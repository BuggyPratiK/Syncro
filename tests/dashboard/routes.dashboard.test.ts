/**
 * The 15 connected route handlers, exercised through the real pipeline.
 * Data operations are fakes (the DynamoDB behaviour of the real operations is
 * covered by the DynamoDB Local suites); the GitHub verification library is
 * the real one over a fake transport. No AWS, no network.
 */

import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ROUTES, type RouteId } from "../../src/contracts/routes";
import { ContractError } from "../../src/contracts/errors";
import type {
  DestinationRecord,
  GitHubTransport,
  InstallationRecord,
  ListingSnapshot,
  RepoRecord,
  WorkspaceContext,
} from "../../src/contracts/data-ops";
import type { Role } from "../../src/contracts/roles";
import type { DashboardEnv } from "../../src/config/env";
import { AuthError } from "../../src/dashboard/auth";
import { createDashboardHandler, type PipelineDeps } from "../../src/dashboard/pipeline";
import { createRouteHandlers } from "../../src/dashboard/routes";
import { productionServices, type RouteServices } from "../../src/dashboard/routes/services";
import { createGitHubVerification } from "../../src/github/verification";
import { ListingTooLargeError } from "../../src/db/operations/listing.ops";
import { bootstrapUser, getMe, setTenancyDepsForTests } from "../../src/db/operations/tenancy.ops";
import { createDestination, replaceDestinationWebhook } from "../../src/db/operations/tenant-destination.ops";
import { SecretUnavailableError } from "../../src/config/secrets";

const UID = "logto:abcdef123456";
const ISSUER = "https://tenant.logto.app/oidc";
const WS = "ws_11111111-1111-4111-8111-111111111111";
const OTHER_WS = "ws_22222222-2222-4222-8222-222222222222";
const DEST = "8c0e6f1a-2b3c-4d5e-8f90-a1b2c3d4e5f6";
const LISTING = "3f2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d";
const TOKEN = "eyJhbGciOiJFUzM4NCJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
const WEBHOOK_TOKEN = "very-secret-webhook-token-value";
const WEBHOOK_URL = `https://discord.com/api/webhooks/123456789012345678/${WEBHOOK_TOKEN}`;
const STATE = "S".repeat(43);
const OAUTH_CODE = "oauthcode123";
const GITHUB_TOKEN = "gho_usertokenvalue0123456789";
const CLIENT_SECRET = "oauth-client-secret-value";
const GH_USER = 9001;
const NOW = "2026-11-18T10:00:00.000Z";

// ─── Sample records (with extra internal fields that must never be returned) ──

const installation: InstallationRecord = {
  installationId: "42",
  workspaceId: WS,
  accountId: String(GH_USER),
  accountLogin: "founder",
  accountType: "User",
  claimedByGithubUserId: String(GH_USER),
  status: "active",
  verifiedAt: NOW,
  createdAt: NOW,
};
const snapshot: ListingSnapshot = {
  listingId: LISTING,
  installationId: "42",
  githubUserId: String(GH_USER),
  repos: [{ repoId: "77", fullName: "founder/app", admin: true }],
  verifiedAt: NOW,
  expiresAt: NOW,
};
const repo: RepoRecord = {
  repoId: "77",
  fullName: "founder/app",
  installationId: "42",
  workspaceId: WS,
  watchedBranch: "main",
  isActive: true,
  destinationId: DEST,
  createdAt: NOW,
  updatedAt: NOW,
};
const destination = {
  destinationId: DEST,
  workspaceId: WS,
  provider: "discord",
  displayName: "Alerts",
  status: "active",
  webhookId: "123456789012345678",
  createdAt: NOW,
  updatedAt: NOW,
  secret_ref: { name: `/syncro/prod/ws/${WS}/dest/${DEST}/discord-webhook-url`, version: 1 },
  webhookUrl: WEBHOOK_URL,
} as unknown as DestinationRecord;

// ─── Fakes ───────────────────────────────────────────────────────────────────

/** GitHub API double: one personal installation (42) of App 123456 owned by GH_USER, one admin repo. */
function fakeGitHub(overrides: Partial<Record<string, { status: number; body: unknown }>> = {}) {
  const calls: string[] = [];
  const transport: GitHubTransport = {
    async request(_method, url, opts) {
      calls.push(url.split("?")[0]);
      const path = url.split("?")[0];
      if (overrides[path]) return { ...overrides[path]!, headers: {} };
      if (path === "https://github.com/login/oauth/access_token") {
        expect(opts.form).toMatchObject({ code: OAUTH_CODE, client_secret: CLIENT_SECRET });
        return { status: 200, body: { access_token: GITHUB_TOKEN }, headers: {} };
      }
      expect(opts.userToken).toBe(GITHUB_TOKEN);
      if (path === "https://api.github.com/user") return { status: 200, body: { id: GH_USER, login: "founder" }, headers: {} };
      if (path === "https://api.github.com/user/installations") {
        return {
          status: 200,
          body: {
            total_count: 1,
            installations: [
              { id: 42, app_id: 123456, target_type: "User", suspended_at: null, account: { id: GH_USER, login: "founder" } },
            ],
          },
          headers: {},
        };
      }
      if (path === "https://api.github.com/user/installations/42/repositories") {
        return {
          status: 200,
          body: { total_count: 1, repositories: [{ id: 77, full_name: "founder/app", permissions: { admin: true } }] },
          headers: {},
        };
      }
      return { status: 404, body: {}, headers: {} };
    },
  };
  return { transport, calls };
}

function fakeServices(order: string[] = [], github = fakeGitHub()) {
  const writer = { put: jest.fn(async () => ({ version: 1 })) };
  const s = {
    tenancy: {
      getMe: jest.fn(async () => ({ profile: { status: "active", createdAt: NOW }, workspaces: [{ workspaceId: WS, role: "owner" }] })),
      bootstrapUser: jest.fn(async () => ({ created: true, workspaceId: WS })),
    },
    githubState: {
      createGitHubState: jest.fn(async () => ({ state: STATE, expiresAt: NOW })),
      consumeGitHubState: jest.fn(async () => {
        order.push("consume-state");
        return { ok: true as const, purpose: "install" as const };
      }),
    },
    installations: {
      claimInstallation: jest.fn(async () => {
        order.push("claim");
        return { created: true, installation };
      }),
      getInstallation: jest.fn(async () => installation),
      listInstallations: jest.fn(async () => ({ items: [installation], nextCursor: "next_1" })),
    },
    repos: {
      saveVerifiedListing: jest.fn(async () => {
        order.push("save-listing");
        return snapshot;
      }),
      getVerifiedListing: jest.fn(async () => snapshot),
      registerRepo: jest.fn(async () => repo),
      updateRepo: jest.fn(async () => repo),
      getRepo: jest.fn(async () => repo),
      listRepos: jest.fn(async () => ({ items: [repo] })),
    },
    destinations: {
      createDestination: jest.fn(async () => destination),
      updateDestination: jest.fn(async () => destination),
      replaceDestinationWebhook: jest.fn(async () => destination),
      getDestination: jest.fn(async () => destination),
      listDestinations: jest.fn(async () => ({ items: [destination] })),
    },
    history: {
      listDeliveries: jest.fn(async () => ({
        items: [
          {
            deliveryId: "d-1",
            status: "processed" as const,
            receivedAt: NOW,
            summary: { repoFullName: "founder/app", eventType: "push" },
          },
        ],
      })),
    },
    destinationWriter: jest.fn(() => writer),
    github: jest.fn(async () => {
      order.push("load-secret");
      return createGitHubVerification({ appId: "123456", clientId: "Iv23liTestClient01", clientSecret: CLIENT_SECRET });
    }),
    githubTransport: jest.fn(() => {
      const inner = github.transport;
      return {
        request: async (...args: Parameters<GitHubTransport["request"]>) => {
          order.push("github");
          return inner.request(...args);
        },
      };
    }),
    githubApp: { slug: "syncro-test", clientId: "Iv23liTestClient01" },
  };
  return { s: s as unknown as RouteServices, raw: s, writer, github };
}

/** Memberships: the user is a member of WS only, with `role`. */
function pipeline(services: RouteServices, o: { role?: Role | null; auth?: boolean } = {}) {
  const deps: PipelineDeps = {
    authenticate: jest.fn(async (h: string | undefined) => {
      if (o.auth === false || h !== `Bearer ${TOKEN}`) throw new AuthError("invalid_token");
      return { userId: UID, issuer: ISSUER };
    }),
    resolveWorkspaceContext: jest.fn(async (userId: string, workspaceId: string) => {
      const role = o.role === undefined ? "owner" : o.role;
      return role && workspaceId === WS ? ({ userId, workspaceId, role } as WorkspaceContext) : null;
    }),
    consumeRateLimit: jest.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
    handlers: createRouteHandlers(services),
  };
  return { handle: createDashboardHandler(() => deps), deps };
}

const W = `/api/workspaces/${WS}`;
const SAMPLES: Record<RouteId, { path: string; body?: unknown; query?: Record<string, string> }> = {
  "me.get": { path: "/api/me" },
  "me.bootstrap": { path: "/api/me/bootstrap" },
  "github.installUrl": { path: `${W}/github/install-url` },
  "github.claim": { path: `${W}/github/claim`, body: { code: OAUTH_CODE, installationId: "42", state: STATE } },
  "github.authorizeUrl": { path: `${W}/github/authorize-url` },
  "github.repoListing": { path: `${W}/github/repo-listing`, body: { code: OAUTH_CODE, installationId: "42", state: STATE } },
  "installations.list": { path: `${W}/installations` },
  "repos.list": { path: `${W}/repos`, query: { limit: "5", cursor: "abc_DEF" } },
  "repos.register": { path: `${W}/repos`, body: { listingId: LISTING, repoId: "77", destinationId: DEST } },
  "repos.update": { path: `${W}/repos/77`, body: { destinationId: null } },
  "destinations.list": { path: `${W}/destinations` },
  "destinations.create": { path: `${W}/destinations`, body: { displayName: "Alerts", webhookUrl: WEBHOOK_URL } },
  "destinations.update": { path: `${W}/destinations/${DEST}`, body: { isActive: false } },
  "destinations.replaceWebhook": { path: `${W}/destinations/${DEST}/webhook`, body: { webhookUrl: WEBHOOK_URL } },
  "deliveries.list": { path: `${W}/deliveries` },
};

const method = (id: RouteId) => ROUTES.find((r) => r.id === id)!.method;

function event(id: RouteId, o: { path?: string; body?: unknown; rawBody?: string; auth?: string | null } = {}): APIGatewayProxyEventV2 {
  const s = SAMPLES[id];
  const p = o.path ?? s.path;
  const body = o.rawBody ?? ("body" in o ? (o.body === undefined ? undefined : JSON.stringify(o.body)) : s.body === undefined ? undefined : JSON.stringify(s.body));
  return {
    version: "2.0",
    routeKey: `${method(id)} ${ROUTES.find((r) => r.id === id)!.path}`,
    rawPath: p,
    rawQueryString: "",
    headers: o.auth === null ? {} : { authorization: o.auth ?? `Bearer ${TOKEN}` },
    queryStringParameters: s.query,
    requestContext: { requestId: "req-42", http: { method: method(id), path: p } } as APIGatewayProxyEventV2["requestContext"],
    body,
    isBase64Encoded: false,
  };
}

const json = (r: { body?: string }) => JSON.parse(r.body ?? "null");

let logs: string[];
beforeEach(() => {
  logs = [];
  jest.spyOn(console, "log").mockImplementation((line: string) => void logs.push(String(line)));
});
afterEach(() => jest.restoreAllMocks());

/** Which operation each route must call, with what. */
const EXPECTED_OPS: Record<RouteId, (raw: ReturnType<typeof fakeServices>["raw"]) => jest.Mock> = {
  "me.get": (r) => r.tenancy.getMe,
  "me.bootstrap": (r) => r.tenancy.bootstrapUser,
  "github.installUrl": (r) => r.githubState.createGitHubState,
  "github.claim": (r) => r.installations.claimInstallation,
  "github.authorizeUrl": (r) => r.githubState.createGitHubState,
  "github.repoListing": (r) => r.repos.saveVerifiedListing,
  "installations.list": (r) => r.installations.listInstallations,
  "repos.list": (r) => r.repos.listRepos,
  "repos.register": (r) => r.repos.registerRepo,
  "repos.update": (r) => r.repos.updateRepo,
  "destinations.list": (r) => r.destinations.listDestinations,
  "destinations.create": (r) => r.destinations.createDestination,
  "destinations.update": (r) => r.destinations.updateDestination,
  "destinations.replaceWebhook": (r) => r.destinations.replaceDestinationWebhook,
  "deliveries.list": (r) => r.history.listDeliveries,
};

/** Every operation mock, to prove none ran. */
function allOps(raw: ReturnType<typeof fakeServices>["raw"]): jest.Mock[] {
  return [raw.tenancy, raw.githubState, raw.installations, raw.repos, raw.destinations, raw.history].flatMap(
    (group) => Object.values(group) as jest.Mock[],
  );
}

describe("every route is connected to its operation", () => {
  it("has a handler for each of the 15 routes and no others", () => {
    expect(Object.keys(createRouteHandlers(fakeServices().s)).sort()).toEqual(ROUTES.map((r) => r.id).sort());
  });

  it.each(ROUTES.map((r) => [r.id] as const))("%s calls its operation and answers 200", async (id) => {
    const { s, raw } = fakeServices();
    const res = await pipeline(s).handle(event(id));
    expect(res.statusCode).toBe(200);
    expect(EXPECTED_OPS[id](raw)).toHaveBeenCalledTimes(1);
  });

  it("uses the token's user and the membership proof, never request data, as actor and workspace", async () => {
    const { s, raw } = fakeServices();
    const { handle } = pipeline(s);
    await handle(event("me.get"));
    expect(raw.tenancy.getMe).toHaveBeenCalledWith(UID);
    await handle(event("me.bootstrap"));
    expect(raw.tenancy.bootstrapUser).toHaveBeenCalledWith(UID, ISSUER);

    await handle(event("destinations.update"));
    const [ctx, id, patch] = raw.destinations.updateDestination.mock.calls[0] as unknown as [WorkspaceContext, string, unknown];
    expect(ctx).toMatchObject({ userId: UID, workspaceId: WS, role: "owner" });
    expect(id).toBe(DEST);
    expect(patch).toEqual({ isActive: false });

    await handle(event("repos.update"));
    expect(raw.repos.updateRepo).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS }), "77", { destinationId: null });
  });

  it("passes list paging through and defaults the page size", async () => {
    const { s, raw } = fakeServices();
    const { handle } = pipeline(s);
    const listed = await handle(event("repos.list"));
    expect(raw.repos.listRepos).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS }), { limit: 5, cursor: "abc_DEF" });
    expect(json(listed).items).toHaveLength(1);

    const inst = await handle(event("installations.list"));
    expect(raw.installations.listInstallations).toHaveBeenCalledWith(expect.anything(), { limit: 25 });
    expect(json(inst)).toEqual({
      items: [{ installationId: "42", accountLogin: "founder", accountType: "User", status: "active", claimedAt: NOW }],
      nextCursor: "next_1",
    });
  });

  it("builds GitHub redirect URLs with the server-created single-use state", async () => {
    const { s, raw } = fakeServices();
    const { handle } = pipeline(s);
    const install = json(await handle(event("github.installUrl")));
    expect(install).toEqual({ url: `https://github.com/apps/syncro-test/installations/new?state=${STATE}`, expiresAt: NOW });
    expect(raw.githubState.createGitHubState).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: WS }), "install");

    const authorize = json(await handle(event("github.authorizeUrl")));
    expect(authorize).toEqual({
      url: `https://github.com/login/oauth/authorize?client_id=Iv23liTestClient01&state=${STATE}`,
      expiresAt: NOW,
    });
    expect(raw.githubState.createGitHubState).toHaveBeenLastCalledWith(expect.anything(), "authorize");
  });
});

describe("authentication and authorization on the connected routes", () => {
  it.each(ROUTES.map((r) => [r.id] as const))("%s: 401 without a valid token, no operation runs", async (id) => {
    const { s, raw } = fakeServices();
    const { handle } = pipeline(s);
    for (const auth of [null, "Bearer forged.token.value"]) {
      const res = await handle(event(id, { auth }));
      expect(res.statusCode).toBe(401);
      expect(json(res)).toEqual({ error: "unauthenticated" });
    }
    for (const op of allOps(raw)) expect(op).not.toHaveBeenCalled();
  });

  const workspaceRoutes = ROUTES.filter((r) => r.access !== "token").map((r) => [r.id] as const);
  const ownerRoutes = ROUTES.filter((r) => r.access === "owner").map((r) => [r.id] as const);

  it.each(workspaceRoutes)("%s: 404 for a non-member or an inactive workspace", async (id) => {
    const { s, raw } = fakeServices();
    const res = await pipeline(s, { role: null }).handle(event(id));
    expect(res.statusCode).toBe(404);
    expect(json(res)).toEqual({ error: "not_found" });
    for (const op of allOps(raw)) expect(op).not.toHaveBeenCalled();
  });

  it.each(workspaceRoutes)("%s: 404 for another workspace's path, even for an owner elsewhere", async (id) => {
    const { s, raw } = fakeServices();
    const res = await pipeline(s).handle(event(id, { path: SAMPLES[id].path.replace(WS, OTHER_WS) }));
    expect(res.statusCode).toBe(404);
    for (const op of allOps(raw)) expect(op).not.toHaveBeenCalled();
  });

  it.each(ownerRoutes)("%s: 403 below owner, no operation runs", async (id) => {
    for (const role of ["member", "admin"] as const) {
      const { s, raw } = fakeServices();
      const res = await pipeline(s, { role }).handle(event(id));
      expect(res.statusCode).toBe(403);
      expect(json(res)).toEqual({ error: "forbidden" });
      for (const op of allOps(raw)) expect(op).not.toHaveBeenCalled();
    }
  });

  it("owner-only routes are exactly the onboarding and write routes", () => {
    expect(ownerRoutes.map(([id]) => id).sort()).toEqual([
      "destinations.create",
      "destinations.replaceWebhook",
      "destinations.update",
      "github.authorizeUrl",
      "github.claim",
      "github.installUrl",
      "github.repoListing",
      "repos.register",
      "repos.update",
    ]);
  });
});

describe("resource IDs and cross-workspace access", () => {
  it.each<[RouteId, string]>([
    ["repos.update", `${W}/repos/0077`],
    ["repos.update", `${W}/repos/abc`],
    ["destinations.update", `${W}/destinations/not-a-uuid`],
    ["destinations.replaceWebhook", `${W}/destinations/${DEST.toUpperCase()}/webhook`],
  ])("%s: malformed ID in %s → 404 before any operation", async (id, p) => {
    const { s, raw } = fakeServices();
    const res = await pipeline(s).handle(event(id, { path: p }));
    expect(res.statusCode).toBe(404);
    for (const op of allOps(raw)) expect(op).not.toHaveBeenCalled();
  });

  it("another workspace's destination or repository is not found (IDOR)", async () => {
    // Ownership lives in the operations: a record of another workspace is invisible to this context.
    const owners: Record<string, string> = { [DEST]: OTHER_WS, "77": OTHER_WS };
    const { s, raw, writer } = fakeServices();
    const notMine = async (ctx: WorkspaceContext, resourceId: string) => {
      if (owners[resourceId] !== ctx.workspaceId) throw new ContractError("not_found");
      return destination;
    };
    raw.destinations.updateDestination.mockImplementation(notMine as never);
    raw.destinations.replaceDestinationWebhook.mockImplementation(notMine as never);
    raw.repos.updateRepo.mockImplementation(notMine as never);
    const { handle } = pipeline(s);
    for (const id of ["destinations.update", "destinations.replaceWebhook", "repos.update"] as const) {
      const res = await handle(event(id));
      expect(res.statusCode).toBe(404);
      expect(json(res)).toEqual({ error: "not_found" });
    }
    expect(writer.put).not.toHaveBeenCalled();
  });

  it("a workspace or actor ID in a body is rejected, never used", async () => {
    const { s, raw } = fakeServices();
    const { handle } = pipeline(s);
    for (const extra of [{ workspace_id: OTHER_WS }, { workspaceId: OTHER_WS }, { userId: "logto:zzzzzzzzzzzz" }]) {
      const res = await handle(event("destinations.create", { body: { displayName: "A", webhookUrl: WEBHOOK_URL, ...extra } }));
      expect(res.statusCode).toBe(400);
    }
    expect(raw.destinations.createDestination).not.toHaveBeenCalled();
  });
});

describe("request bodies", () => {
  it.each<[RouteId, string[]]>([
    ["github.claim", ["code", "installationId", "state"]],
    ["github.repoListing", ["code", "installationId", "state"]],
    ["repos.register", ["listingId", "repoId"]],
    ["destinations.create", ["displayName", "webhookUrl"]],
    ["destinations.replaceWebhook", ["webhookUrl"]],
    ["repos.update", ["(root)"]],
    ["destinations.update", ["(root)"]],
  ])("%s without a body still requires its fields", async (id, fields) => {
    const { s, raw } = fakeServices();
    const res = await pipeline(s).handle(event(id, { body: undefined }));
    expect(res.statusCode).toBe(400);
    expect(json(res)).toEqual({ error: "invalid_request", fields });
    expect(EXPECTED_OPS[id](raw)).not.toHaveBeenCalled();
  });

  it.each(ROUTES.filter((r) => r.method === "GET").map((r) => [r.id] as const))("%s with a body → 400", async (id) => {
    const { s, raw } = fakeServices();
    const res = await pipeline(s).handle(event(id, { rawBody: "{}" }));
    expect(res.statusCode).toBe(400);
    expect(EXPECTED_OPS[id](raw)).not.toHaveBeenCalled();
  });
});

describe("GitHub onboarding", () => {
  it("claim: secret, then state, then GitHub (exchange → user → verify), then claim, listing and save", async () => {
    const order: string[] = [];
    const gh = fakeGitHub();
    const { s } = fakeServices(order, gh);
    const res = await pipeline(s).handle(event("github.claim"));
    expect(res.statusCode).toBe(200);
    expect(order.indexOf("load-secret")).toBe(0);
    expect(order.indexOf("consume-state")).toBe(1);
    expect(order.indexOf("github")).toBe(2);
    expect(order.indexOf("claim")).toBeGreaterThan(order.indexOf("github"));
    expect(order.lastIndexOf("github")).toBeGreaterThan(order.indexOf("claim"));
    expect(order[order.length - 1]).toBe("save-listing");
    expect(gh.calls).toEqual([
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/user",
      "https://api.github.com/user",
      "https://api.github.com/user/installations",
      "https://api.github.com/user",
      "https://api.github.com/user/installations/42/repositories",
    ]);
    expect(json(res)).toEqual({
      created: true,
      installation: { installationId: "42", accountLogin: "founder", accountType: "User", status: "active", claimedAt: NOW },
      listing: { listingId: LISTING, installationId: "42", expiresAt: NOW, repos: [{ repoId: "77", fullName: "founder/app", admin: true }] },
    });
  });

  it("claim: the installation proof comes from GitHub, not from the request", async () => {
    const { s, raw } = fakeServices();
    await pipeline(s).handle(event("github.claim"));
    const [ctx, verified] = raw.installations.claimInstallation.mock.calls[0] as unknown as [WorkspaceContext, Record<string, unknown>];
    expect(ctx).toMatchObject({ workspaceId: WS });
    expect(verified).toMatchObject({ installationId: "42", githubUserId: String(GH_USER), proof: "personal_owner", verifiedVia: "user_oauth" });
  });

  it("claim: an installation the user does not own is refused before anything is claimed", async () => {
    const { s, raw } = fakeServices();
    const res = await pipeline(s).handle(event("github.claim", { body: { code: OAUTH_CODE, installationId: "999", state: STATE } }));
    expect(res.statusCode).toBe(403);
    expect(json(res)).toEqual({ error: "not_installation_owner" });
    expect(raw.installations.claimInstallation).not.toHaveBeenCalled();
  });

  it.each(["github.claim", "github.repoListing"] as const)("%s: an invalid state stops before GitHub is contacted", async (id) => {
    const order: string[] = [];
    const { s, raw } = fakeServices(order);
    raw.githubState.consumeGitHubState.mockResolvedValueOnce({ ok: false, reason: "binding_mismatch" } as never);
    const res = await pipeline(s).handle(event(id));
    expect(res.statusCode).toBe(400);
    expect(json(res)).toEqual({ error: "state_invalid" });
    expect(order).not.toContain("github");
    expect(raw.repos.saveVerifiedListing).not.toHaveBeenCalled();
  });

  it.each(["github.claim", "github.repoListing"] as const)(
    "%s: an unavailable OAuth secret fails closed (500) without consuming the state",
    async (id) => {
      const { s, raw } = fakeServices();
      raw.github.mockRejectedValueOnce(new SecretUnavailableError("/syncro/prod/dashboard/github-oauth-client-secret", "throttled"));
      const res = await pipeline(s).handle(event(id));
      expect(res.statusCode).toBe(500);
      expect(json(res)).toEqual({ error: "internal_error" });
      expect(raw.githubState.consumeGitHubState).not.toHaveBeenCalled();
    },
  );

  it("repo-listing: consumes an authorize state and saves a listing verified for the signed-in GitHub user", async () => {
    const order: string[] = [];
    const { s, raw } = fakeServices(order);
    const res = await pipeline(s).handle(event("github.repoListing"));
    expect(res.statusCode).toBe(200);
    expect(raw.githubState.consumeGitHubState).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS }), STATE, "authorize");
    expect(order.slice(0, 3)).toEqual(["load-secret", "consume-state", "github"]);
    const [, listing] = raw.repos.saveVerifiedListing.mock.calls[0] as unknown as [WorkspaceContext, Record<string, unknown>];
    expect(listing).toMatchObject({ installationId: "42", githubUserId: String(GH_USER) });
    expect(json(res)).toEqual({ listingId: LISTING, installationId: "42", expiresAt: NOW, repos: [{ repoId: "77", fullName: "founder/app", admin: true }] });
  });

  it("an oversized listing answers 422 listing_too_large with no count", async () => {
    const { s } = fakeServices(
      [],
      fakeGitHub({
        "https://api.github.com/user/installations/42/repositories": { status: 200, body: { total_count: 1001, repositories: [] } },
      }),
    );
    const res = await pipeline(s).handle(event("github.repoListing"));
    expect(res.statusCode).toBe(422);
    expect(res.body).toBe(JSON.stringify({ error: "listing_too_large" }));
    expect(new ListingTooLargeError(5).code).toBe("listing_too_large");
  });

  it("GitHub being unavailable answers 502", async () => {
    const { s } = fakeServices([], fakeGitHub({ "https://api.github.com/user": { status: 503, body: {} } }));
    const res = await pipeline(s).handle(event("github.claim"));
    expect(res.statusCode).toBe(502);
    expect(json(res)).toEqual({ error: "github_unavailable" });
  });

  it("writes one audit line per GitHub call, by operation name, without tokens, codes or secrets", async () => {
    const { s } = fakeServices();
    await pipeline(s).handle(event("github.claim"));
    const lines = logs.map((l) => JSON.parse(l)).filter((l) => l.audit === "github");
    expect(lines.map((l) => l.operation)).toEqual([
      "exchange_oauth_code",
      "get_user",
      "get_user",
      "list_user_installations",
      "get_user",
      "list_installation_repositories",
    ]);
    for (const l of lines) {
      expect(l).toMatchObject({ requestId: "req-42", route: "github.claim", workspaceId: WS, outcome: "ok", httpStatus: 200 });
    }
    const text = logs.join("\n");
    for (const secret of [GITHUB_TOKEN, OAUTH_CODE, CLIENT_SECRET, STATE, "api.github.com", TOKEN]) expect(text).not.toContain(secret);
  });
});

describe("audit of write requests", () => {
  const writeRoutes = ROUTES.filter((r) => r.method !== "GET").map((r) => [r.id] as const);
  const audits = () => logs.map((l) => JSON.parse(l)).filter((l) => l.audit === "write");

  it.each(writeRoutes)("%s: one line on success and one on refusal", async (id) => {
    const ok = fakeServices();
    await pipeline(ok.s).handle(event(id));
    const refused = fakeServices();
    const isOwnerRoute = ROUTES.find((r) => r.id === id)!.access === "owner";
    await pipeline(refused.s, { role: isOwnerRoute ? "member" : "owner" }).handle(event(id, { auth: isOwnerRoute ? undefined : null }));
    const lines = audits();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ route: id, status: 200, outcome: "ok", userId: UID });
    expect(lines[1]).toMatchObject({ route: id, outcome: isOwnerRoute ? "forbidden" : "unauthenticated" });
  });

  it("records an operation's refusal code", async () => {
    const { s, raw } = fakeServices();
    raw.destinations.createDestination.mockRejectedValueOnce(new ContractError("destination_limit_reached"));
    const res = await pipeline(s).handle(event("destinations.create"));
    expect(res.statusCode).toBe(409);
    expect(audits()).toEqual([expect.objectContaining({ route: "destinations.create", status: 409, outcome: "destination_limit_reached" })]);
  });
});

describe("destination secrets", () => {
  it("create and replace hand the URL only to the operation, with the write-only writer", async () => {
    const { s, raw, writer } = fakeServices();
    const { handle } = pipeline(s);
    await handle(event("destinations.create"));
    expect(raw.destinations.createDestination).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS }),
      { displayName: "Alerts", webhookUrl: WEBHOOK_URL },
      writer,
    );
    await handle(event("destinations.replaceWebhook"));
    expect(raw.destinations.replaceDestinationWebhook).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS }), DEST, WEBHOOK_URL, writer);
    // The handler never names or writes a parameter itself.
    expect(writer.put).not.toHaveBeenCalled();
  });

  it("never returns or logs the webhook URL, its token or the secret reference", async () => {
    const { s } = fakeServices();
    const { handle } = pipeline(s);
    const bodies: string[] = [];
    for (const id of ["destinations.create", "destinations.update", "destinations.replaceWebhook", "destinations.list"] as const) {
      const res = await handle(event(id));
      expect(res.statusCode).toBe(200);
      bodies.push(res.body ?? "");
    }
    const created = JSON.parse(bodies[0]);
    expect(Object.keys(created).sort()).toEqual(
      ["createdAt", "destinationId", "displayName", "provider", "status", "updatedAt", "webhookUrlMasked"].sort(),
    );
    expect(created.webhookUrlMasked).toBe("discord.com/api/webhooks/123456789012345678/••••");
    const everything = bodies.join("\n") + logs.join("\n");
    for (const secret of [WEBHOOK_TOKEN, WEBHOOK_URL, "secret_ref", "discord-webhook-url", TOKEN]) {
      expect(everything).not.toContain(secret);
    }
    expect(everything.toLowerCase()).not.toContain("authorization");
  });

  it("a secret-store refusal keeps its contract code", async () => {
    const { s, raw } = fakeServices();
    raw.destinations.replaceDestinationWebhook.mockRejectedValueOnce(new ContractError("secret_store_busy"));
    const res = await pipeline(s).handle(event("destinations.replaceWebhook"));
    expect(res.statusCode).toBe(503);
    expect(json(res)).toEqual({ error: "secret_store_busy" });
  });
});

describe("production wiring", () => {
  const env = {
    GITHUB_APP_ID: "123456",
    GITHUB_APP_CLIENT_ID: "Iv23liTestClient01",
    GITHUB_APP_SLUG: "syncro-test",
  } as DashboardEnv;

  it("uses the existing data operations and the write-only destination writer", () => {
    const s = productionServices(env);
    expect(s.tenancy.bootstrapUser).toBe(bootstrapUser);
    expect(s.tenancy.getMe).toBe(getMe);
    expect(s.destinations.createDestination).toBe(createDestination);
    expect(s.destinations.replaceDestinationWebhook).toBe(replaceDestinationWebhook);
    const writer = s.destinationWriter();
    expect(Object.keys(writer)).toEqual(["put"]);
    expect(s.destinationWriter()).toBe(writer);
  });

  it("the production writer refuses any name outside the destination namespace", async () => {
    const writer = productionServices(env).destinationWriter();
    await expect(writer.put("/syncro/prod/dashboard/github-oauth-client-secret", "x", { overwrite: true })).rejects.toThrow(
      "Refusing to write a non-destination parameter",
    );
    await expect(writer.put("/syncro/prod/sender/github-webhook-secret", "x", { overwrite: true })).rejects.toThrow();
  });

  it("a suspended profile cannot complete bootstrap through the route (real bootstrapUser)", async () => {
    const send = jest.fn(async (cmd: unknown) => {
      if (cmd instanceof GetCommand && cmd.input.Key?.SK === "PROFILE") {
        return { Item: { status: "suspended", bootstrap_workspace_id: WS, user_id: UID } };
      }
      return {};
    });
    setTenancyDepsForTests({ send: send as never });
    try {
      const s = productionServices(env);
      const res = await pipeline(s).handle(event("me.bootstrap"));
      expect(res.statusCode).toBe(403);
      expect(json(res)).toEqual({ error: "profile_suspended" });
      expect(send.mock.calls.some(([c]) => !(c instanceof GetCommand))).toBe(false);
    } finally {
      setTenancyDepsForTests(undefined);
    }
  });
});
