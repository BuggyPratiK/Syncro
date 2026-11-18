/**
 * Route registry: the contract route table plus the request schemas for each
 * route. Default deny: a request that matches no route, or a route with no
 * handler yet, is answered 404 exactly like an unknown path.
 *
 * Typed as a record over every `RouteId`, so adding a route to the contract
 * without schemas here fails to compile.
 */

import { z } from "zod";
import { ROUTES, type RouteId, type RouteSpec } from "../contracts/routes";
import {
  claimInstallationBodySchema,
  createDestinationBodySchema,
  destinationPathSchema,
  emptyBodySchema,
  listQuerySchema,
  registerRepoBodySchema,
  replaceWebhookBodySchema,
  repoListingBodySchema,
  repoPathSchema,
  updateDestinationBodySchema,
  updateRepoBodySchema,
  workspacePathSchema,
} from "../contracts/schemas";

export interface RouteSchemas {
  /** Path parameters; `null` for routes without any. */
  path: z.ZodTypeAny | null;
  /** Query string; routes without a query schema accept no query parameters. */
  query: z.ZodTypeAny;
  /** JSON body; `null` = the request must not have a body. */
  body: z.ZodTypeAny | null;
}

const noQuery = z.object({}).strict();

export const ROUTE_SCHEMAS: Readonly<Record<RouteId, RouteSchemas>> = {
  "me.get": { path: null, query: noQuery, body: null },
  "me.bootstrap": { path: null, query: noQuery, body: emptyBodySchema },
  "github.installUrl": { path: workspacePathSchema, query: noQuery, body: emptyBodySchema },
  "github.claim": { path: workspacePathSchema, query: noQuery, body: claimInstallationBodySchema },
  "github.authorizeUrl": { path: workspacePathSchema, query: noQuery, body: emptyBodySchema },
  "github.repoListing": { path: workspacePathSchema, query: noQuery, body: repoListingBodySchema },
  "installations.list": { path: workspacePathSchema, query: listQuerySchema, body: null },
  "repos.list": { path: workspacePathSchema, query: listQuerySchema, body: null },
  "repos.register": { path: workspacePathSchema, query: noQuery, body: registerRepoBodySchema },
  "repos.update": { path: repoPathSchema, query: noQuery, body: updateRepoBodySchema },
  "destinations.list": { path: workspacePathSchema, query: listQuerySchema, body: null },
  "destinations.create": { path: workspacePathSchema, query: noQuery, body: createDestinationBodySchema },
  "destinations.update": { path: destinationPathSchema, query: noQuery, body: updateDestinationBodySchema },
  "destinations.replaceWebhook": { path: destinationPathSchema, query: noQuery, body: replaceWebhookBodySchema },
  "deliveries.list": { path: workspacePathSchema, query: listQuerySchema, body: null },
};

export interface MatchedRoute {
  spec: RouteSpec;
  /** Raw path segments captured by `{name}` placeholders (not yet validated). */
  params: Record<string, string>;
}

interface CompiledRoute {
  spec: RouteSpec;
  pattern: RegExp;
  names: string[];
}

const COMPILED: readonly CompiledRoute[] = ROUTES.map((spec) => {
  const names: string[] = [];
  const source = spec.path
    .split("/")
    .map((segment) => {
      const param = /^\{([A-Za-z]+)\}$/.exec(segment);
      if (param) {
        names.push(param[1]);
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { spec, pattern: new RegExp(`^${source}$`), names };
});

/** Exact method and path match against the contract routes; `null` = not a dashboard route. */
export function matchRoute(method: string, rawPath: string): MatchedRoute | null {
  for (const route of COMPILED) {
    if (route.spec.method !== method) continue;
    const m = route.pattern.exec(rawPath);
    if (!m) continue;
    const params: Record<string, string> = {};
    route.names.forEach((name, i) => (params[name] = m[i + 1]));
    return { spec: route.spec, params };
  }
  return null;
}
