/**
 * Dashboard request pipeline. Every request passes these steps in order, and
 * the first refusal ends it:
 *
 * 1. Route: exact method and path from the contract table, with a handler
 *    registered; otherwise 404 `not_found`.
 * 2. Body size: over 16,384 decoded bytes → 413 `payload_too_large`, before
 *    the token is verified or anything is parsed.
 * 3. Authentication: a valid Logto access token → user ID; otherwise 401
 *    `unauthenticated`. If the signing keys cannot be fetched → 500.
 * 4. Workspace routes: a malformed workspace or resource ID, no active
 *    membership, or an inactive workspace → 404 `not_found` (existence is
 *    never revealed); a role below the route's minimum → 403 `forbidden`.
 * 5. Per-user rate limit for the route's bucket → 429 `rate_limited` with
 *    `Retry-After`; if the counter store fails → 503 `rate_limit_unavailable`.
 * 6. Strict validation of the query and JSON body → 400 `invalid_request`
 *    with field paths only.
 * 7. The route handler. A `ContractError` becomes its contract response;
 *    anything else becomes 500 `internal_error` with no detail.
 *
 * Write routes produce one audit line per request, whatever the outcome.
 */

import type { APIGatewayProxyEventV2 } from "aws-lambda";
import type { WorkspaceContext, RateLimitDecision } from "../contracts/data-ops";
import { ContractError, type ApiErrorCode } from "../contracts/errors";
import type { RateLimitBucket } from "../contracts/constants";
import type { RouteId } from "../contracts/routes";
import { roleSatisfies } from "../contracts/roles";
import { logger } from "../utils/logger";
import { AuthError, type Authenticate, type AuthenticatedUser } from "./auth";
import { auditWrite } from "./audit";
import { errorResponse, jsonResponse, type DashboardResponse, type ErrorOptions } from "./http";
import { matchRoute, ROUTE_SCHEMAS } from "./registry";
import { parseJson, readBody, validate } from "./request";

export interface RouteRequest {
  routeId: RouteId;
  requestId: string;
  user: AuthenticatedUser;
  /** Set on workspace routes (proof of active membership); `null` on user-level routes. */
  ctx: WorkspaceContext | null;
  path: Record<string, string>;
  query: unknown;
  body: unknown;
}

export interface RouteResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type RouteHandler = (request: RouteRequest) => Promise<RouteResult>;

export interface PipelineDeps {
  authenticate: Authenticate;
  resolveWorkspaceContext(userId: string, workspaceId: string): Promise<WorkspaceContext | null>;
  consumeRateLimit(userId: string, bucket: RateLimitBucket): Promise<RateLimitDecision>;
  /** Routes without a handler are answered 404, like unknown routes. */
  handlers: Partial<Record<RouteId, RouteHandler>>;
  now?: () => number;
}

export type DashboardHandler = (event: APIGatewayProxyEventV2) => Promise<DashboardResponse>;

class Refusal {
  constructor(
    readonly code: ApiErrorCode,
    readonly options: ErrorOptions = {},
  ) {}
}

function header(event: APIGatewayProxyEventV2, name: string): string | undefined {
  const headers = event.headers ?? {};
  return headers[name] ?? Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
}

/**
 * Builds the Lambda handler. `getDeps` is called per request (it may cache);
 * if it throws, for example on invalid configuration, the request fails
 * closed with 500.
 */
export function createDashboardHandler(getDeps: () => PipelineDeps): DashboardHandler {
  return async (event) => {
    const requestId = event.requestContext?.requestId ?? "unknown";
    const method = event.requestContext?.http?.method ?? "";
    const match = matchRoute(method, event.rawPath ?? "");
    // API Gateway already routed the request; a disagreement is treated as unknown.
    if (!match || (event.routeKey && event.routeKey !== "$default" && event.routeKey !== `${method} ${match.spec.path}`)) {
      return errorResponse("not_found");
    }

    let deps: PipelineDeps;
    try {
      deps = getDeps();
    } catch (error) {
      logger.error("Dashboard API is misconfigured", { error: error instanceof Error ? error.name : "unknown" });
      return errorResponse("internal_error");
    }

    const route = match.spec;
    const handler = deps.handlers[route.id];
    if (!handler) return errorResponse("not_found");

    const now = deps.now ?? Date.now;
    const started = now();
    const isWrite = route.method !== "GET";
    let user: AuthenticatedUser | undefined;
    let ctx: WorkspaceContext | null = null;

    const finish = (response: DashboardResponse, outcome: "ok" | ApiErrorCode): DashboardResponse => {
      if (isWrite) {
        auditWrite({
          requestId,
          route: route.id,
          userId: user?.userId,
          workspaceId: ctx?.workspaceId,
          status: response.statusCode ?? 500,
          outcome,
          durationMs: now() - started,
        });
      }
      return response;
    };

    try {
      const schemas = ROUTE_SCHEMAS[route.id];

      const body = readBody(event.body, event.isBase64Encoded);
      if (!body.ok) throw new Refusal(body.code);

      try {
        user = await deps.authenticate(header(event, "authorization"));
      } catch (error) {
        const reason = error instanceof AuthError ? error.reason : "invalid_token";
        logger.warn("Dashboard request not authenticated", { requestId, route: route.id, reason });
        throw new Refusal(reason === "jwks_unavailable" ? "internal_error" : "unauthenticated");
      }

      let path: Record<string, string> = {};
      if (schemas.path) {
        const parsed = validate(schemas.path, match.params);
        if (!parsed.ok) throw new Refusal("not_found");
        path = parsed.data as Record<string, string>;
      }

      if (route.access !== "token") {
        ctx = await deps.resolveWorkspaceContext(user.userId, path.workspaceId);
        if (!ctx) throw new Refusal("not_found");
        if (!roleSatisfies(ctx.role, route.access)) throw new Refusal("forbidden");
      }

      if (route.rateBucket) {
        let decision: RateLimitDecision;
        try {
          decision = await deps.consumeRateLimit(user.userId, route.rateBucket);
        } catch (error) {
          logger.error("Rate-limit store failed", { requestId, route: route.id, error: error instanceof Error ? error.name : "unknown" });
          throw new Refusal("rate_limit_unavailable");
        }
        if (!decision.allowed) throw new Refusal("rate_limited", { retryAfterSeconds: decision.retryAfterSeconds });
      }

      const query = validate(schemas.query, event.queryStringParameters ?? {});
      if (!query.ok) throw new Refusal("invalid_request", { fields: query.fields.map((f) => `query.${f}`) });

      let input: unknown = undefined;
      if (schemas.body === null) {
        if (body.text !== undefined) throw new Refusal("invalid_request", { fields: ["(root)"] });
      } else {
        let value: unknown = {};
        if (body.text !== undefined) {
          const json = parseJson(body.text);
          if (!json.ok) throw new Refusal("invalid_request", { fields: ["(root)"] });
          value = json.value;
        }
        const parsed = validate(schemas.body, value);
        if (!parsed.ok) throw new Refusal("invalid_request", { fields: parsed.fields });
        input = parsed.data;
      }

      const result = await handler({ routeId: route.id, requestId, user, ctx, path, query: query.data, body: input });
      return finish(jsonResponse(result.status, result.body, result.headers), "ok");
    } catch (error) {
      if (error instanceof Refusal) return finish(errorResponse(error.code, error.options), error.code);
      if (error instanceof ContractError) return finish(errorResponse(error.code), error.code);
      logger.error("Dashboard request failed", { requestId, route: route.id, error: error instanceof Error ? error.name : "unknown" });
      return finish(errorResponse("internal_error"), "internal_error");
    }
  };
}
