/**
 * API contract tests: route table, roles, error codes, strict request schemas,
 * and the agreed limit/timeout values (guards against accidental changes).
 */

import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  AUTH,
  ContractError,
  GITHUB_ONBOARDING,
  ID_PATTERNS,
  ORG_INSTALLATIONS_SUPPORTED,
  RATE_LIMITS,
  RATE_LIMIT_TTL_SECONDS,
  RELAY,
  REQUEST_LIMITS,
  ROUTES,
  SECRETS,
  SIGNUP,
  SSM_DESTINATION_PARAMS,
  WORKSPACE_LIMITS,
  claimInstallationBodySchema,
  createDestinationBodySchema,
  emptyBodySchema,
  listQuerySchema,
  registerRepoBodySchema,
  repoListingBodySchema,
  replaceWebhookBodySchema,
  roleSatisfies,
  updateDestinationBodySchema,
  updateRepoBodySchema,
  workspacePathSchema,
} from "../../src/contracts";

const WS = "ws_3f1c2a9e-7b4d-4c1e-9a2b-1d2e3f4a5b6c";
const DEST = "8c0e6f1a-2b3c-4d5e-8f90-a1b2c3d4e5f6";
const LISTING = "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";
const STATE = "A".repeat(43);

describe("contract constants (guard against accidental changes)", () => {
  it("keeps the agreed limits, timeouts and safeguard values", () => {
    expect(RELAY.discordAttemptTimeoutMs).toBe(5000); // Discord request timeout
    expect(RELAY.githubRequestTimeoutMs).toBe(3000); // GitHub request timeout
    expect(RELAY.persistedErrorMaxChars).toBe(500); // stored error message cap
    expect(RELAY.enrichmentCap).toBe(5);
    expect(AUTH.accessTokenTtlSeconds).toBe(3600); // access-token lifetime
    expect(REQUEST_LIMITS.cursorMaxLength).toBe(1024); // cursor length cap
    expect(Object.keys(RATE_LIMITS).sort()).toEqual(["bootstrap", "github", "write"]); // no per-user read bucket
    expect(RATE_LIMITS).toEqual({ bootstrap: 5, github: 10, write: 30 });
    expect(RATE_LIMIT_TTL_SECONDS).toBe(120);
    expect(SIGNUP.dayBoundary).toBe("UTC"); // daily-cap day boundary
    expect(SIGNUP.defaultDailyCap).toBe(100);
    expect(SSM_DESTINATION_PARAMS).toEqual({ ceiling: 1000, warnAt: 800 }); // service-wide destination capacity
    expect(SECRETS.destinationUrlCacheTtlSeconds).toBe(300); // destination URL cache lifetime
    expect(WORKSPACE_LIMITS).toEqual({ activeRepos: 25, activeDestinations: 10, installations: 3 });
    expect(GITHUB_ONBOARDING.stateTtlSeconds).toBe(600);
    expect(GITHUB_ONBOARDING.listingTtlSeconds).toBe(900);
    expect(REQUEST_LIMITS.maxBodyBytes).toBe(16_384);
    expect(ORG_INSTALLATIONS_SUPPORTED).toBe(true);
    expect(AUTH.allowedAlgorithms).toEqual(["ES384"]);
  });

  it("fails closed with 503 when the rate-limit store is unavailable", () => {
    expect(API_ERROR_STATUS.rate_limit_unavailable).toBe(503);
  });
});

