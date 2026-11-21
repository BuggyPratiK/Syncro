import type {
  BootstrapResponseDto,
  ClaimInstallationBody,
  ClaimInstallationResponseDto,
  CreateDestinationBody,
  DeliveryDto,
  DestinationDto,
  GitHubRedirectUrlDto,
  InstallationDto,
  MeDto,
  Page,
  RegisterRepoBody,
  ReplaceWebhookBody,
  RepoDto,
  RepoListingBody,
  RepoListingDto,
  RouteId,
  UpdateDestinationBody,
  UpdateRepoBody,
} from "@contracts";

export interface PageParams {
  cursor?: string;
  limit?: number;
}

/** One method per dashboard route; the HTTP client and the fixture both implement it. */
export interface DashboardApi {
  getMe(): Promise<MeDto>;
  bootstrap(): Promise<BootstrapResponseDto>;
  installUrl(workspaceId: string): Promise<GitHubRedirectUrlDto>;
  authorizeUrl(workspaceId: string): Promise<GitHubRedirectUrlDto>;
  claimInstallation(workspaceId: string, body: ClaimInstallationBody): Promise<ClaimInstallationResponseDto>;
  repoListing(workspaceId: string, body: RepoListingBody): Promise<RepoListingDto>;
  listInstallations(workspaceId: string, page?: PageParams): Promise<Page<InstallationDto>>;
  listRepos(workspaceId: string, page?: PageParams): Promise<Page<RepoDto>>;
  registerRepo(workspaceId: string, body: RegisterRepoBody): Promise<RepoDto>;
  updateRepo(workspaceId: string, repoId: string, body: UpdateRepoBody): Promise<RepoDto>;
  listDestinations(workspaceId: string, page?: PageParams): Promise<Page<DestinationDto>>;
  createDestination(workspaceId: string, body: CreateDestinationBody): Promise<DestinationDto>;
  updateDestination(
    workspaceId: string,
    destinationId: string,
    body: UpdateDestinationBody,
  ): Promise<DestinationDto>;
  replaceWebhook(workspaceId: string, destinationId: string, body: ReplaceWebhookBody): Promise<DestinationDto>;
  listDeliveries(workspaceId: string, page?: PageParams): Promise<Page<DeliveryDto>>;
}

/** Which client method serves each contract route (checked for completeness by tests). */
export const ROUTE_METHODS: Readonly<Record<RouteId, keyof DashboardApi>> = {
  "me.get": "getMe",
  "me.bootstrap": "bootstrap",
  "github.installUrl": "installUrl",
  "github.claim": "claimInstallation",
  "github.authorizeUrl": "authorizeUrl",
  "github.repoListing": "repoListing",
  "installations.list": "listInstallations",
  "repos.list": "listRepos",
  "repos.register": "registerRepo",
  "repos.update": "updateRepo",
  "destinations.list": "listDestinations",
  "destinations.create": "createDestination",
  "destinations.update": "updateDestination",
  "destinations.replaceWebhook": "replaceWebhook",
  "deliveries.list": "listDeliveries",
};
