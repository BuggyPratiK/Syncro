/**
 * Local dashboard API runner.
 *
 * Serves the real dashboard pipeline and route handlers on 127.0.0.1 so the
 * web app can be developed end to end without AWS:
 * - data: DynamoDB Local only (the endpoint must be localhost);
 * - destination webhook URLs: an in-memory store with Parameter Store's write
 *   rules, so nothing is ever written to SSM (values are never printed);
 * - sign-in: the Logto DEV tenant (real token verification against its JWKS);
 * - GitHub: the Syncro DEV GitHub App, with its OAuth client secret taken from
 *   the shell (`DEV_GITHUB_OAUTH_CLIENT_SECRET`), never from SSM.
 *
 * Isolation from AWS is enforced at startup, not assumed: AWS credentials,
 * profiles and the instance-metadata lookup are replaced with inert values,
 * and every SSM client call throws.
 *
 * CORS mirrors the deployed HTTP API (one exact origin, no credentials), which
 * API Gateway handles in production.
 *
 * Usage (DynamoDB Local running via `npm run local:dynamo`):
 *   npx ts-node -P scripts/tsconfig.json scripts/dev-dashboard-runner.ts [--open-signups] [--port 8787]
 * Required environment: LOGTO_ISSUER, LOGTO_JWKS_URI, API_AUDIENCE,
 * LOGTO_SPA_CLIENT_ID, GITHUB_APP_ID, GITHUB_APP_CLIENT_ID, GITHUB_APP_SLUG.
 * Optional: CORS_ORIGIN (default http://localhost:5173), DYNAMODB_ENDPOINT
 * (default http://localhost:8000), DYNAMODB_TABLE_NAME (default syncro-local),
 * DEV_GITHUB_OAUTH_CLIENT_SECRET (needed only for the claim and listing routes).
 */

import * as http from "http";
import { randomUUID } from "crypto";
import { CreateTableCommand, DescribeTableCommand, DynamoDBClient, waitUntilTableExists } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SSMClient } from "@aws-sdk/client-ssm";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { ContractError } from "../src/contracts/errors";
import type { DestinationSecretWriter } from "../src/contracts/data-ops";
import type { DashboardEnv } from "../src/config/env";
import { isDestinationParamName } from "../src/secrets/destination-secrets";

// ─── Configuration ───────────────────────────────────────────────────────────

export interface RunnerConfig {
  port: number;
  corsOrigin: string;
  dynamodbEndpoint: string;
  tableName: string;
  logto: { issuer: string; jwksUri: string; audience: string; clientId: string };
  githubApp: { appId: string; clientId: string; slug: string };
  oauthClientSecret: string | undefined;
  openSignups: boolean;
}

export class RunnerConfigError extends Error {}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** Reads and checks the runner's settings. Error messages name variables, never values. */
export function loadRunnerConfig(env: NodeJS.ProcessEnv, argv: string[] = []): RunnerConfig {
  const missing: string[] = [];
  const need = (name: string): string => {
    const v = env[name];
    if (!v) missing.push(name);
    return v ?? "";
  };
  const logto = {
    issuer: need("LOGTO_ISSUER"),
    jwksUri: need("LOGTO_JWKS_URI"),
    audience: need("API_AUDIENCE"),
    clientId: need("LOGTO_SPA_CLIENT_ID"),
  };
  const githubApp = { appId: need("GITHUB_APP_ID"), clientId: need("GITHUB_APP_CLIENT_ID"), slug: need("GITHUB_APP_SLUG") };
  if (missing.length > 0) throw new RunnerConfigError(`Missing environment variables: ${missing.join(", ")}`);

  const dynamodbEndpoint = env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";
  let endpointHost: string;
  try {
    endpointHost = new URL(dynamodbEndpoint).hostname;
  } catch {
    throw new RunnerConfigError("DYNAMODB_ENDPOINT is not a URL");
  }
  if (!LOCAL_HOSTS.has(endpointHost)) throw new RunnerConfigError("DYNAMODB_ENDPOINT must be a local DynamoDB (localhost)");

  const corsOrigin = env.CORS_ORIGIN ?? "http://localhost:5173";
  if (!/^http:\/\/localhost:\d{1,5}$/.test(corsOrigin)) {
    throw new RunnerConfigError("CORS_ORIGIN must be http://localhost:<port> for the local runner");
  }
  for (const [name, value] of [["LOGTO_ISSUER", logto.issuer], ["LOGTO_JWKS_URI", logto.jwksUri]] as const) {
    if (!value.startsWith("https://")) throw new RunnerConfigError(`${name} must be https`);
  }
  if (!/^[1-9][0-9]{0,18}$/.test(githubApp.appId)) throw new RunnerConfigError("GITHUB_APP_ID must be numeric");

  const tableName = env.DYNAMODB_TABLE_NAME ?? "syncro-local";
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(tableName)) throw new RunnerConfigError("DYNAMODB_TABLE_NAME is invalid");

  const portArg = argv.indexOf("--port");
  const port = portArg >= 0 ? Number(argv[portArg + 1]) : 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RunnerConfigError("--port must be a port number");

  return {
    port,
    corsOrigin,
    dynamodbEndpoint,
    tableName,
    logto,
    githubApp,
    oauthClientSecret: env.DEV_GITHUB_OAUTH_CLIENT_SECRET || undefined,
    openSignups: argv.includes("--open-signups"),
  };
}

