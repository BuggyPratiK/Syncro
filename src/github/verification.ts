/**
 * GitHub ownership verification for dashboard onboarding.
 *
 * Proves, with the user's own short-lived GitHub token (user-to-server; the
 * GitHub App private key is never used here), that:
 * - a personal installation's account IS the signed-in GitHub user; or
 * - for an organization installation, the user is an ACTIVE ADMIN of that
 *   exact organization (when organization installations are enabled);
 * - and which repositories of a claimed installation the user administers.
 *
 * Rules:
 * - Values from the browser or the OAuth callback (installation ID, setup
 *   action, sender) are never proof; only what GitHub returns for the token.
 * - Identity is GitHub's immutable numeric user ID; logins are display only.
 * - Fail closed: any non-2xx, rate limit, timeout, unexpected shape or
 *   pagination/count mismatch means "not verified".
 * - The token is held in memory only; it is never stored, logged or returned.
 *
 * Results are branded (`VerifiedInstallation`, `VerifiedRepositoryListing`)
 * and can only be created here.
 */

import { ContractError, type ApiErrorCode, type GitHubVerificationRejectReason } from "../contracts/errors";
import { ORG_INSTALLATIONS_SUPPORTED } from "../contracts/constants";
import { isValidId } from "../contracts/ids";
import type {
  GitHubTransport,
  GitHubTransportResponse,
  GitHubUserToken,
  GitHubVerificationLibrary,
  VerifiedInstallation,
  VerifiedRepositoryListing,
} from "../contracts/data-ops";
import { ListingTooLargeError, MAX_LISTING_REPOS } from "../db/operations/listing.ops";
import { logger } from "../utils/logger";

const API = "https://api.github.com";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const PER_PAGE = 100;
const MAX_INSTALLATION_PAGES = 10;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export interface GitHubVerificationConfig {
  /** The Syncro GitHub App's numeric ID; installations of other Apps are rejected. */
  appId: string;
  clientId: string;
  /** OAuth client secret (from SSM); used only for the code exchange. */
  clientSecret: string;
  orgInstallationsSupported?: boolean;
  now?: () => Date;
}

