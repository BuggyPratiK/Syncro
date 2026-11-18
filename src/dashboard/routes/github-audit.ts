/**
 * Wraps the GitHub transport so every HTTP call to GitHub produces exactly one
 * audit line. The line names the call by a fixed operation name, never by its
 * URL, and records only the outcome, GitHub's status and the duration: no
 * token, OAuth code, client secret or response body.
 */

import type { GitHubTransport } from "../../contracts/data-ops";
import { auditGitHubCall } from "../audit";
import type { GitHubCallScope } from "./services";

const OPERATIONS: ReadonlyArray<[RegExp, string]> = [
  [/^https:\/\/github\.com\/login\/oauth\/access_token$/, "exchange_oauth_code"],
  [/^https:\/\/api\.github\.com\/user$/, "get_user"],
  [/^https:\/\/api\.github\.com\/user\/installations$/, "list_user_installations"],
  [/^https:\/\/api\.github\.com\/user\/installations\/\d+\/repositories$/, "list_installation_repositories"],
  [/^https:\/\/api\.github\.com\/user\/memberships\/orgs\/[^/]+$/, "get_org_membership"],
];

function operationOf(url: string): string {
  const withoutQuery = url.split("?")[0];
  return OPERATIONS.find(([pattern]) => pattern.test(withoutQuery))?.[1] ?? "other";
}

export function auditedGitHubTransport(inner: GitHubTransport, scope: GitHubCallScope, now: () => number = Date.now): GitHubTransport {
  return {
    async request(method, url, opts) {
      const operation = operationOf(url);
      const started = now();
      try {
        const res = await inner.request(method, url, opts);
        auditGitHubCall({
          ...scope,
          operation,
          outcome: res.status >= 200 && res.status < 300 ? "ok" : "rejected",
          httpStatus: res.status,
          durationMs: now() - started,
        });
        return res;
      } catch (error) {
        const name = (error as { name?: string } | null)?.name;
        auditGitHubCall({
          ...scope,
          operation,
          outcome: name === "TimeoutError" || name === "AbortError" ? "timeout" : "error",
          durationMs: now() - started,
        });
        throw error;
      }
    },
  };
}