/**
 * Points the process at DynamoDB Local and makes any accidental AWS call fail:
 * inert credentials, no profile, no instance-metadata lookup, and SSM blocked.
 * Must run before any application module reads the environment.
 */
export function isolateFromAws(env: NodeJS.ProcessEnv, config: RunnerConfig): void {
  env.AWS_ACCESS_KEY_ID = "local";
  env.AWS_SECRET_ACCESS_KEY = "local";
  delete env.AWS_SESSION_TOKEN;
  delete env.AWS_PROFILE;
  delete env.AWS_DEFAULT_PROFILE;
  env.AWS_EC2_METADATA_DISABLED = "true";
  env.AWS_REGION = env.AWS_REGION ?? "ap-southeast-2";
  env.DYNAMODB_ENDPOINT = config.dynamodbEndpoint;
  env.DYNAMODB_TABLE_NAME = config.tableName;
  // Derived parameter names say "local", so they can never be mistaken for production ones.
  env.SSM_PARAM_PREFIX = "/syncro/local";
  (SSMClient.prototype as unknown as { send: () => Promise<never> }).send = async () => {
    throw new Error("SSM is not available in the local runner");
  };
}

// ─── Local stand-in for Parameter Store ──────────────────────────────────────

export interface LocalSecretStore extends DestinationSecretWriter {
  /** Stored names and versions only; values are never exposed. */
  list(): Array<{ name: string; version: number }>;
}

/** In-memory destination secret store with Parameter Store's write rules. */
export function createLocalSecretStore(): LocalSecretStore {
  const params = new Map<string, { value: string; version: number }>();
  return {
    async put(name, value, { overwrite }) {
      if (!isDestinationParamName(name)) throw new Error("Refusing to write a non-destination parameter");
      const current = params.get(name);
      if (current && !overwrite) throw new ContractError("secret_unavailable");
      const version = (current?.version ?? 0) + 1;
      params.set(name, { value, version });
      return { version };
    },
    list: () => [...params.entries()].map(([name, p]) => ({ name, version: p.version })),
  };
}

// ─── HTTP translation ────────────────────────────────────────────────────────

/** The deployed HTTP API's CORS settings (checked against the CDK template by a test). */
export const RUNNER_CORS = {
  allowMethods: ["GET", "POST", "PATCH", "PUT"],
  allowHeaders: ["authorization", "content-type"],
  exposeHeaders: ["retry-after"],
  maxAgeSeconds: 600,
} as const;

/** Bodies larger than this are refused before they are read in full (API Gateway's limit is far higher). */
const MAX_READ_BYTES = 1024 * 1024;

export function corsHeaders(origin: string | undefined, allowedOrigin: string): Record<string, string> {
  if (origin !== allowedOrigin) return {};
  return { "access-control-allow-origin": allowedOrigin, "access-control-expose-headers": RUNNER_CORS.exposeHeaders.join(","), vary: "origin" };
}

