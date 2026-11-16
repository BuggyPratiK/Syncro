/**
 * Dashboard API route table.
 *
 * Default deny: the dashboard API serves exactly these routes; anything else is 404.
 * `access` is the minimum: `token` = any verified user; a role = membership of
 * the path workspace with at least that role (non-member/non-active → 404,
 * insufficient role → 403). `POST /webhooks/github` is NOT a dashboard route:
 * neither the 16 KB limiter nor the rate limiter applies to it.
 */

import type { RateLimitBucket } from "./constants";
import type { RouteAccess } from "./roles";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT";

export type RouteId =
  | "me.get"
  | "me.bootstrap"
  | "github.installUrl"
  | "github.claim"
  | "github.authorizeUrl"
  | "github.repoListing"
  | "installations.list"
  | "repos.list"
  | "repos.register"
  | "repos.update"
  | "destinations.list"
  | "destinations.create"
  | "destinations.update"
  | "destinations.replaceWebhook"
  | "deliveries.list";

export interface RouteSpec {
  id: RouteId;
  method: HttpMethod;
  /** API Gateway HTTP API path syntax. */
  path: string;
  access: RouteAccess;
  /** Per-user rate-limit bucket; `null` = no per-user limit (read routes). */
  rateBucket: RateLimitBucket | null;
  /** Extra API Gateway throttle (2 rps, burst 5) for routes that are expensive or call GitHub/SSM. */
  routeThrottle: boolean;
}

const WS = "/api/workspaces/{workspaceId}";

export const ROUTES: readonly RouteSpec[] = [
  { id: "me.get", method: "GET", path: "/api/me", access: "token", rateBucket: null, routeThrottle: false },
  { id: "me.bootstrap", method: "POST", path: "/api/me/bootstrap", access: "token", rateBucket: "bootstrap", routeThrottle: true },

  { id: "github.installUrl", method: "POST", path: `${WS}/github/install-url`, access: "owner", rateBucket: "github", routeThrottle: true },
  { id: "github.claim", method: "POST", path: `${WS}/github/claim`, access: "owner", rateBucket: "github", routeThrottle: true },
  { id: "github.authorizeUrl", method: "POST", path: `${WS}/github/authorize-url`, access: "owner", rateBucket: "github", routeThrottle: true },
  { id: "github.repoListing", method: "POST", path: `${WS}/github/repo-listing`, access: "owner", rateBucket: "github", routeThrottle: true },

  { id: "installations.list", method: "GET", path: `${WS}/installations`, access: "member", rateBucket: null, routeThrottle: false },

  { id: "repos.list", method: "GET", path: `${WS}/repos`, access: "member", rateBucket: null, routeThrottle: false },
  { id: "repos.register", method: "POST", path: `${WS}/repos`, access: "owner", rateBucket: "write", routeThrottle: false },
  { id: "repos.update", method: "PATCH", path: `${WS}/repos/{repoId}`, access: "owner", rateBucket: "write", routeThrottle: false },

  { id: "destinations.list", method: "GET", path: `${WS}/destinations`, access: "member", rateBucket: null, routeThrottle: false },
  { id: "destinations.create", method: "POST", path: `${WS}/destinations`, access: "owner", rateBucket: "write", routeThrottle: true },
  { id: "destinations.update", method: "PATCH", path: `${WS}/destinations/{destinationId}`, access: "owner", rateBucket: "write", routeThrottle: true },
  { id: "destinations.replaceWebhook", method: "PUT", path: `${WS}/destinations/{destinationId}/webhook`, access: "owner", rateBucket: "write", routeThrottle: true },

  { id: "deliveries.list", method: "GET", path: `${WS}/deliveries`, access: "member", rateBucket: null, routeThrottle: false },
];

/** The routes of the separate webhook API (not dashboard routes). */
export const WEBHOOK_API_ROUTES = [
  { method: "POST", path: "/webhooks/github" },
  { method: "GET", path: "/health" },
] as const;
