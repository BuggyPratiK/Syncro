/**
 * Route handlers for the 15 dashboard routes.
 *
 * Each handler runs only after the shared pipeline has authenticated the
 * user, proved workspace membership and role, applied the rate limit and
 * validated the request, so handlers receive trusted, typed input:
 * - the actor is always the token's user, and the workspace always comes from
 *   the membership proof (`ctx`), never from the request body;
 * - every response is built with the explicit-field mappers, so no internal
 *   attribute, `secret_ref` or webhook URL can be returned;
 * - refusals are thrown by the operations as contract errors.
 *
 * GitHub onboarding keeps a fixed order: the OAuth client secret is loaded
 * first (so a configuration failure never burns the user's state), then the
 * single-use state is consumed, and only then is GitHub contacted.
 */

import { REQUEST_LIMITS } from "../../contracts/constants";
import type { PageRequest, WorkspaceContext } from "../../contracts/data-ops";
import type { Page } from "../../contracts/dto";
import { ContractError } from "../../contracts/errors";
import type { RouteId } from "../../contracts/routes";
import type {
  ClaimInstallationBody,
  CreateDestinationBody,
  ListQuery,
  RegisterRepoBody,
  ReplaceWebhookBody,
  RepoListingBody,
  UpdateDestinationBody,
  UpdateRepoBody,
} from "../../contracts/schemas";
import {
  toClaimInstallationResponseDto,
  toDestinationDto,
  toInstallationDto,
  toRepoDto,
  toRepoListingDto,
} from "../../services/tenant-dto";
import { logger } from "../../utils/logger";
import type { RouteHandler, RouteRequest, RouteResult } from "../pipeline";
import { auditedGitHubTransport } from "./github-audit";
import type { RouteServices } from "./services";

const ok = (body: unknown): RouteResult => ({ status: 200, body });

/** The membership proof set by the pipeline on every workspace route. */
function workspace(req: RouteRequest): WorkspaceContext {
  if (!req.ctx) throw new Error("Workspace route reached without a workspace context");
  return req.ctx;
}

function page(req: RouteRequest): PageRequest {
  const q = req.query as ListQuery;
  return { limit: q.limit ?? REQUEST_LIMITS.pageSizeDefault, ...(q.cursor ? { cursor: q.cursor } : {}) };
}

function mapPage<T, U>(p: Page<T>, map: (item: T) => U): Page<U> {
  return { items: p.items.map(map), ...(p.nextCursor ? { nextCursor: p.nextCursor } : {}) };
}

export function createRouteHandlers(s: RouteServices): Record<RouteId, RouteHandler> {
  /** GitHub library and an audited transport for this request; the secret is loaded before anything else. */
  async function githubFor(req: RouteRequest, ctx: WorkspaceContext) {
    const lib = await s.github();
    const transport = auditedGitHubTransport(s.githubTransport(), {
      requestId: req.requestId,
      route: req.routeId,
      workspaceId: ctx.workspaceId,
    });
    return { lib, transport };
  }

  async function consumeState(ctx: WorkspaceContext, state: string, purpose: "install" | "authorize") {
    const result = await s.githubState.consumeGitHubState(ctx, state, purpose);
    if (!result.ok) {
      logger.warn("GitHub state rejected", { workspaceId: ctx.workspaceId, purpose, reason: result.reason });
      throw new ContractError("state_invalid");
    }
  }

  async function redirectUrl(ctx: WorkspaceContext, purpose: "install" | "authorize"): Promise<RouteResult> {
    const { state, expiresAt } = await s.githubState.createGitHubState(ctx, purpose);
    const url =
      purpose === "install"
        ? new URL(`https://github.com/apps/${encodeURIComponent(s.githubApp.slug)}/installations/new`)
        : new URL("https://github.com/login/oauth/authorize");
    if (purpose === "authorize") url.searchParams.set("client_id", s.githubApp.clientId);
    url.searchParams.set("state", state);
    return ok({ url: url.toString(), expiresAt });
  }

  return {
    "me.get": async (req) => ok(await s.tenancy.getMe(req.user.userId)),

    "me.bootstrap": async (req) => {
      const result = await s.tenancy.bootstrapUser(req.user.userId, req.user.issuer);
      return ok({ created: result.created, workspaceId: result.workspaceId });
    },

    "github.installUrl": async (req) => redirectUrl(workspace(req), "install"),

    "github.authorizeUrl": async (req) => redirectUrl(workspace(req), "authorize"),

    "github.claim": async (req) => {
      const ctx = workspace(req);
      const body = req.body as ClaimInstallationBody;
      const { lib, transport } = await githubFor(req, ctx);
      await consumeState(ctx, body.state, "install");
      const token = await lib.exchangeInstallCode(transport, { code: body.code });
      const user = await lib.getAuthenticatedGitHubUser(transport, token);
      const verified = await lib.verifyUserInstallation(transport, token, { installationId: body.installationId });
      const claim = await s.installations.claimInstallation(ctx, verified);
      const listing = await lib.listUserInstallationRepositories(transport, token, {
        installationId: verified.installationId,
        githubUserId: user.githubUserId,
      });
      const snapshot = await s.repos.saveVerifiedListing(ctx, listing);
      return ok(toClaimInstallationResponseDto(claim, snapshot));
    },

    "github.repoListing": async (req) => {
      const ctx = workspace(req);
      const body = req.body as RepoListingBody;
      const { lib, transport } = await githubFor(req, ctx);
      await consumeState(ctx, body.state, "authorize");
      const token = await lib.exchangeInstallCode(transport, { code: body.code });
      const user = await lib.getAuthenticatedGitHubUser(transport, token);
      const listing = await lib.listUserInstallationRepositories(transport, token, {
        installationId: body.installationId,
        githubUserId: user.githubUserId,
      });
      const snapshot = await s.repos.saveVerifiedListing(ctx, listing);
      return ok(toRepoListingDto(snapshot));
    },

    "installations.list": async (req) =>
      ok(mapPage(await s.installations.listInstallations(workspace(req), page(req)), toInstallationDto)),

    "repos.list": async (req) => ok(mapPage(await s.repos.listRepos(workspace(req), page(req)), toRepoDto)),

    "repos.register": async (req) => {
      const body = req.body as RegisterRepoBody;
      return ok(toRepoDto(await s.repos.registerRepo(workspace(req), body)));
    },

    "repos.update": async (req) => {
      const body = req.body as UpdateRepoBody;
      return ok(toRepoDto(await s.repos.updateRepo(workspace(req), req.path.repoId, body)));
    },

    "destinations.list": async (req) =>
      ok(mapPage(await s.destinations.listDestinations(workspace(req), page(req)), toDestinationDto)),

    "destinations.create": async (req) => {
      const body = req.body as CreateDestinationBody;
      const record = await s.destinations.createDestination(
        workspace(req),
        { displayName: body.displayName, webhookUrl: body.webhookUrl },
        s.destinationWriter(),
      );
      return ok(toDestinationDto(record));
    },

    "destinations.update": async (req) => {
      const body = req.body as UpdateDestinationBody;
      return ok(toDestinationDto(await s.destinations.updateDestination(workspace(req), req.path.destinationId, body)));
    },

    "destinations.replaceWebhook": async (req) => {
      const body = req.body as ReplaceWebhookBody;
      const record = await s.destinations.replaceDestinationWebhook(
        workspace(req),
        req.path.destinationId,
        body.webhookUrl,
        s.destinationWriter(),
      );
      return ok(toDestinationDto(record));
    },

    "deliveries.list": async (req) => ok(await s.history.listDeliveries(workspace(req), page(req))),
  };
}
