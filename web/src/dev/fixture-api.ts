/**
 * In-memory implementation of the dashboard API, built from the contract
 * types and schemas. Used by tests and by fixture mode (development only);
 * production builds never include it.
 *
 * It mimics the server's observable behaviour closely enough for UI work:
 * strict body validation, per-workspace limits, contract error codes and a
 * masked webhook value. It is not a security boundary.
 */

import {
  claimInstallationBodySchema,
  createDestinationBodySchema,
  registerRepoBodySchema,
  replaceWebhookBodySchema,
  repoListingBodySchema,
  updateDestinationBodySchema,
  updateRepoBodySchema,
  WORKSPACE_LIMITS,
  type ApiErrorCode,
  type DeliveryDto,
  type DestinationDto,
  type InstallationDto,
  type MeDto,
  type Page,
  type RepoDto,
  type RepoListingDto,
} from "@contracts";
import type { z } from "zod";
import { ApiError } from "../api/errors";
import type { DashboardApi, PageParams } from "../api/types";
import { looksLikeDiscordWebhook } from "../lib/discord-hint";

export const FIXTURE_WORKSPACE_ID = "ws_6f1c2d3e-4a5b-4c6d-8e7f-901234567890";
const FIXTURE_STATE = "fixture-state-0123456789abcdefghijklmnopqrs";

function refuse(code: ApiErrorCode, status: number): never {
  throw new ApiError(code, status);
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ApiError("invalid_request", 400, { fields: result.error.issues.map((i) => i.path.join(".") || "(root)") });
  }
  return result.data;
}

function paginate<T>(items: T[], page: PageParams = {}): Page<T> {
  const limit = page.limit ?? 25;
  const start = page.cursor ? Number(page.cursor.replace(/^c/, "")) : 0;
  const slice = items.slice(start, start + limit);
  const next = start + limit < items.length ? `c${start + limit}` : undefined;
  return { items: slice, ...(next ? { nextCursor: next } : {}) };
}

let uuidCounter = 0;
function fakeUuid(): string {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
}

export interface FixtureOptions {
  /** Start with a finished setup (repositories, a destination and activity). */
  seeded?: boolean;
  /** Artificial delay per call, to see loading states. */
  latencyMs?: number;
  now?: () => number;
}

export interface FixtureApi extends DashboardApi {
  /** Calls made, by method name, with their arguments (test inspection). */
  readonly calls: Array<{ method: keyof DashboardApi; args: unknown[] }>;
}

