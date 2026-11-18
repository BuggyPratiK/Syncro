/**
 * Audit log lines for the dashboard API.
 *
 * One structured line per write request and one per GitHub API call. Lines
 * hold identifiers, outcomes and timings only: never tokens, authorization
 * headers, OAuth codes or states, request bodies, webhook URLs or SSM values.
 * Each field is set explicitly here rather than copied from a request, so
 * nothing unexpected can reach the log.
 */

import type { ApiErrorCode } from "../contracts/errors";
import type { RouteId } from "../contracts/routes";
import { logger } from "../utils/logger";

export interface WriteAuditEntry {
  requestId: string;
  route: RouteId;
  userId: string | undefined;
  workspaceId: string | undefined;
  status: number;
  /** `ok`, or the contract error code that was returned. */
  outcome: "ok" | ApiErrorCode;
  durationMs: number;
}

export function auditWrite(entry: WriteAuditEntry): void {
  logger.info("dashboard.audit.write", {
    audit: "write",
    requestId: entry.requestId,
    route: entry.route,
    userId: entry.userId,
    workspaceId: entry.workspaceId,
    status: entry.status,
    outcome: entry.outcome,
    durationMs: entry.durationMs,
  });
}

export interface GitHubCallAuditEntry {
  requestId: string;
  route: RouteId;
  workspaceId: string;
  /** A fixed operation name, e.g. `exchange_install_code`; never a URL. */
  operation: string;
  outcome: "ok" | "rejected" | "error" | "timeout";
  /** GitHub's HTTP status when there was one. */
  httpStatus?: number;
  durationMs: number;
}

export function auditGitHubCall(entry: GitHubCallAuditEntry): void {
  logger.info("dashboard.audit.github", {
    audit: "github",
    requestId: entry.requestId,
    route: entry.route,
    workspaceId: entry.workspaceId,
    operation: entry.operation,
    outcome: entry.outcome,
    httpStatus: entry.httpStatus,
    durationMs: entry.durationMs,
  });
}
