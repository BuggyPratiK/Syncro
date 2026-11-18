/**
 * Dashboard API Lambda entry point.
 *
 * Configuration is validated on the first request and cached for the
 * container; invalid configuration fails every request closed (500).
 * Every request goes through the shared pipeline; there is no other way in.
 */

import { getDashboardEnv } from "../config/env";
import { resolveWorkspaceContext } from "../tenancy/context";
import { consumeRateLimit } from "../ratelimit/rate-limit";
import { createAuthenticator } from "./auth";
import { createDashboardHandler, type PipelineDeps } from "./pipeline";
import { createRouteHandlers } from "./routes";
import { productionServices } from "./routes/services";

let deps: PipelineDeps | undefined;

function getDeps(): PipelineDeps {
  if (!deps) {
    const env = getDashboardEnv();
    deps = {
      authenticate: createAuthenticator({
        issuer: env.LOGTO_ISSUER,
        audience: env.API_AUDIENCE,
        clientId: env.LOGTO_SPA_CLIENT_ID,
        jwksUri: env.LOGTO_JWKS_URI,
      }),
      resolveWorkspaceContext,
      consumeRateLimit: (userId, bucket) => consumeRateLimit(userId, bucket),
      handlers: createRouteHandlers(productionServices(env)),
    };
  }
  return deps;
}

export const handler = createDashboardHandler(getDeps);
