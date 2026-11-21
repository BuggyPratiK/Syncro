/**
 * HTTP client for the dashboard API.
 *
 * - A fresh access token is requested from the auth layer for every request
 *   and sent only as `Authorization: Bearer`; this module never stores it.
 * - No token (signed out or session expired) sends the user to sign-in.
 *   A 500 is never treated as a sign-out: the API answers 500 when the
 *   identity provider's signing keys are unreachable.
 * - Paths and methods come from the contract route table, so the client
 *   cannot drift from the server's routes.
 */

import { ROUTES, type HttpMethod, type RouteId } from "@contracts";
import { ApiError, codeForStatus, isApiErrorCode, parseRetryAfter } from "./errors";
import type { DashboardApi, PageParams } from "./types";

export interface HttpClientOptions {
  baseUrl: string;
  /** Returns a current access token for the API resource, or null when there is none. */
  getAccessToken: () => Promise<string | null | undefined>;
  /** Called when the user must sign in again (no token, or 401). */
  onSignInRequired: () => void;
  fetch?: typeof fetch;
}

interface RequestSpec {
  params?: Record<string, string>;
  query?: PageParams;
  body?: unknown;
}

export function routeRequest(id: RouteId, params: Record<string, string> = {}): { method: HttpMethod; path: string } {
  const spec = ROUTES.find((r) => r.id === id);
  if (!spec) throw new Error(`Unknown route: ${id}`);
  const path = spec.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (!value) throw new Error(`Missing path parameter: ${name}`);
    return encodeURIComponent(value);
  });
  return { method: spec.method, path };
}

function queryString(query: PageParams | undefined): string {
  if (!query) return "";
  const search = new URLSearchParams();
  if (query.cursor) search.set("cursor", query.cursor);
  if (query.limit !== undefined) search.set("limit", String(query.limit));
  const text = search.toString();
  return text ? `?${text}` : "";
}

async function readErrorBody(response: Response): Promise<{ error?: unknown; fields?: unknown }> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === "object" ? (body as { error?: unknown; fields?: unknown }) : {};
  } catch {
    return {};
  }
}

export function createHttpClient(options: HttpClientOptions): DashboardApi {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function call<T>(id: RouteId, spec: RequestSpec = {}): Promise<T> {
    const { method, path } = routeRequest(id, spec.params);

    let token: string | null | undefined;
    try {
      token = await options.getAccessToken();
    } catch {
      token = null;
    }
    if (!token) {
      options.onSignInRequired();
      throw new ApiError("unauthenticated", 401);
    }

    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (spec.body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await doFetch(`${options.baseUrl}${path}${queryString(spec.query)}`, {
        method,
        headers,
        body: spec.body !== undefined ? JSON.stringify(spec.body) : undefined,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
      });
    } catch {
      throw new ApiError("network_error", 0);
    }

    if (response.ok) {
      try {
        return (await response.json()) as T;
      } catch {
        throw new ApiError("unexpected_response", response.status);
      }
    }

    const body = await readErrorBody(response);
    const code = isApiErrorCode(body.error) ? body.error : codeForStatus(response.status);
    const fields =
      code === "invalid_request" && Array.isArray(body.fields)
        ? body.fields.filter((f): f is string => typeof f === "string")
        : undefined;
    const retryAfterSeconds =
      code === "rate_limited" ? parseRetryAfter(response.headers.get("retry-after")) : undefined;

    if (code === "unauthenticated") options.onSignInRequired();
    throw new ApiError(code, response.status, { retryAfterSeconds, fields });
  }

  const ws = (workspaceId: string) => ({ workspaceId });

  return {
    getMe: () => call("me.get"),
    bootstrap: () => call("me.bootstrap", { body: {} }),
    installUrl: (w) => call("github.installUrl", { params: ws(w), body: {} }),
    authorizeUrl: (w) => call("github.authorizeUrl", { params: ws(w), body: {} }),
    claimInstallation: (w, body) => call("github.claim", { params: ws(w), body }),
    repoListing: (w, body) => call("github.repoListing", { params: ws(w), body }),
    listInstallations: (w, page) => call("installations.list", { params: ws(w), query: page }),
    listRepos: (w, page) => call("repos.list", { params: ws(w), query: page }),
    registerRepo: (w, body) => call("repos.register", { params: ws(w), body }),
    updateRepo: (w, repoId, body) => call("repos.update", { params: { ...ws(w), repoId }, body }),
    listDestinations: (w, page) => call("destinations.list", { params: ws(w), query: page }),
    createDestination: (w, body) => call("destinations.create", { params: ws(w), body }),
    updateDestination: (w, destinationId, body) =>
      call("destinations.update", { params: { ...ws(w), destinationId }, body }),
    replaceWebhook: (w, destinationId, body) =>
      call("destinations.replaceWebhook", { params: { ...ws(w), destinationId }, body }),
    listDeliveries: (w, page) => call("deliveries.list", { params: ws(w), query: page }),
  };
}
