/**
 * The dashboard API wired for DynamoDB Local: the real pipeline, the real
 * Logto token verifier (with a locally generated ES384 key instead of the
 * tenant's JWKS), real workspace context, real rate limits, the real 15 route
 * handlers and the real data operations. Only the edges are fakes:
 * - GitHub: an in-memory GitHub API behind the real verification library;
 * - SSM: the fake destination writer from the shared fixtures;
 * - network: `fetch` throws, so nothing can leave the machine.
 */

import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type CryptoKey, type JWTVerifyGetKey } from "jose";
import type { DashboardEnv } from "../../../src/config/env";
import type { GitHubTransport } from "../../../src/contracts";
import { createAuthenticator } from "../../../src/dashboard/auth";
import { createDashboardHandler, type DashboardHandler } from "../../../src/dashboard/pipeline";
import { createRouteHandlers } from "../../../src/dashboard/routes";
import { productionServices } from "../../../src/dashboard/routes/services";
import { createGitHubVerification } from "../../../src/github/verification";
import { consumeRateLimit } from "../../../src/ratelimit/rate-limit";
import { resolveWorkspaceContext } from "../../../src/tenancy/context";
import { fakeWriter, type FakeWriter } from "../fixtures";

export const ISSUER = "https://tenant.logto.app/oidc";
const AUDIENCE = "https://api.syncro.test";
const CLIENT_ID = "spaclientid01";
export const APP_ID = "123456";
export const OAUTH_CLIENT_SECRET = "local-oauth-client-secret";

// ─── Fake GitHub API ─────────────────────────────────────────────────────────

interface FakeInstallation {
  id: number;
  appId: number;
  type: "User" | "Organization";
  accountId: number;
  login: string;
}

/**
 * Minimal GitHub: OAuth codes are single use and map to one GitHub user;
 * `/user/installations` lists every installation (the verification library
 * decides ownership); repositories are per installation.
 */
export class FakeGitHub {
  readonly calls: string[] = [];
  private readonly codes = new Map<string, { token: string; userId: number; login: string }>();
  private readonly usedCodes = new Set<string>();
  private readonly tokens = new Map<string, { userId: number; login: string }>();
  readonly installations: FakeInstallation[] = [];
  readonly repos = new Map<number, Array<{ id: number; full_name: string; admin: boolean }>>();
  /** Status to answer for the next repository listing(s), then normal again. */
  failRepositories: number[] = [];
  /** `total_count` to report for repository listings (to simulate oversized installations). */
  reportedRepoCount: number | undefined;
  private seq = 0;

  /** A one-time OAuth code for a GitHub user. */
  code(userId: number, login = `user${userId}`): string {
    const code = `code${++this.seq}x${userId}`;
    this.codes.set(code, { token: `gho_local_${this.seq}_${userId}`, userId, login });
    return code;
  }

  addPersonalInstallation(id: number, userId: number, repos: Array<{ id: number; admin?: boolean }>): void {
    this.installations.push({ id, appId: Number(APP_ID), type: "User", accountId: userId, login: `user${userId}` });
    this.repos.set(
      id,
      repos.map((r) => ({ id: r.id, full_name: `user${userId}/repo-${r.id}`, admin: r.admin ?? true })),
    );
  }

