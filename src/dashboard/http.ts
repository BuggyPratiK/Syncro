/**
 * Dashboard API responses.
 *
 * Errors always have the contract shape `{ "error": <code> }` (plus field
 * paths for `invalid_request`), with the status the contract assigns to the
 * code. No error carries a message, stack, header or request value.
 *
 * CORS headers are not set here: API Gateway adds them for the one allowed
 * origin and ignores CORS headers returned by the function.
 */

import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { API_ERROR_STATUS, type ApiErrorBody, type ApiErrorCode } from "../contracts/errors";

export type DashboardResponse = APIGatewayProxyStructuredResultV2;

const BASE_HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): DashboardResponse {
  return { statusCode: status, headers: { ...BASE_HEADERS, ...headers }, body: JSON.stringify(body) };
}

export interface ErrorOptions {
  /** Invalid field paths for `invalid_request`; never their values. */
  fields?: string[];
  /** Seconds, for `rate_limited`. */
  retryAfterSeconds?: number;
}

export function errorResponse(code: ApiErrorCode, options: ErrorOptions = {}): DashboardResponse {
  const body: ApiErrorBody = { error: code };
  if (code === "invalid_request" && options.fields && options.fields.length > 0) body.fields = options.fields;
  const headers: Record<string, string> = {};
  if (code === "rate_limited" && options.retryAfterSeconds !== undefined) {
    headers["retry-after"] = String(Math.max(1, Math.ceil(options.retryAfterSeconds)));
  }
  if (code === "unauthenticated") headers["www-authenticate"] = "Bearer";
  return jsonResponse(API_ERROR_STATUS[code], body, headers);
}