/** Logs the internal reason and throws the public error code. Never logs tokens. */
function reject(reason: GitHubVerificationRejectReason, code: ApiErrorCode): never {
  logger.warn("GitHub verification rejected", { reason });
  throw new ContractError(code);
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

/** Any unexpected status (including 401, rate limits and 5xx) means "not verified". */
function failResponse(_res: GitHubTransportResponse): never {
  return reject("http_error", "github_unavailable");
}

async function call(
  transport: GitHubTransport,
  method: "GET" | "POST",
  url: string,
  opts: { userToken?: string; form?: Record<string, string> },
): Promise<GitHubTransportResponse> {
  try {
    return await transport.request(method, url, opts);
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    return reject(name === "TimeoutError" || name === "AbortError" ? "timeout" : "http_error", "github_unavailable");
  }
}

/** Fetches every page of a `{ total_count, <key>: [...] }` listing and checks the count. */
async function allPages<T>(
  transport: GitHubTransport,
  token: GitHubUserToken,
  path: string,
  key: string,
  maxPages: number,
  beforeFetch?: (totalCount: number) => void,
): Promise<T[]> {
  const items: T[] = [];
  let total: number | undefined;
  for (let page = 1; page <= maxPages; page++) {
    const res = await call(transport, "GET", `${API}${path}?per_page=${PER_PAGE}&page=${page}`, { userToken: token.accessToken });
    if (res.status !== 200) failResponse(res);
    const body = res.body as Record<string, unknown> | undefined;
    const list = body?.[key];
    if (!body || !Array.isArray(list) || typeof body.total_count !== "number" || body.total_count < 0) {
      return reject("schema_mismatch", "github_unavailable");
    }
    if (total === undefined) {
      total = body.total_count;
      beforeFetch?.(total);
    } else if (body.total_count !== total) {
      return reject("count_mismatch", "github_unavailable"); // listing changed while paging
    }
    items.push(...(list as T[]));
    // A page shorter than per_page is the last one.
    if (items.length >= total || list.length < PER_PAGE) break;
  }
  // Exactly total_count distinct items, or nothing is trusted.
  const ids = new Set(items.map((i) => (i as { id?: unknown })?.id));
  if (items.length !== total || ids.size !== items.length) return reject("count_mismatch", "github_unavailable");
  return items;
}

interface Installation {
  id: number;
  app_id: number;
  target_type: string;
  suspended_at: string | null;
  account: { id: number; login: string } | null;
}

export function createGitHubVerification(config: GitHubVerificationConfig): GitHubVerificationLibrary {
  const orgSupported = config.orgInstallationsSupported ?? ORG_INSTALLATIONS_SUPPORTED;
  const now = config.now ?? (() => new Date());
  if (!isValidId("githubId", config.appId)) throw new Error("Invalid GitHub App ID");
  const appId = Number(config.appId);

  const lib: GitHubVerificationLibrary = {
    async exchangeInstallCode(transport, { code }) {
      if (typeof code !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(code)) reject("schema_mismatch", "github_code_invalid");
      const res = await call(transport, "POST", TOKEN_URL, {
        form: { client_id: config.clientId, client_secret: config.clientSecret, code },
      });
      if (res.status !== 200) failResponse(res);
      const body = res.body as { access_token?: unknown; error?: unknown } | undefined;
      // GitHub answers 200 with { error } for a bad, expired or reused code.
      if (body?.error !== undefined) reject("http_error", "github_code_invalid");
      if (typeof body?.access_token !== "string" || body.access_token.length === 0) reject("schema_mismatch", "github_unavailable");
      return { accessToken: body!.access_token as string };
    },

    async getAuthenticatedGitHubUser(transport, token) {
      const res = await call(transport, "GET", `${API}/user`, { userToken: token.accessToken });
      if (res.status !== 200) failResponse(res);
      const body = res.body as { id?: unknown; login?: unknown } | undefined;
      if (!isPositiveInt(body?.id) || typeof body?.login !== "string") reject("schema_mismatch", "github_unavailable");
      return { githubUserId: String(body!.id), login: body!.login as string };
    },

    async verifyUserOrgAdmin(transport, token, { orgLogin, orgId }) {
      if (!GITHUB_LOGIN.test(orgLogin) || !isValidId("githubId", orgId)) reject("schema_mismatch", "not_installation_owner");
      const res = await call(transport, "GET", `${API}/user/memberships/orgs/${encodeURIComponent(orgLogin)}`, {
        userToken: token.accessToken,
      });
      if (res.status === 403) reject("membership_http_403", "not_installation_owner");
      if (res.status === 404) reject("membership_http_404", "not_installation_owner");
      if (res.status !== 200) failResponse(res);
      const body = res.body as { state?: unknown; role?: unknown; organization?: { id?: unknown } } | undefined;
      if (body?.state !== "active") reject("membership_not_active", "not_installation_owner");
      if (body?.role !== "admin") reject("membership_not_admin", "not_installation_owner");
      if (body?.organization?.id !== Number(orgId)) reject("membership_org_mismatch", "not_installation_owner");
    },

    async verifyUserInstallation(transport, token, { installationId }) {
      if (!isValidId("githubId", installationId)) reject("installation_not_listed", "not_installation_owner");
      const user = await lib.getAuthenticatedGitHubUser(transport, token);
      const installations = await allPages<Installation>(transport, token, "/user/installations", "installations", MAX_INSTALLATION_PAGES);

      const inst = installations.find((i) => i?.id === Number(installationId));
      if (!inst) reject("installation_not_listed", "not_installation_owner"); // includes spoofed or foreign IDs
      if (inst!.app_id !== appId) reject("app_id_mismatch", "not_installation_owner");
      if (inst!.suspended_at !== null) reject("installation_suspended", "not_installation_owner");
      const account = inst!.account;
      if (!account || !isPositiveInt(account.id) || typeof account.login !== "string") reject("schema_mismatch", "github_unavailable");

      let proof: VerifiedInstallation["proof"];
      if (inst!.target_type === "User") {
        // A collaborator can see someone else's personal installation: never enough.
        if (String(account!.id) !== user.githubUserId) reject("account_not_user", "not_installation_owner");
        proof = "personal_owner";
      } else if (inst!.target_type === "Organization") {
        if (!orgSupported) reject("org_not_supported", "org_not_supported");
        await lib.verifyUserOrgAdmin(transport, token, { orgLogin: account!.login, orgId: String(account!.id) });
        proof = "org_admin";
      } else {
        return reject("account_not_user", "not_installation_owner");
      }

      return {
        installationId: String(inst!.id),
        githubUserId: user.githubUserId,
        accountId: String(account!.id),
        accountLogin: account!.login,
        accountType: inst!.target_type as "User" | "Organization",
        proof,
        verifiedVia: "user_oauth",
        verifiedAt: now().toISOString(),
      } as unknown as VerifiedInstallation;
    },

    async listUserInstallationRepositories(transport, token, { installationId, githubUserId }) {
      if (!isValidId("githubId", installationId)) reject("installation_not_listed", "not_installation_owner");
      const user = await lib.getAuthenticatedGitHubUser(transport, token);
      if (user.githubUserId !== githubUserId) reject("account_not_user", "not_installation_owner");

      const maxPages = Math.ceil(MAX_LISTING_REPOS / PER_PAGE);
      const repos = await allPages<{ id?: unknown; full_name?: unknown; permissions?: { admin?: unknown } }>(
        transport,
        token,
        `/user/installations/${installationId}/repositories`,
        "repositories",
        maxPages,
        (total) => {
          // Refuse before paging through a listing that could never be stored whole.
          if (total > MAX_LISTING_REPOS) throw new ListingTooLargeError(total);
        },
      );

      return {
        installationId,
        githubUserId: user.githubUserId,
        repos: repos.map((r) => {
          if (!isPositiveInt(r?.id) || typeof r.full_name !== "string") reject("schema_mismatch", "github_unavailable");
          // Admin only when GitHub says exactly `true`; anything else is not admin.
          return { repoId: String(r.id), fullName: r.full_name as string, admin: r.permissions?.admin === true };
        }),
        verifiedAt: now().toISOString(),
      } as unknown as VerifiedRepositoryListing;
    },
  };
  return lib;
}