describe("route table (default deny registry input)", () => {
  it("has unique ids and unique method+path pairs", () => {
    expect(new Set(ROUTES.map((r) => r.id)).size).toBe(ROUTES.length);
    expect(new Set(ROUTES.map((r) => `${r.method} ${r.path}`)).size).toBe(ROUTES.length);
  });

  it("requires workspace membership on every workspace-scoped route", () => {
    for (const r of ROUTES) {
      if (r.path.startsWith("/api/workspaces/{workspaceId}")) {
        expect(r.access).not.toBe("token");
      } else {
        expect(r.path.startsWith("/api/me")).toBe(true);
      }
    }
  });

  it("allows writes for owner only and reads for member+", () => {
    for (const r of ROUTES) {
      if (!r.path.startsWith("/api/workspaces/")) continue;
      expect(r.access).toBe(r.method === "GET" ? "member" : "owner");
    }
  });

  it("applies the extra route throttle to exactly the expensive routes", () => {
    expect(ROUTES.filter((r) => r.routeThrottle).map((r) => r.id).sort()).toEqual(
      [
        "me.bootstrap",
        "github.installUrl",
        "github.claim",
        "github.authorizeUrl",
        "github.repoListing",
        "destinations.create",
        "destinations.update",
        "destinations.replaceWebhook",
      ].sort(),
    );
  });

  it("maps rate-limit buckets: bootstrap, github routes, writes; no read bucket", () => {
    for (const r of ROUTES) {
      if (r.method === "GET") expect(r.rateBucket).toBeNull();
      else if (r.id === "me.bootstrap") expect(r.rateBucket).toBe("bootstrap");
      else if (r.id.startsWith("github.")) expect(r.rateBucket).toBe("github");
      else expect(r.rateBucket).toBe("write");
    }
  });

  it("does not include the webhook route", () => {
    expect(ROUTES.some((r) => r.path.includes("webhooks"))).toBe(false);
  });
});

describe("roles", () => {
  it.each([
    ["owner", "owner", true],
    ["owner", "member", true],
    ["admin", "owner", false],
    ["admin", "admin", true],
    ["member", "admin", false],
    ["member", "member", true],
    ["superuser", "member", false],
    [undefined, "member", false],
  ] as const)("%s satisfies %s → %s", (actual, minimum, expected) => {
    expect(roleSatisfies(actual, minimum)).toBe(expected);
  });
});

describe("error codes", () => {
  it("every code maps to a 4xx/5xx status", () => {
    for (const code of API_ERROR_CODES) {
      const s = API_ERROR_STATUS[code];
      expect(s >= 400 && s <= 599).toBe(true);
    }
  });

  it("includes the ownership and secret-store codes named by the plans", () => {
    for (const code of [
      "not_installation_owner",
      "org_not_supported",
      "installation_claimed",
      "state_invalid",
      "secret_store_busy",
      "signup_paused",
      "signup_not_open",
    ]) {
      expect(API_ERROR_CODES).toContain(code);
    }
    expect(API_ERROR_STATUS.installation_claimed).toBe(409);
    expect(API_ERROR_STATUS.secret_store_busy).toBe(503);
  });

  it("includes listing_too_large as 422", () => {
    expect(API_ERROR_CODES).toContain("listing_too_large");
    expect(API_ERROR_STATUS.listing_too_large).toBe(422);
  });

  it("ContractError carries code and status only", () => {
    const e = new ContractError("installation_claimed");
    expect(e.code).toBe("installation_claimed");
    expect(e.status).toBe(409);
    expect(e.message).toBe("installation_claimed");
  });
});