  readonly transport: GitHubTransport = {
    request: async (_method, url, opts) => {
      const [path, query] = url.split("?");
      this.calls.push(path);
      const respond = (status: number, body: unknown) => ({ status, body, headers: {} });

      if (path === "https://github.com/login/oauth/access_token") {
        if (opts.form?.client_secret !== OAUTH_CLIENT_SECRET) return respond(401, {});
        const code = opts.form?.code ?? "";
        const grant = this.codes.get(code);
        if (!grant || this.usedCodes.has(code)) return respond(200, { error: "bad_verification_code" });
        this.usedCodes.add(code);
        this.tokens.set(grant.token, { userId: grant.userId, login: grant.login });
        return respond(200, { access_token: grant.token, token_type: "bearer" });
      }

      const user = this.tokens.get(opts.userToken ?? "");
      if (!user) return respond(401, {});
      if (path === "https://api.github.com/user") return respond(200, { id: user.userId, login: user.login });
      if (path === "https://api.github.com/user/installations") {
        const installations = this.installations.map((i) => ({
          id: i.id,
          app_id: i.appId,
          target_type: i.type,
          suspended_at: null,
          account: { id: i.accountId, login: i.login },
        }));
        return respond(200, { total_count: installations.length, installations });
      }
      const m = /^https:\/\/api\.github\.com\/user\/installations\/(\d+)\/repositories$/.exec(path);
      if (m) {
        const failure = this.failRepositories.shift();
        if (failure) return respond(failure, {});
        const all = this.repos.get(Number(m[1]));
        const installation = this.installations.find((i) => i.id === Number(m[1]));
        if (!all || !installation || installation.accountId !== user.userId) return respond(404, {});
        const page = Number(new URLSearchParams(query).get("page") ?? "1");
        const items = all.slice((page - 1) * 100, page * 100).map((r) => ({
          id: r.id,
          full_name: r.full_name,
          permissions: { admin: r.admin },
        }));
        return respond(200, { total_count: this.reportedRepoCount ?? all.length, repositories: items });
      }
      return respond(404, {});
    },
  };
}

// ─── The application ─────────────────────────────────────────────────────────

let signingKey: CryptoKey | undefined;
let keySet: JWTVerifyGetKey | undefined;

async function keys(): Promise<{ signingKey: CryptoKey; keySet: JWTVerifyGetKey }> {
  if (!signingKey || !keySet) {
    const pair = await generateKeyPair("ES384");
    signingKey = pair.privateKey;
    keySet = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "local", alg: "ES384" }] });
  }
  return { signingKey, keySet };
}

