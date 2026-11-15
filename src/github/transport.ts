/**
 * HTTP transport for GitHub user-to-server calls (dashboard onboarding).
 *
 * - Only `https://github.com` (OAuth token endpoint) and
 *   `https://api.github.com` may be called; redirects are refused.
 * - Every request has a timeout; a timeout or network error throws, and the
 *   verification functions treat that as "not verified" (fail closed).
 * - The user token is sent only in the Authorization header and is never
 *   logged.
 */

import { RELAY } from "../contracts/constants";
import type { GitHubTransport, GitHubTransportResponse } from "../contracts/data-ops";

const ALLOWED_HOSTS = new Set(["github.com", "api.github.com"]);

export function createFetchGitHubTransport(timeoutMs: number = RELAY.githubRequestTimeoutMs): GitHubTransport {
  return {
    async request(method, url, opts): Promise<GitHubTransportResponse> {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname)) {
        throw new Error("GitHub transport: host not allowed");
      }
      const headers: Record<string, string> = {
        Accept: opts.form ? "application/json" : "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "syncro",
      };
      if (opts.userToken) headers.Authorization = `Bearer ${opts.userToken}`;
      let body: string | undefined;
      if (opts.form) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        body = new URLSearchParams(opts.form).toString();
      }

      const res = await fetch(parsed, { method, headers, body, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      let json: unknown = undefined;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        out[k.toLowerCase()] = v;
      });
      return { status: res.status, body: json, headers: out };
    },
  };
}