export function preflightHeaders(req: http.IncomingMessage, allowedOrigin: string): Record<string, string> | null {
  const method = String(req.headers["access-control-request-method"] ?? "").toUpperCase();
  if (req.headers.origin !== allowedOrigin || !(RUNNER_CORS.allowMethods as readonly string[]).includes(method)) return null;
  const requested = String(req.headers["access-control-request-headers"] ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (requested.some((h) => !(RUNNER_CORS.allowHeaders as readonly string[]).includes(h))) return null;
  return {
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-methods": RUNNER_CORS.allowMethods.join(","),
    "access-control-allow-headers": RUNNER_CORS.allowHeaders.join(","),
    "access-control-max-age": String(RUNNER_CORS.maxAgeSeconds),
    vary: "origin",
  };
}

/** Builds the API Gateway (payload 2.0) event the Lambda would receive. */
export function toEvent(req: http.IncomingMessage, body: Buffer): APIGatewayProxyEventV2 {
  const url = new URL(req.url ?? "/", "http://localhost");
  const query: Record<string, string> = {};
  // API Gateway joins repeated query parameters with commas.
  for (const [k, v] of url.searchParams) query[k] = k in query ? `${query[k]},${v}` : v;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : v;
  const method = (req.method ?? "GET").toUpperCase();
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers,
    queryStringParameters: Object.keys(query).length > 0 ? query : undefined,
    requestContext: { requestId: randomUUID(), http: { method, path: url.pathname } } as APIGatewayProxyEventV2["requestContext"],
    // Always base64, so the pipeline measures and decodes the exact bytes received.
    body: body.length > 0 ? body.toString("base64") : undefined,
    isBase64Encoded: body.length > 0,
  };
}

function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_READ_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

type Handler = (event: APIGatewayProxyEventV2) => Promise<{ statusCode?: number; headers?: Record<string, unknown>; body?: string }>;

/** The HTTP server around a dashboard handler. One log line per request: method, path, status, time. */
export function createRunnerServer(handler: Handler, corsOrigin: string, log: (line: string) => void = console.log): http.Server {
  return http.createServer((req, res) => {
    const started = Date.now();
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const send = (status: number, headers: Record<string, string>, body?: string) => {
      res.writeHead(status, headers);
      res.end(body);
      log(`${req.method} ${path} ${status} ${Date.now() - started}ms`);
    };

    if (req.method === "OPTIONS") {
      const headers = preflightHeaders(req, corsOrigin);
      send(204, headers ?? {});
      return;
    }

    readBody(req)
      .then(async (body) => {
        const cors = corsHeaders(req.headers.origin, corsOrigin);
        if (body === null) {
          send(413, { "content-type": "application/json", "cache-control": "no-store", ...cors }, JSON.stringify({ error: "payload_too_large" }));
          return;
        }
        const result = await handler(toEvent(req, body));
        const headers = Object.fromEntries(Object.entries(result.headers ?? {}).map(([k, v]) => [k, String(v)]));
        send(result.statusCode ?? 500, { ...headers, ...cors }, result.body);
      })
      .catch(() => send(500, { "content-type": "application/json" }, JSON.stringify({ error: "internal_error" })));
  });
}

// ─── Table setup ─────────────────────────────────────────────────────────────

/** Key schema, index and billing of the production table (checked against the test harness by a test). */
export const LOCAL_TABLE_SCHEMA = {
  BillingMode: "PAY_PER_REQUEST" as const,
  AttributeDefinitions: [
    { AttributeName: "PK", AttributeType: "S" as const },
    { AttributeName: "SK", AttributeType: "S" as const },
    { AttributeName: "GSI1PK", AttributeType: "S" as const },
    { AttributeName: "created_at", AttributeType: "S" as const },
  ],
  KeySchema: [
    { AttributeName: "PK", KeyType: "HASH" as const },
    { AttributeName: "SK", KeyType: "RANGE" as const },
  ],
  GlobalSecondaryIndexes: [
    {
      IndexName: "type-index",
      KeySchema: [
        { AttributeName: "GSI1PK", KeyType: "HASH" as const },
        { AttributeName: "created_at", KeyType: "RANGE" as const },
      ],
      Projection: { ProjectionType: "ALL" as const },
    },
  ],
};