/** A Logto-style access token for `userId` (`logto:<sub>`). */
export async function tokenFor(userId: string): Promise<string> {
  const { signingKey } = await keys();
  return new SignJWT({ client_id: CLIENT_ID })
    .setProtectedHeader({ alg: "ES384", kid: "local", typ: "at+jwt" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(userId.replace(/^logto:/, ""))
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(signingKey);
}

export interface DashboardApp {
  handle: DashboardHandler;
  github: FakeGitHub;
  writer: FakeWriter;
}

/** Builds the dashboard API; `writer` defaults to a working fake SSM writer. */
export async function dashboardApp(o: { writer?: FakeWriter; github?: FakeGitHub } = {}): Promise<DashboardApp> {
  const { keySet } = await keys();
  const github = o.github ?? new FakeGitHub();
  const writer = o.writer ?? fakeWriter();
  const env = { GITHUB_APP_ID: APP_ID, GITHUB_APP_CLIENT_ID: "Iv23liLocal01", GITHUB_APP_SLUG: "syncro-local" } as DashboardEnv;
  const services = {
    ...productionServices(env),
    destinationWriter: () => writer,
    github: async () => createGitHubVerification({ appId: APP_ID, clientId: env.GITHUB_APP_CLIENT_ID, clientSecret: OAUTH_CLIENT_SECRET }),
    githubTransport: () => github.transport,
  };
  const deps = {
    authenticate: createAuthenticator({ issuer: ISSUER, audience: AUDIENCE, clientId: CLIENT_ID, jwksUri: "https://unused.invalid/jwks" }, keySet),
    resolveWorkspaceContext,
    consumeRateLimit: (userId: string, bucket: Parameters<typeof consumeRateLimit>[1]) => consumeRateLimit(userId, bucket),
    handlers: createRouteHandlers(services),
  };
  return { handle: createDashboardHandler(() => deps), github, writer };
}

export interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  raw: string;
}

let requestSeq = 0;

/** Sends one request through the full pipeline as `userId` (or unauthenticated with `null`). */
export async function call(
  app: DashboardApp,
  userId: string | null,
  method: "GET" | "POST" | "PATCH" | "PUT",
  path: string,
  o: { body?: unknown; query?: Record<string, string> } = {},
): Promise<ApiResponse> {
  const event: APIGatewayProxyEventV2 = {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: "",
    headers: userId ? { authorization: `Bearer ${await tokenFor(userId)}` } : {},
    queryStringParameters: o.query,
    requestContext: { requestId: `ddb-${++requestSeq}`, http: { method, path } } as APIGatewayProxyEventV2["requestContext"],
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
    isBase64Encoded: false,
  };
  const res = await app.handle(event);
  const raw = res.body ?? "";
  return { status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {}, headers: (res.headers ?? {}) as Record<string, string>, raw };
}

/** Captures log lines for leak assertions; `fetch` is replaced so no request can leave the machine. */
export function captureLogsAndBlockNetwork(): { lines: string[] } {
  const captured = { lines: [] as string[] };
  beforeEach(() => {
    captured.lines.length = 0;
    jest.spyOn(console, "log").mockImplementation((line: string) => void captured.lines.push(String(line)));
    global.fetch = jest.fn(async () => {
      throw new Error("network access is not allowed in DynamoDB Local suites");
    }) as unknown as typeof fetch;
  });
  afterEach(() => jest.restoreAllMocks());
  return captured;
}

/** The `state` query parameter of a GitHub redirect URL returned by the API. */
export function stateOf(res: ApiResponse): string {
  const state = new URL(String(res.body.url)).searchParams.get("state");
  if (!state) throw new Error("no state in redirect URL");
  return state;
}

export interface Onboarded {
  uid: string;
  workspaceId: string;
  githubUserId: number;
  installationId: number;
  repoIds: number[];
  listingId: string;
  /** `/api/workspaces/<id>` */
  base: string;
}

/**
 * A new user who signed up and claimed a personal installation through the
 * routes (bootstrap → install-url → claim), exactly as the web app would.
 */
export async function onboard(app: DashboardApp, uid: string, repoCount = 3): Promise<Onboarded> {
  const boot = await call(app, uid, "POST", "/api/me/bootstrap");
  if (boot.status !== 200) throw new Error(`bootstrap failed: ${boot.raw}`);
  const workspaceId = String(boot.body.workspaceId);
  const base = `/api/workspaces/${workspaceId}`;
  const githubUserId = githubNumber();
  const installationId = githubNumber();
  const repoIds = Array.from({ length: repoCount }, () => githubNumber());
  app.github.addPersonalInstallation(installationId, githubUserId, repoIds.map((id) => ({ id })));

  const state = stateOf(await call(app, uid, "POST", `${base}/github/install-url`));
  const claim = await call(app, uid, "POST", `${base}/github/claim`, {
    body: { code: app.github.code(githubUserId), installationId: String(installationId), state },
  });
  if (claim.status !== 200) throw new Error(`claim failed: ${claim.raw}`);
  const listingId = String((claim.body.listing as Record<string, unknown>).listingId);
  return { uid, workspaceId, githubUserId, installationId, repoIds, listingId, base };
}

/** Adds `userId` to a workspace with `role` (team support is not exposed yet, so this writes the items directly). */
export async function addMember(workspaceId: string, userId: string, role: "admin" | "member"): Promise<void> {
  const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
  const { ddb } = await import("../../../src/db/client");
  const { tableName } = await import("../harness");
  const now = new Date().toISOString();
  await ddb.send(
    new PutCommand({
      TableName: tableName(),
      Item: { PK: `WS#${workspaceId}`, SK: `MEMBER#${userId}`, workspace_id: workspaceId, user_id: userId, role, status: "active", joined_at: now },
    }),
  );
}

/** A unique GitHub numeric ID usable as a JSON number. */
let idSeq = 0;
export function githubNumber(): number {
  idSeq += 1;
  return 1_000_000 + Math.floor(Math.random() * 900_000_000) + idSeq;
}
