import { handlePushEvent } from "../../src/webhooks/handlers/push.handler";
import * as repoService from "../../src/services/repository.service";
import * as enrichmentService from "../../src/services/enrichment.service";
import * as notificationEngine from "../../src/notifications/engine";
import * as commitOps from "../../src/db/operations/commit.ops";
import * as deliveryOps from "../../src/db/operations/delivery.ops";
import { GitHubPushPayload, PushEventSummary } from "../../src/types/github.types";
import { RepoConfigItem } from "../../src/types/dynamodb.types";

jest.mock("../../src/services/repository.service");
jest.mock("../../src/services/enrichment.service");
jest.mock("../../src/notifications/engine");
jest.mock("../../src/db/operations/commit.ops");
jest.mock("../../src/db/operations/delivery.ops");

describe("handlePushEvent", () => {
  const basePayload: GitHubPushPayload = {
    ref: "refs/heads/main",
    before: "0000000000000000000000000000000000000000",
    after: "a81f23c9b42e1f6c3d8290456ae182736f45b2c1",
    forced: false,
    created: false,
    deleted: false,
    head_commit: null,
    sender: { login: "pratik", id: 1 },
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
    pusher: {
      name: "pratik",
      email: "pratik@example.com",
    },
    commits: [
      {
        id: "a81f23c9b42e1f6c3d8290456ae182736f45b2c1",
        tree_id: "tree123",
        message: "feat: test push handler",
        timestamp: "2026-10-15T00:00:00Z",
        url: "https://github.com/acme/syncro/commit/a81f23c",
        author: { name: "Pratik", email: "pratik@example.com" },
        committer: { name: "Pratik", email: "pratik@example.com" },
        added: ["a.ts"],
        removed: [],
        modified: [],
        distinct: true,
      },
    ],
    compare: "https://github.com/acme/syncro/compare/a...b",
  };

  const mockRepoConfig: RepoConfigItem = {
    PK: "REPO#12345",
    SK: "CONFIG",
    github_repo_id: "12345",
    github_full_name: "acme/syncro",
    github_url: "https://github.com/acme/syncro",
    discord_webhook_url: "https://discord.com/api/webhooks/123",
    watched_branch: "main",
    is_active: true,
    GSI1PK: "TYPE#REPO",
    created_at: "2026-10-15T00:00:00Z",
    updated_at: "2026-10-15T00:00:00Z",
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("skips and marks ignored if repo is not registered or active", async () => {
    jest.spyOn(repoService, "findActiveRepo").mockResolvedValueOnce(null);

    await handlePushEvent(basePayload, "deliv-1", 100);

    expect(deliveryOps.markDeliveryIgnored).toHaveBeenCalledWith(
      "deliv-1",
      expect.stringContaining("Repo not registered"),
    );
    expect(enrichmentService.enrichPushEvent).not.toHaveBeenCalled();
  });

  it("skips and marks ignored if branch does not match watched branch", async () => {
    jest.spyOn(repoService, "findActiveRepo").mockResolvedValueOnce(mockRepoConfig);
    const featurePayload = { ...basePayload, ref: "refs/heads/feature/experiment" };

    await handlePushEvent(featurePayload, "deliv-2", 100);

    expect(deliveryOps.markDeliveryIgnored).toHaveBeenCalledWith(
      "deliv-2",
      expect.stringContaining("Branch feature/experiment not watched"),
    );
    expect(enrichmentService.enrichPushEvent).not.toHaveBeenCalled();
  });

  it("skips and marks ignored if branch was deleted or has 0 commits", async () => {
    jest.spyOn(repoService, "findActiveRepo").mockResolvedValueOnce(mockRepoConfig);
    const emptyPayload = { ...basePayload, commits: [] };

    await handlePushEvent(emptyPayload, "deliv-3", 100);

    expect(deliveryOps.markDeliveryIgnored).toHaveBeenCalledWith(
      "deliv-3",
      expect.stringContaining("Branch deleted or no commits"),
    );
    expect(enrichmentService.enrichPushEvent).not.toHaveBeenCalled();
  });

  it("executes the full pipeline: enrich, persist, notify, mark processed", async () => {
    jest.spyOn(repoService, "findActiveRepo").mockResolvedValueOnce(mockRepoConfig);
    const mockSummary: PushEventSummary = {
      repoId: "12345",
      repoFullName: "acme/syncro",
      repoUrl: "https://github.com/acme/syncro",
      branch: "main",
      pusherName: "pratik",
      commits: [
        {
          ...basePayload.commits[0],
          shortSha: "a81f23c",
          additions: 10,
          deletions: 2,
          changedFiles: 1,
          allChangedFiles: ["a.ts"],
        },
      ],
      totalAdditions: 10,
      totalDeletions: 2,
      totalFilesChanged: 1,
      compareUrl: "https://github.com/acme/syncro/compare/a...b",
      deliveryId: "deliv-4",
    };
    jest.spyOn(enrichmentService, "enrichPushEvent").mockResolvedValueOnce(mockSummary);

    await handlePushEvent(basePayload, "deliv-4", 100);

    expect(enrichmentService.enrichPushEvent).toHaveBeenCalledWith(basePayload, 100, "deliv-4");
    expect(commitOps.saveCommit).toHaveBeenCalledTimes(1);
    expect(notificationEngine.dispatchPushNotification).toHaveBeenCalledWith(mockSummary, mockRepoConfig);
    expect(deliveryOps.markDeliveryProcessed).toHaveBeenCalledWith("deliv-4");
  });

  it("marks delivery failed and rethrows on failure", async () => {
    jest.spyOn(repoService, "findActiveRepo").mockResolvedValueOnce(mockRepoConfig);
    jest.spyOn(enrichmentService, "enrichPushEvent").mockRejectedValueOnce(new Error("GitHub API Error"));

    await expect(handlePushEvent(basePayload, "deliv-5", 100)).rejects.toThrow("GitHub API Error");
    expect(deliveryOps.markDeliveryFailed).toHaveBeenCalledWith("deliv-5", "GitHub API Error");
  });
});