async function ensureTable(config: RunnerConfig): Promise<DynamoDBClient> {
  const client = new DynamoDBClient({ endpoint: config.dynamodbEndpoint, region: process.env.AWS_REGION, credentials: { accessKeyId: "local", secretAccessKey: "local" } });
  try {
    await client.send(new DescribeTableCommand({ TableName: config.tableName }));
  } catch (error) {
    if ((error as { name?: string }).name !== "ResourceNotFoundException") {
      throw new RunnerConfigError(`DynamoDB Local is not reachable at ${config.dynamodbEndpoint}. Start it with "npm run local:dynamo".`);
    }
    await client.send(new CreateTableCommand({ TableName: config.tableName, ...LOCAL_TABLE_SCHEMA }));
    await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: config.tableName });
    console.log(`Created local table ${config.tableName}`);
  }
  return client;
}

// ─── Main ────────────────────────────────────────────────────────────────────

export interface StartedRunner {
  server: http.Server;
  store: LocalSecretStore;
  /** The bound port (useful with port 0). */
  port: number;
}

/**
 * Starts the runner. Call `isolateFromAws` first. `overrides.authenticate`
 * lets tests use a locally signed token instead of the Logto dev tenant.
 */
export async function startRunner(
  config: RunnerConfig,
  overrides: { authenticate?: (header: string | undefined) => Promise<{ userId: string; issuer: string }> } = {},
): Promise<StartedRunner> {
  // Application modules are loaded only after the environment is isolated.
  const { createDashboardHandler } = await import("../src/dashboard/pipeline");
  const { createAuthenticator } = await import("../src/dashboard/auth");
  const { createRouteHandlers } = await import("../src/dashboard/routes");
  const { productionServices } = await import("../src/dashboard/routes/services");
  const { createGitHubVerification } = await import("../src/github/verification");
  const { resolveWorkspaceContext } = await import("../src/tenancy/context");
  const { consumeRateLimit } = await import("../src/ratelimit/rate-limit");
  const { SecretUnavailableError } = await import("../src/config/secrets");

  const client = await ensureTable(config);
  if (config.openSignups) {
    const { parseArgs, run } = await import("./set-signup-mode");
    const doc = DynamoDBDocumentClient.from(client);
    await run(doc, { ...parseArgs(["--mode", "open", "--yes"], {}), table: config.tableName });
    console.log("Signups opened on the local table");
  }

  const env = {
    GITHUB_APP_ID: config.githubApp.appId,
    GITHUB_APP_CLIENT_ID: config.githubApp.clientId,
    GITHUB_APP_SLUG: config.githubApp.slug,
  } as DashboardEnv;
  const store = createLocalSecretStore();
  const services = {
    ...productionServices(env),
    destinationWriter: () => store,
    github: async () => {
      if (!config.oauthClientSecret) {
        throw new SecretUnavailableError("DEV_GITHUB_OAUTH_CLIENT_SECRET", "missing");
      }
      return createGitHubVerification({ appId: env.GITHUB_APP_ID, clientId: env.GITHUB_APP_CLIENT_ID, clientSecret: config.oauthClientSecret });
    },
  };
  const deps = {
    authenticate: overrides.authenticate ?? createAuthenticator(config.logto),
    resolveWorkspaceContext,
    consumeRateLimit: (userId: string, bucket: Parameters<typeof consumeRateLimit>[1]) => consumeRateLimit(userId, bucket),
    handlers: createRouteHandlers(services),
  };
  const server = createRunnerServer(createDashboardHandler(() => deps), config.corsOrigin);
  await new Promise<void>((resolve) => server.listen(config.port, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { server, store, port };
}

async function main(): Promise<void> {
  const config = loadRunnerConfig(process.env, process.argv.slice(2));
  isolateFromAws(process.env, config);
  const { port } = await startRunner(config);
  console.log(`Dashboard API (local) on http://127.0.0.1:${port}  CORS origin ${config.corsOrigin}  table ${config.tableName}`);
  if (!config.oauthClientSecret) console.log("DEV_GITHUB_OAUTH_CLIENT_SECRET is not set: claim and repo-listing will answer 500.");
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof RunnerConfigError ? error.message : `Runner failed: ${error instanceof Error ? error.name : "unknown"}`);
    process.exit(1);
  });
}