describe("strict request schemas", () => {
  it("rejects workspace_id / workspaceId in any body", () => {
    const bodies: Array<[{ safeParse: (v: unknown) => { success: boolean } }, Record<string, unknown>]> = [
      [emptyBodySchema, {}],
      [claimInstallationBodySchema, { code: "abc", installationId: "42", state: STATE }],
      [repoListingBodySchema, { code: "abc", installationId: "42", state: STATE }],
      [registerRepoBodySchema, { listingId: LISTING, repoId: "7" }],
      [updateRepoBodySchema, { isActive: true }],
      [createDestinationBodySchema, { displayName: "Alerts", webhookUrl: "https://discord.com/x" }],
      [updateDestinationBodySchema, { displayName: "Alerts" }],
      [replaceWebhookBodySchema, { webhookUrl: "https://discord.com/x" }],
    ];
    for (const [schema, valid] of bodies) {
      expect(schema.safeParse(valid).success).toBe(true);
      expect(schema.safeParse({ ...valid, workspace_id: WS }).success).toBe(false);
      expect(schema.safeParse({ ...valid, workspaceId: WS }).success).toBe(false);
      expect(schema.safeParse({ ...valid, unexpected: 1 }).success).toBe(false);
    }
  });

  it("rejects string booleans", () => {
    expect(updateRepoBodySchema.safeParse({ isActive: "true" }).success).toBe(false);
    expect(updateDestinationBodySchema.safeParse({ isActive: "false" }).success).toBe(false);
  });

  it("enforces string bounds", () => {
    expect(createDestinationBodySchema.safeParse({ displayName: "x".repeat(65), webhookUrl: "u" }).success).toBe(false);
    expect(createDestinationBodySchema.safeParse({ displayName: "   ", webhookUrl: "u" }).success).toBe(false);
    expect(replaceWebhookBodySchema.safeParse({ webhookUrl: "u".repeat(257) }).success).toBe(false);
    expect(updateRepoBodySchema.safeParse({ watchedBranch: "b".repeat(256) }).success).toBe(false);
    expect(updateRepoBodySchema.safeParse({ watchedBranch: "" }).success).toBe(false);
    expect(updateRepoBodySchema.safeParse({ watchedBranch: "main\n" }).success).toBe(false);
    expect(updateRepoBodySchema.safeParse({ watchedBranch: "b".repeat(255) }).success).toBe(true);
  });

  it("accepts null to clear a repo destination and rejects an empty patch", () => {
    expect(updateRepoBodySchema.safeParse({ destinationId: null }).success).toBe(true);
    expect(updateRepoBodySchema.safeParse({ destinationId: DEST }).success).toBe(true);
    expect(updateRepoBodySchema.safeParse({}).success).toBe(false);
    expect(updateDestinationBodySchema.safeParse({}).success).toBe(false);
  });

  it("format-checks IDs and the state nonce", () => {
    const ok = { code: "abc", installationId: "42", state: STATE };
    expect(claimInstallationBodySchema.safeParse({ ...ok, installationId: "042" }).success).toBe(false);
    expect(claimInstallationBodySchema.safeParse({ ...ok, installationId: 42 }).success).toBe(false);
    expect(claimInstallationBodySchema.safeParse({ ...ok, state: "short" }).success).toBe(false);
    expect(claimInstallationBodySchema.safeParse({ ...ok, state: `${"A".repeat(42)}#` }).success).toBe(false);
    expect(claimInstallationBodySchema.safeParse({ ...ok, code: "x".repeat(257) }).success).toBe(false);
    expect(registerRepoBodySchema.safeParse({ listingId: "not-a-uuid", repoId: "7" }).success).toBe(false);
    expect(workspacePathSchema.safeParse({ workspaceId: WS }).success).toBe(true);
    expect(workspacePathSchema.safeParse({ workspaceId: "ws_123" }).success).toBe(false);
    expect(workspacePathSchema.safeParse({ workspaceId: `${WS}#X` }).success).toBe(false);
  });

  it("bounds list queries: limit 1–50 digits only, cursor ≤ 1024 base64url", () => {
    expect(listQuerySchema.parse({ limit: "50" })).toEqual({ limit: 50 });
    expect(listQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
    expect(listQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(listQuerySchema.safeParse({ limit: "1e1" }).success).toBe(false);
    expect(listQuerySchema.safeParse({ cursor: "a".repeat(1024) }).success).toBe(true);
    expect(listQuerySchema.safeParse({ cursor: "a".repeat(1025) }).success).toBe(false);
    expect(listQuerySchema.safeParse({ cursor: "abc+/=" }).success).toBe(false);
    expect(listQuerySchema.safeParse({ workspace_id: WS }).success).toBe(false);
  });
});

describe("identifier patterns", () => {
  it("accepts server-generated formats and the Logto user ID format", () => {
    expect(ID_PATTERNS.workspaceId.test(WS)).toBe(true);
    expect(ID_PATTERNS.destinationId.test(DEST)).toBe(true);
    expect(ID_PATTERNS.userId.test("logto:abcdef123456")).toBe(true);
    expect(ID_PATTERNS.userId.test("logto:ABCDEF123456")).toBe(false);
    expect(ID_PATTERNS.userId.test("user_abc")).toBe(false);
    expect(ID_PATTERNS.githubId.test("0")).toBe(false);
  });
});
