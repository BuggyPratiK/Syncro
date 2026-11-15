/**
 * Fixtures for DynamoDB Local suites.
 *
 * TEST-ONLY verification values: in production, `VerifiedInstallation` and
 * `VerifiedRepositoryListing` come only from the GitHub verification functions
 * (fresh user token). Here they are cast directly so the data layer can be
 * tested on its own; no production code path builds them this way.
 */

import { randomInt } from "crypto";
import { bootstrapUser, setTenancyDepsForTests } from "../../src/db/operations/tenancy.ops";
import { resolveWorkspaceContext } from "../../src/tenancy/context";
import type {
  DestinationSecretWriter,
  VerifiedInstallation,
  VerifiedRepositoryListing,
  WorkspaceContext,
} from "../../src/contracts";
import { ContractError } from "../../src/contracts";
import { parseArgs, run } from "../../scripts/set-signup-mode";
import { tableName, testDocClient } from "./harness";

const ISS = "https://tenant.logto.app/oidc";
let counter = 0;

export async function openSignups(): Promise<void> {
  const doc = testDocClient();
  try {
    await run(doc, { ...parseArgs(["--mode", "open", "--daily-cap", "100000", "--yes"], {}), table: tableName() });
  } finally {
    doc.destroy();
  }
  setTenancyDepsForTests(undefined);
}

export function newUserId(): string {
  counter += 1;
  return `logto:${`t${Date.now().toString(36)}${counter.toString(36)}`.padEnd(12, "0").slice(-12)}`;
}

/** A fresh, unique GitHub numeric ID. */
export function ghId(): string {
  return String(randomInt(1_000_000, 2_000_000_000));
}

/** Bootstraps a new user and returns the owner context of their workspace. */
export async function newOwner(): Promise<WorkspaceContext> {
  const uid = newUserId();
  const { workspaceId } = await bootstrapUser(uid, ISS);
  const ctx = await resolveWorkspaceContext(uid, workspaceId);
  if (!ctx) throw new Error("fixture: context did not resolve");
  return ctx;
}

export function asRole(ctx: WorkspaceContext, role: "admin" | "member"): WorkspaceContext {
  return { ...ctx, role } as WorkspaceContext;
}

export function verifiedInstallation(o: {
  installationId: string;
  githubUserId: string;
  accountType?: "User" | "Organization";
  verifiedAt?: string;
}): VerifiedInstallation {
  return {
    installationId: o.installationId,
    githubUserId: o.githubUserId,
    accountId: o.accountType === "Organization" ? "4242" : o.githubUserId,
    accountLogin: "octo",
    accountType: o.accountType ?? "User",
    proof: o.accountType === "Organization" ? "org_admin" : "personal_owner",
    verifiedVia: "user_oauth",
    verifiedAt: o.verifiedAt ?? new Date().toISOString(),
  } as VerifiedInstallation;
}

export function verifiedListing(o: {
  installationId: string;
  githubUserId: string;
  repos: Array<{ repoId: string; fullName?: string; admin?: boolean }>;
  verifiedAt?: string;
}): VerifiedRepositoryListing {
  return {
    installationId: o.installationId,
    githubUserId: o.githubUserId,
    repos: o.repos.map((r) => ({ repoId: r.repoId, fullName: r.fullName ?? `octo/repo-${r.repoId}`, admin: r.admin ?? true })),
    verifiedAt: o.verifiedAt ?? new Date().toISOString(),
  } as VerifiedRepositoryListing;
}

export interface FakeWriter extends DestinationSecretWriter {
  calls: Array<{ name: string; value: string; overwrite: boolean }>;
}

/** Fake SSM writer: records calls; `failWith` makes the next put fail with that API error. */
export function fakeWriter(opts: { failWith?: "secret_store_busy" | "secret_unavailable" } = {}): FakeWriter {
  const versions = new Map<string, number>();
  const calls: FakeWriter["calls"] = [];
  return {
    calls,
    async put(name, value, { overwrite }) {
      calls.push({ name, value, overwrite });
      if (opts.failWith) throw new ContractError(opts.failWith);
      if (!overwrite && versions.has(name)) throw new ContractError("secret_unavailable");
      const v = (versions.get(name) ?? 0) + 1;
      versions.set(name, v);
      return { version: v };
    },
  };
}

export const VALID_WEBHOOK = "https://discord.com/api/webhooks/123456789012345678/AbCdEf-secret_token";
