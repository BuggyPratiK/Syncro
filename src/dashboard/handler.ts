/**
 * Dashboard API Lambda entry point.
 *
 * Default deny: until the route registry is wired in, every request is
 * answered 404 `not_found`, exactly like an unknown route.
 */

import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";

export async function handler(): Promise<APIGatewayProxyStructuredResultV2> {
  return {
    statusCode: 404,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ error: "not_found" }),
  };
}