export function createFixtureApi(options: FixtureOptions = {}): FixtureApi {
  const now = options.now ?? Date.now;
  const iso = (offsetMs = 0) => new Date(now() + offsetMs).toISOString();
  const workspaceId = FIXTURE_WORKSPACE_ID;
  let hasProfile = options.seeded ?? false;
  const installations: InstallationDto[] = [];
  const repos: RepoDto[] = [];
  const destinations: DestinationDto[] = [];
  const deliveries: DeliveryDto[] = [];
  const calls: FixtureApi["calls"] = [];

  const listingRepos = [
    { repoId: "501", fullName: "octo-dev/api", admin: true },
    { repoId: "502", fullName: "octo-dev/web", admin: true },
    { repoId: "503", fullName: "octo-dev/docs", admin: false },
  ];

  function listing(installationId: string): RepoListingDto {
    return { listingId: fakeUuid(), installationId, expiresAt: iso(15 * 60_000), repos: listingRepos };
  }

  if (options.seeded) {
    installations.push({
      installationId: "1001",
      accountLogin: "octo-dev",
      accountType: "User",
      status: "active",
      claimedAt: iso(-86_400_000),
    });
    const dest: DestinationDto = {
      destinationId: fakeUuid(),
      provider: "discord",
      displayName: "core-commits",
      status: "active",
      webhookUrlMasked: "discord.com/api/webhooks/1234567890/••••",
      createdAt: iso(-86_000_000),
      updatedAt: iso(-86_000_000),
    };
    destinations.push(dest);
    repos.push(
      {
        repoId: "501",
        fullName: "octo-dev/api",
        installationId: "1001",
        watchedBranch: "main",
        isActive: true,
        destinationId: dest.destinationId,
        createdAt: iso(-85_000_000),
        updatedAt: iso(-85_000_000),
      },
      {
        repoId: "502",
        fullName: "octo-dev/web",
        installationId: "1001",
        watchedBranch: "release",
        isActive: false,
        createdAt: iso(-84_000_000),
        updatedAt: iso(-84_000_000),
      },
    );
    for (let i = 0; i < 30; i++) {
      const push = i % 3 !== 1;
      deliveries.push({
        deliveryId: `d0000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        status: i % 7 === 3 ? "failed" : "processed",
        receivedAt: iso(-i * 3_600_000),
        processedAt: iso(-i * 3_600_000 + 900),
        summary: push
          ? { repoFullName: "octo-dev/api", eventType: "push", branch: "main", commitCount: (i % 4) + 1, headShortSha: `a1b2c${String(i).padStart(2, "0")}` }
          : { repoFullName: "octo-dev/api", eventType: "pull_request", action: "opened", prNumber: 40 + i },
        ...(i % 7 === 3 ? { errorMessage: "Commit enrichment timed out" } : {}),
      });
    }
  }

  const ensureWorkspace = (ws: string) => {
    if (!hasProfile || ws !== workspaceId) refuse("not_found", 404);
  };
  const activeRepoCount = () => repos.filter((r) => r.isActive).length;
  const activeDestinationCount = () => destinations.filter((d) => d.status === "active").length;
  const findDestination = (id: string) => destinations.find((d) => d.destinationId === id) ?? refuse("not_found", 404);

  async function respond<T>(method: keyof DashboardApi, args: unknown[], fn: () => T): Promise<T> {
    calls.push({ method, args });
    if (options.latencyMs) await new Promise((r) => setTimeout(r, options.latencyMs));
    // Return copies so callers cannot mutate the store.
    return structuredClone(fn());
  }

  const api: FixtureApi = {
    calls,
    getMe: () =>
      respond("getMe", [], (): MeDto =>
        hasProfile
          ? { profile: { status: "active", createdAt: iso(-90_000_000) }, workspaces: [{ workspaceId, role: "owner" }] }
          : { workspaces: [] },
      ),
    bootstrap: () =>
      respond("bootstrap", [], () => {
        const created = !hasProfile;
        hasProfile = true;
        return { created, workspaceId };
      }),
    installUrl: (ws) =>
      respond("installUrl", [ws], () => {
        ensureWorkspace(ws);
        const id = String(1001 + installations.length);
        return {
          url: `/github/setup?code=fixturecode&installation_id=${id}&setup_action=install&state=${FIXTURE_STATE}`,
          expiresAt: iso(600_000),
        };
      }),
    authorizeUrl: (ws) =>
      respond("authorizeUrl", [ws], () => {
        ensureWorkspace(ws);
        return { url: `/github/setup?code=fixturecode&state=${FIXTURE_STATE}`, expiresAt: iso(600_000) };
      }),
    claimInstallation: (ws, body) =>
      respond("claimInstallation", [ws, body], () => {
        ensureWorkspace(ws);
        const b = parse(claimInstallationBodySchema, body);
        if (b.state !== FIXTURE_STATE) refuse("state_invalid", 400);
        const existing = installations.find((i) => i.installationId === b.installationId);
        if (!existing && installations.length >= WORKSPACE_LIMITS.installations) refuse("installation_limit_reached", 409);
        const installation: InstallationDto = existing ?? {
          installationId: b.installationId,
          accountLogin: "octo-dev",
          accountType: "User",
          status: "active",
          claimedAt: iso(),
        };
        if (!existing) installations.push(installation);
        return { created: !existing, installation, listing: listing(b.installationId) };
      }),
    repoListing: (ws, body) =>
      respond("repoListing", [ws, body], () => {
        ensureWorkspace(ws);
        const b = parse(repoListingBodySchema, body);
        if (b.state !== FIXTURE_STATE) refuse("state_invalid", 400);
        if (!installations.some((i) => i.installationId === b.installationId)) refuse("listing_invalid", 400);
        return listing(b.installationId);
      }),
    listInstallations: (ws, page) =>
      respond("listInstallations", [ws, page], () => {
        ensureWorkspace(ws);
        return paginate(installations, page);
      }),
    listRepos: (ws, page) =>
      respond("listRepos", [ws, page], () => {
        ensureWorkspace(ws);
        return paginate(repos, page);
      }),
    registerRepo: (ws, body) =>
      respond("registerRepo", [ws, body], () => {
        ensureWorkspace(ws);
        const b = parse(registerRepoBodySchema, body);
        const listed = listingRepos.find((r) => r.repoId === b.repoId);
        if (!listed || !listed.admin) refuse("repo_not_verified", 403);
        const existing = repos.find((r) => r.repoId === b.repoId);
        if (existing?.isActive) return existing;
        if (activeRepoCount() >= WORKSPACE_LIMITS.activeRepos) refuse("repo_limit_reached", 409);
        if (b.destinationId && findDestination(b.destinationId).status !== "active") refuse("destination_not_active", 409);
        const repo: RepoDto = {
          repoId: b.repoId,
          fullName: listed.fullName,
          installationId: installations[0]?.installationId ?? "1001",
          watchedBranch: b.watchedBranch ?? "main",
          isActive: true,
          ...(b.destinationId ? { destinationId: b.destinationId } : {}),
          createdAt: iso(),
          updatedAt: iso(),
        };
        if (existing) Object.assign(existing, repo);
        else repos.push(repo);
        return repo;
      }),
    updateRepo: (ws, repoId, body) =>
      respond("updateRepo", [ws, repoId, body], () => {
        ensureWorkspace(ws);
        const b = parse(updateRepoBodySchema, body);
        const repo = repos.find((r) => r.repoId === repoId) ?? refuse("not_found", 404);
        if (b.isActive === true && !repo.isActive && activeRepoCount() >= WORKSPACE_LIMITS.activeRepos) {
          refuse("repo_limit_reached", 409);
        }
        if (typeof b.destinationId === "string" && findDestination(b.destinationId).status !== "active") {
          refuse("destination_not_active", 409);
        }
        if (b.isActive !== undefined) repo.isActive = b.isActive;
        if (b.watchedBranch !== undefined) repo.watchedBranch = b.watchedBranch;
        if (b.destinationId === null) delete repo.destinationId;
        else if (b.destinationId !== undefined) repo.destinationId = b.destinationId;
        repo.updatedAt = iso();
        return repo;
      }),
    listDestinations: (ws, page) =>
      respond("listDestinations", [ws, page], () => {
        ensureWorkspace(ws);
        return paginate(destinations, page);
      }),
    createDestination: (ws, body) =>
      respond("createDestination", [ws, "[webhook redacted]"], () => {
        ensureWorkspace(ws);
        const b = parse(createDestinationBodySchema, body);
        if (!looksLikeDiscordWebhook(b.webhookUrl)) refuse("invalid_webhook_url", 400);
        if (activeDestinationCount() >= WORKSPACE_LIMITS.activeDestinations) refuse("destination_limit_reached", 409);
        const webhookId = b.webhookUrl.split("/").at(-2) ?? "0";
        const dest: DestinationDto = {
          destinationId: fakeUuid(),
          provider: "discord",
          displayName: b.displayName,
          status: "active",
          webhookUrlMasked: `discord.com/api/webhooks/${webhookId}/••••`,
          createdAt: iso(),
          updatedAt: iso(),
        };
        destinations.push(dest);
        return dest;
      }),
    updateDestination: (ws, destinationId, body) =>
      respond("updateDestination", [ws, destinationId, body], () => {
        ensureWorkspace(ws);
        const b = parse(updateDestinationBodySchema, body);
        const dest = findDestination(destinationId);
        if (dest.status === "pending_secret") refuse("destination_not_active", 409);
        if (b.isActive === true && dest.status === "inactive" && activeDestinationCount() >= WORKSPACE_LIMITS.activeDestinations) {
          refuse("destination_limit_reached", 409);
        }
        if (b.displayName !== undefined) dest.displayName = b.displayName;
        if (b.isActive !== undefined) dest.status = b.isActive ? "active" : "inactive";
        dest.updatedAt = iso();
        return dest;
      }),
    replaceWebhook: (ws, destinationId, body) =>
      respond("replaceWebhook", [ws, destinationId, "[webhook redacted]"], () => {
        ensureWorkspace(ws);
        const b = parse(replaceWebhookBodySchema, body);
        const dest = findDestination(destinationId);
        if (dest.status !== "active") refuse("destination_not_active", 409);
        if (!looksLikeDiscordWebhook(b.webhookUrl)) refuse("invalid_webhook_url", 400);
        dest.webhookUrlMasked = `discord.com/api/webhooks/${b.webhookUrl.split("/").at(-2) ?? "0"}/••••`;
        dest.updatedAt = iso();
        return dest;
      }),
    listDeliveries: (ws, page) =>
      respond("listDeliveries", [ws, page], () => {
        ensureWorkspace(ws);
        return paginate(deliveries, page);
      }),
  };
  return api;
}
