import { handlePullRequestEvent } from "../../src/webhooks/handlers/pull-request.handler";
import * as repoService from "../../src/services/repository.service";
import * as notificationEngine from "../../src/notifications/engine";
import * as deliveryOps from "../../src/db/operations/delivery.ops";
import { GitHubPullRequestPayload } from "../../src/types/github.types";
import { RepoConfigItem } from "../../src/types/dynamodb.types";

jest.mock("../../src/services/repository.service");
jest.mock("../../src/notifications/engine");
jest.mock("../../src/db/operations/delivery.ops");

describe("handlePullRequestEvent", () => {
  const basePrPayload: GitHubPullRequestPayload = {
    action: "opened",
    number: 42,
    pull_request: {
      id: 10042,
      number: 42,
      state: "open",
      title: "feat: add oauth2 support",
      body: "Comprehensive PR adding OAuth2 login.",
      html_url: "https://github.com/acme/syncro/pull/42",
      diff_url: "https://github.com/acme/syncro/pull/42.diff",
      created_at: "2026-11-08T10:00:00Z",
      updated_at: "2026-11-08T10:00:00Z",
      closed_at: null,
      merged_at: null,
      merge_commit_sha: null,
      merged: false,
      draft: false,
      user: {
        login: "pratik",
        id: 1,
      },
      head: {
        label: "acme:feature/oauth",
        ref: "feature/oauth",
        sha: "head-sha-123",
        repo: null,
      },
      base: {
        label: "acme:main",
        ref: "main",
        sha: "base-sha-456",
        repo: {
          id: 12345,
          node_id: "node123",
          name: "syncro",
          full_name: "acme/syncro",
          private: false,
          default_branch: "main",
          html_url: "https://github.com/acme/syncro",
          owner: { login: "acme", id: 10 },
        },
      },
      additions: 80,
      deletions: 10,
      changed_files: 2,
      commits: 1,
    },
    repository: {
      id: 12345,
      node_id: "node123",
      name: "syncro",
      full_name: "acme/syncro",
      private: false,
      default_branch: "main",
      html_url: "https://github.com/acme/syncro",
      owner: { login: "acme", id: 10 },
    },
    sender: {
      login: "pratik",
      id: 1,
    },
  };

  const mockRepoConfig: RepoConfigItem = {
    PK: "REPO#12345",
    SK: "CONFIG",
    github_repo_id: "12345",
    github_full_name: "acme/syncro",
    github_url: "https://github.com/acme/syncro",
    discord_webhook_url: "https://discord.com/api/webhooks/test",
    watched_branch: "main",
    is_active: true,
    GSI1PK: "TYPE#REPO",
    created_at: "2026-10-15T00:00:00Z",
    updated_at: "2026-10-15T00:00:00Z",
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("ignores PR event when repository is not active in DynamoDB", async () => {
    jest.spyOn(repoService, "findActiveRepo").mockResolvedValue(null);

    await handlePullRequestEvent(basePrPayload, "deliv-pr-1");

    expect(deliveryOps.markDeliveryIgnored).toHaveBeenCalledWith(
      "deliv-pr-1",
      expect.stringContaining("Repo not registered"),
    );
    expect(notificationEngine.dispatchPullRequestNotification).not.toHaveBeenCalled();
  });

  it("ignores PR event when target base branch does not match watched branch", async () => {
    jest.spyOn(repoService, "findActiveRepo").mockResolvedValue(mockRepoConfig);

    const devBranchPayload: GitHubPullRequestPayload = {
      ...basePrPayload,
      pull_request: {
        ...basePrPayload.pull_request,
        base: {
          ...basePrPayload.pull_request.base,
          ref: "develop",
        },
      },
    };

    await handlePullRequestEvent(devBranchPayload, "deliv-pr-2");

    expect(deliveryOps.markDeliveryIgnored).toHaveBeenCalledWith(
      "deliv-pr-2",
      expect.stringContaining("Target branch develop not watched"),
    );
    expect(notificationEngine.dispatchPullRequestNotification).not.toHaveBeenCalled();
  });

  it("ignores noisy/unhandled PR actions (e.g. labeled, assigned)", async () => {
    jest.spyOn(repoService, "findActiveRepo").mockResolvedValue(mockRepoConfig);

    const labeledPayload: GitHubPullRequestPayload = {
      ...basePrPayload,
      action: "labeled",
    };

    await handlePullRequestEvent(labeledPayload, "deliv-pr-3");

    expect(deliveryOps.markDeliveryIgnored).toHaveBeenCalledWith(
      "deliv-pr-3",
      expect.stringContaining("PR action labeled not relevant"),
    );
    expect(notificationEngine.dispatchPullRequestNotification).not.toHaveBeenCalled();
  });

  it("successfully dispatches notification for opened PR and marks delivery processed", async () => {
    jest.spyOn(repoService, "findActiveRepo").mockResolvedValue(mockRepoConfig);
    jest.spyOn(notificationEngine, "dispatchPullRequestNotification").mockResolvedValue();
    jest.spyOn(deliveryOps, "markDeliveryProcessed").mockResolvedValue();

    await handlePullRequestEvent(basePrPayload, "deliv-pr-4");

    expect(notificationEngine.dispatchPullRequestNotification).toHaveBeenCalledWith(
      basePrPayload,
      mockRepoConfig,
      "deliv-pr-4",
    );
    expect(deliveryOps.markDeliveryProcessed).toHaveBeenCalledWith("deliv-pr-4");
  });

  it("marks delivery failed and rethrows when dispatching fails", async () => {
    jest.spyOn(repoService, "findActiveRepo").mockResolvedValue(mockRepoConfig);
    jest
      .spyOn(notificationEngine, "dispatchPullRequestNotification")
      .mockRejectedValue(new Error("Discord dispatch timeout"));
    jest.spyOn(deliveryOps, "markDeliveryFailed").mockResolvedValue();

    await expect(handlePullRequestEvent(basePrPayload, "deliv-pr-5")).rejects.toThrow(
      "Discord dispatch timeout",
    );

    expect(deliveryOps.markDeliveryFailed).toHaveBeenCalledWith(
      "deliv-pr-5",
      "Discord dispatch timeout",
    );
  });
});

