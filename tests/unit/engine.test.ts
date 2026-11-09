const mockSend = jest.fn();

jest.mock("../../src/db/operations/notification.ops");
jest.mock("../../src/notifications/providers/discord.provider", () => {
  return {
    DiscordProvider: jest.fn().mockImplementation(() => ({
      channel: "discord",
      send: mockSend,
    })),
  };
});

import { dispatchPushNotification, dispatchPullRequestNotification } from "../../src/notifications/engine";
import { PushEventSummary, GitHubPullRequestPayload } from "../../src/types/github.types";
import { RepoConfigItem } from "../../src/types/dynamodb.types";
import * as notifOps from "../../src/db/operations/notification.ops";

describe("notification engine", () => {
  const mockSummary: PushEventSummary = {
    repoId: "123",
    repoFullName: "acme/syncro",
    repoUrl: "https://github.com/acme/syncro",
    branch: "main",
    pusherName: "pratik",
    commits: [
      {
        id: "a81f23c9b42e1f6c3d8290456ae182736f45b2c1",
        tree_id: "tree1",
        distinct: true,
        message: "feat: notification test",
        timestamp: "2026-10-15T00:00:00Z",
        url: "https://github.com/acme/syncro/commit/a81f23c",
        author: { name: "Pratik", email: "p@example.com" },
        committer: { name: "Pratik", email: "p@example.com" },
        added: [],
        removed: [],
        modified: [],
        additions: 5,
        deletions: 1,
        changedFiles: 1,
        allChangedFiles: ["file.ts"],
      },
    ],
    totalAdditions: 5,
    totalDeletions: 1,
    totalFilesChanged: 1,
    compareUrl: "https://github.com/acme/syncro/compare/a...b",
    deliveryId: "deliv-123",
  };

  const mockRepoConfig: RepoConfigItem = {
    PK: "REPO#123",
    SK: "CONFIG",
    github_repo_id: "123",
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
    mockSend.mockReset();
    jest.spyOn(notifOps, "createNotificationRecord").mockResolvedValue("2026-10-15T00:00:00.000Z");
    jest.spyOn(notifOps, "markNotificationSent").mockResolvedValue(undefined);
    jest.spyOn(notifOps, "markNotificationFailed").mockResolvedValue(undefined);
  });

  it("skips dispatch when no notification providers are configured in repoConfig", async () => {
    const emptyConfig = { ...mockRepoConfig, discord_webhook_url: "" };

    await dispatchPushNotification(mockSummary, emptyConfig);

    expect(notifOps.createNotificationRecord).not.toHaveBeenCalled();
  });

  it("dispatches notification and marks it sent on success", async () => {
    mockSend.mockResolvedValueOnce({
      success: true,
      channel: "discord",
      messageId: "msg-123",
    });

    await dispatchPushNotification(mockSummary, mockRepoConfig);

    expect(notifOps.createNotificationRecord).toHaveBeenCalledWith(
      "123",
      "deliv-123",
      "discord",
      expect.anything(),
    );
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: "push" }),
      mockRepoConfig.discord_webhook_url,
    );
    expect(notifOps.markNotificationSent).toHaveBeenCalledWith("123", "2026-10-15T00:00:00.000Z", "msg-123");
  });

  it("marks notification failed when provider send returns success: false", async () => {
    mockSend.mockResolvedValueOnce({
      success: false,
      channel: "discord",
      error: "Discord rate limit exceeded",
    });

    await dispatchPushNotification(mockSummary, mockRepoConfig);

    expect(notifOps.createNotificationRecord).toHaveBeenCalledWith(
      "123",
      "deliv-123",
      "discord",
      expect.anything(),
    );
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: "push" }),
      mockRepoConfig.discord_webhook_url,
    );
    expect(notifOps.markNotificationFailed).toHaveBeenCalledWith(
      "123",
      "2026-10-15T00:00:00.000Z",
      "Discord rate limit exceeded",
      undefined,
    );
  });

  it("safely handles unexpected exceptions from provider without throwing", async () => {
    mockSend.mockRejectedValueOnce(new Error("Fatal network crash"));

    await expect(dispatchPushNotification(mockSummary, mockRepoConfig)).resolves.not.toThrow();

    expect(notifOps.markNotificationFailed).toHaveBeenCalledWith(
      "123",
      "2026-10-15T00:00:00.000Z",
      "Fatal network crash",
    );
  });

  describe("dispatchPullRequestNotification", () => {
    const mockPrPayload: GitHubPullRequestPayload = {
      action: "opened",
      number: 88,
      pull_request: {
        id: 888,
        number: 88,
        state: "open",
        title: "feat: pull request support",
        body: "Detailed description",
        html_url: "https://github.com/acme/syncro/pull/88",
        diff_url: "https://github.com/acme/syncro/pull/88.diff",
        created_at: "2026-10-15T00:00:00Z",
        updated_at: "2026-10-15T00:00:00Z",
        closed_at: null,
        merged_at: null,
        merge_commit_sha: null,
        merged: false,
        user: { login: "pratik", id: 1 },
        head: { label: "feat/pr", ref: "feat/pr", sha: "abc", repo: null },
        base: { label: "main", ref: "main", sha: "def", repo: {} as any },
        additions: 30,
        deletions: 5,
        changed_files: 2,
        commits: 1,
      },
      repository: {
        id: 123,
        node_id: "r123",
        name: "syncro",
        full_name: "acme/syncro",
        private: false,
        html_url: "https://github.com/acme/syncro",
        default_branch: "main",
        owner: { login: "acme", id: 10 },
      },
      sender: { login: "pratik", id: 1 },
    };

    it("dispatches PR notification to configured providers", async () => {
      mockSend.mockResolvedValueOnce({
        success: true,
        channel: "discord",
        messageId: "pr-msg-123",
      });

      await dispatchPullRequestNotification(mockPrPayload, mockRepoConfig, "deliv-pr-123");

      expect(notifOps.createNotificationRecord).toHaveBeenCalledWith(
        "123",
        "deliv-pr-123",
        "discord",
        expect.anything(),
      );
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "pull_request",
          branch: "main",
          pullRequest: expect.objectContaining({
            number: 88,
            title: "feat: pull request support",
          }),
        }),
        mockRepoConfig.discord_webhook_url,
      );
      expect(notifOps.markNotificationSent).toHaveBeenCalledWith(
        "123",
        "2026-10-15T00:00:00.000Z",
        "pr-msg-123",
      );
    });

    it("skips dispatch when no providers are configured in repoConfig", async () => {
      const emptyConfig = { ...mockRepoConfig, discord_webhook_url: "" };

      await dispatchPullRequestNotification(mockPrPayload, emptyConfig, "deliv-pr-123");

      expect(notifOps.createNotificationRecord).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});