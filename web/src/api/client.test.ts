import { API_ERROR_CODES, API_ERROR_STATUS, ROUTES } from "@contracts";
import { describe, expect, it, vi } from "vitest";
import { createHttpClient, routeRequest } from "./client";
import { ApiError } from "./errors";
import { ROUTE_METHODS } from "./types";

const WS = "ws_6f1c2d3e-4a5b-4c6d-8e7f-901234567890";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function setup(response: () => Response | Promise<Response>, token: string | null = "tok-1") {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => response());
  const getAccessToken = vi.fn(async () => token);
  const onSignInRequired = vi.fn();
  const api = createHttpClient({ baseUrl: "https://api.example.com", getAccessToken, onSignInRequired, fetch: fetch as unknown as typeof globalThis.fetch });
  return { api, fetch, getAccessToken, onSignInRequired };
}

async function caught(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("route table", () => {
  it("has a client method for every contract route", () => {
    expect(Object.keys(ROUTE_METHODS).sort()).toEqual(ROUTES.map((r) => r.id).sort());
  });

  it("builds paths from the contract and encodes parameters", () => {
    expect(routeRequest("repos.update", { workspaceId: WS, repoId: "42" })).toEqual({
      method: "PATCH",
      path: `/api/workspaces/${WS}/repos/42`,
    });
    expect(routeRequest("repos.update", { workspaceId: WS, repoId: "a/b" }).path).toContain("a%2Fb");
    expect(() => routeRequest("repos.update", { workspaceId: WS })).toThrow("Missing path parameter");
  });
});

describe("requests", () => {
  it("asks for a token on every request and sends it only as a Bearer header", async () => {
    const { api, fetch, getAccessToken } = setup(() => jsonResponse(200, { items: [] }));
    await api.listRepos(WS);
    await api.listRepos(WS);
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`https://api.example.com/api/workspaces/${WS}/repos`);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
    expect(init.credentials).toBe("omit");
    expect(init.body).toBeUndefined();
  });

  it("sends JSON bodies with the contract method and page queries", async () => {
    const { api, fetch } = setup(() => jsonResponse(200, {}));
    await api.updateRepo(WS, "42", { isActive: false });
    const [, init] = fetch.mock.calls[0];
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ isActive: false }));
    await api.listDeliveries(WS, { cursor: "abc_-1", limit: 25 });
    expect(fetch.mock.calls[1][0]).toBe(`https://api.example.com/api/workspaces/${WS}/deliveries?cursor=abc_-1&limit=25`);
  });

  it("sends the user to sign-in when there is no token, without calling the API", async () => {
    const { api, fetch, onSignInRequired } = setup(() => jsonResponse(200, {}), null);
    const error = await caught(api.getMe());
    expect(error.code).toBe("unauthenticated");
    expect(onSignInRequired).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends the user to sign-in on 401", async () => {
    const { api, onSignInRequired } = setup(() => jsonResponse(401, { error: "unauthenticated" }));
    expect((await caught(api.getMe())).code).toBe("unauthenticated");
    expect(onSignInRequired).toHaveBeenCalledTimes(1);
  });

  it("does not sign the user out on 500 (identity provider keys unavailable)", async () => {
    const { api, onSignInRequired } = setup(() => jsonResponse(500, { error: "internal_error" }));
    expect((await caught(api.getMe())).code).toBe("internal_error");
    expect(onSignInRequired).not.toHaveBeenCalled();
  });
});

describe("error responses", () => {
  it.each(API_ERROR_CODES)("maps contract code %s with its status", async (code) => {
    const status = API_ERROR_STATUS[code];
    const { api } = setup(() => jsonResponse(status, { error: code }));
    const error = await caught(api.getMe());
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
  });

  it("reads Retry-After on 429", async () => {
    const { api } = setup(() => jsonResponse(429, { error: "rate_limited" }, { "retry-after": "42" }));
    const error = await caught(api.registerRepo(WS, { listingId: "x", repoId: "1" }));
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(42);
  });

  it("maps a gateway 429 without a contract body to rate_limited", async () => {
    const { api } = setup(() => jsonResponse(429, { message: "Too Many Requests" }));
    const error = await caught(api.getMe());
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBeUndefined();
  });

  it("maps 413 to payload_too_large", async () => {
    const { api } = setup(() => jsonResponse(413, { error: "payload_too_large" }));
    expect((await caught(api.createDestination(WS, { displayName: "a", webhookUrl: "b" }))).code).toBe(
      "payload_too_large",
    );
  });

  it("keeps field paths for 400 invalid_request and drops non-string entries", async () => {
    const { api } = setup(() => jsonResponse(400, { error: "invalid_request", fields: ["watchedBranch", 3] }));
    const error = await caught(api.updateRepo(WS, "1", { watchedBranch: " x" }));
    expect(error.code).toBe("invalid_request");
    expect(error.fields).toEqual(["watchedBranch"]);
  });

  it("maps an unknown error code by status", async () => {
    const { api } = setup(() => jsonResponse(409, { error: "something_new" }));
    expect((await caught(api.getMe())).code).toBe("unexpected_response");
  });

  it("maps a network failure to network_error", async () => {
    const { api } = setup(() => Promise.reject(new TypeError("Failed to fetch")));
    const error = await caught(api.getMe());
    expect(error.code).toBe("network_error");
    expect(error.status).toBe(0);
  });
});
