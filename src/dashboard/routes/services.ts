/**
 * The operations the route handlers call. Production wires the existing data
 * operations, the destination secret writer and the GitHub verification
 * library; tests pass fakes. Handlers contain no business rules of their own:
 * ownership, limits and state checks live in these operations.
 */

import type {
  DestinationOps,
  DestinationSecretWriter,
  GitHubStateOps,
  GitHubTransport,
  GitHubVerificationLibrary,
  HistoryOps,
  InstallationOps,
  RepoOps,
  TenancyOps,
} from "../../contracts/data-ops";
import type { RouteId } from "../../contracts/routes";
import type { DashboardEnv } from "../../config/env";
import { bootstrapUser, getMe } from "../../db/operations/tenancy.ops";
import { consumeGitHubState, createGitHubState } from "../../db/operations/github-state.ops";
import { claimInstallation, getInstallation, listInstallations } from "../../db/operations/installation.ops";
import { getVerifiedListing, saveVerifiedListing } from "../../db/operations/listing.ops";
import { getRepo, listRepos, registerRepo, updateRepo } from "../../db/operations/tenant-repository.ops";
import {
  createDestination,
  getDestination,
  listDestinations,
  replaceDestinationWebhook,
  updateDestination,
} from "../../db/operations/tenant-destination.ops";
import { listDeliveries } from "../../db/operations/history.ops";
import { createDestinationSecretWriter } from "../../secrets/destination-secrets";
import { createGitHubVerification } from "../../github/verification";
import { createFetchGitHubTransport } from "../../github/transport";
import { getGitHubOAuthClientSecret } from "../secrets";

/** Identifies the request a GitHub call belongs to, for the audit log. */
export interface GitHubCallScope {
  requestId: string;
  route: RouteId;
  workspaceId: string;
}

export interface RouteServices {
  tenancy: Pick<TenancyOps, "bootstrapUser" | "getMe">;
  githubState: GitHubStateOps;
  installations: InstallationOps;
  repos: RepoOps;
  destinations: DestinationOps;
  history: HistoryOps;
  /** The write-only SSM writer for destination URLs. */
  destinationWriter(): DestinationSecretWriter;
  /** The verification library, configured with the OAuth client secret (loaded from SSM, fail closed). */
  github(): Promise<GitHubVerificationLibrary>;
  /** HTTP transport for GitHub user-token calls. */
  githubTransport(): GitHubTransport;
  githubApp: { slug: string; clientId: string };
}

export function productionServices(env: DashboardEnv): RouteServices {
  let writer: DestinationSecretWriter | undefined;
  return {
    tenancy: { bootstrapUser, getMe },
    githubState: { createGitHubState, consumeGitHubState },
    installations: { claimInstallation, getInstallation, listInstallations },
    repos: { saveVerifiedListing, getVerifiedListing, registerRepo, updateRepo, getRepo, listRepos },
    destinations: { createDestination, updateDestination, replaceDestinationWebhook, getDestination, listDestinations },
    history: { listDeliveries },
    destinationWriter: () => (writer ??= createDestinationSecretWriter()),
    github: async () =>
      createGitHubVerification({
        appId: env.GITHUB_APP_ID,
        clientId: env.GITHUB_APP_CLIENT_ID,
        clientSecret: await getGitHubOAuthClientSecret(),
      }),
    githubTransport: () => createFetchGitHubTransport(),
    githubApp: { slug: env.GITHUB_APP_SLUG, clientId: env.GITHUB_APP_CLIENT_ID },
  };
}
