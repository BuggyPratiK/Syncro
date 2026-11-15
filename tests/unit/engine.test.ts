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

import {
  dispatchPushNotification,
  dispatchPullRequestNotification,
  setDestinationSecretReaderForTests,
} from "../../src/notifications/engine";
import { PushEventSummary, GitHubPullRequestPayload } from "../../src/types/github.types";
import type { TenantDestinationItem, TenantRepoConfigItem } from "../../src/types/tenant.types";
import * as notifOps from "../../src/db/operations/notification.ops";
import { DestinationSecretError } from "../../src/secrets/destination-secrets";
import { deriveDestinationParamName } from "../../src/secrets/param-names";
import type { WebhookTarget } from "../../src/webhooks/resolve-target";

describe("notification engine", () => {
  const WS = "ws_11111111-1111-4111-8111-111111111111";
  const DEST = "8c0e6f1a-2b3c-4d5e-8f90-a1b2c3d4e5f6";
  const PARAM = deriveDestinationParamName(WS, DEST, "/syncro/prod");
  const URL_VALUE = "https://discord.com/api/webhooks/12345/dest-token";

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

  const repo: TenantRepoConfigItem = {
    PK: "REPO#123",
    SK: "CONFIG",
    github_repo_id: "123",
    github_full_name: "acme/syncro",
    github_url: "https://github.com/acme/syncro",
    workspace_id: WS,
    installation_id: "99",
    discord_destination_id: DEST,
    watched_branch: "main",
    is_active: true,
    ownership_verified_at: "2026-10-15T00:00:00Z",
    GSI1PK: `WS#${WS}#REPO`,
    created_at: "2026-10-15T00:00:00Z",
    updated_at: "2026-10-15T00:00:00Z",
  };

  const destination: TenantDestinationItem = {
    PK: `WS#${WS}`,
    SK: `DEST#${DEST}`,
    destination_id: DEST,
    workspace_id: WS,
    provider: "discord",
    display_name: "Alerts Channel",
    status: "active",
    secret_ref: { name: PARAM, version: 3 },
    webhook_id: "12345",
    created_at: "2026-10-15T00:00:00Z",
    updated_at: "2026-10-15T00:00:00Z",
  };

  const target: WebhookTarget = { repo, destination };
  const read = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockReset();
    read.mockReset().mockResolvedValue(URL_VALUE);
    setDestinationSecretReaderForTests({ read });
    jest.spyOn(notifOps, "createNotificationRecord").mockResolvedValue({
      notificationId: "2026-10-15T00:00:00.000Z",
      alreadySent: false,
    });
    jest.spyOn(notifOps, "markNotificationSent").mockResolvedValue(undefined);
    jest.spyOn(notifOps, "markNotificationFailed").mockResolvedValue(undefined);
  });

  afterAll(() => setDestinationSecretReaderForTests(undefined));

  it("sends to the repository's own destination, reading the URL under the derived name", async () => {
    mockSend.mockResolvedValueOnce({ success: true, channel: "discord", messageId: "msg-123" });

    await dispatchPushNotification(mockSummary, target);

    expect(notifOps.createNotificationRecord).toHaveBeenCalledWith("123", "deliv-123", "discord", DEST, WS);
    expect(read).toHaveBeenCalledWith({ name: PARAM, version: 3 }, PARAM);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ type: "push" }), URL_VALUE, { deadline: undefined });
    expect(notifOps.markNotificationSent).toHaveBeenCalled();
  });

  it.each([
    ["the destination is missing", { repo }],
    ["the destination is inactive", { repo, destination: { ...destination, status: "inactive" as const } }],
    ["the destination is still pending its secret", { repo, destination: { ...destination, status: "pending_secret" as const, secret_ref: undefined } }],
  ])("skips dispatch when %s (zero targets)", async (_label, t) => {
    await dispatchPushNotification(mockSummary, t as WebhookTarget);

    expect(notifOps.createNotificationRecord).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("never falls back to a webhook URL stored on the repository record", async () => {
    // Behaviour change (kept from the earlier fallback test): a repo without a
    // destination gets zero targets, even if it still carries a legacy URL attribute.
    const legacy = { ...repo, discord_destination_id: undefined, discord_webhook_url: "https://discord.com/api/webhooks/999/legacy-token" };

    await dispatchPushNotification(mockSummary, { repo: legacy } as unknown as WebhookTarget);

    expect(notifOps.createNotificationRecord).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each(["secret_unavailable", "secret_store_busy"] as const)(
    "records the notification as failed with %s and sends nothing when the URL cannot be read",
    async (code) => {
      read.mockRejectedValueOnce(new DestinationSecretError(code));

      await dispatchPushNotification(mockSummary, target);

      expect(notifOps.markNotificationFailed).toHaveBeenCalledWith("123", "2026-10-15T00:00:00.000Z", code);
      expect(mockSend).not.toHaveBeenCalled();
    },
  );

  it("marks notification failed when provider send returns success: false", async () => {
    mockSend.mockResolvedValueOnce({ success: false, channel: "discord", error: "Discord rate limit exceeded" });

    await dispatchPushNotification(mockSummary, target);

    expect(notifOps.createNotificationRecord).toHaveBeenCalledWith("123", "deliv-123", "discord", DEST, WS);
    expect(notifOps.markNotificationFailed).toHaveBeenCalledWith(
      "123",
      "2026-10-15T00:00:00.000Z",
      "Discord rate limit exceeded",
      undefined,
    );
  });

  it("safely handles unexpected exceptions from provider without throwing", async () => {
    mockSend.mockRejectedValueOnce(new Error("Fatal network crash"));

    await expect(dispatchPushNotification(mockSummary, target)).resolves.not.toThrow();

    expect(notifOps.markNotificationFailed).toHaveBeenCalledWith("123", "2026-10-15T00:00:00.000Z", "Fatal network crash");
  });

  it("does not re-send a notification already delivered by an earlier attempt", async () => {
    jest.spyOn(notifOps, "createNotificationRecord").mockResolvedValueOnce({
      notificationId: "2026-10-15T00:00:00.000Z",
      alreadySent: true,
    });

    await dispatchPushNotification(mockSummary, target);

    expect(notifOps.createNotificationRecord).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(notifOps.markNotificationSent).not.toHaveBeenCalled();
    expect(notifOps.markNotificationFailed).not.toHaveBeenCalled();
  });

  it("passes the invocation deadline to the provider", async () => {
    mockSend.mockResolvedValueOnce({ success: true, channel: "discord" });
    const deadline = { remainingMs: () => 9_000 };

    await dispatchPushNotification(mockSummary, target, deadline);

    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ type: "push" }), URL_VALUE, { deadline });
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

    it("dispatches PR notification to the repository's destination", async () => {
      mockSend.mockResolvedValueOnce({ success: true, channel: "discord", messageId: "pr-msg-123" });

      await dispatchPullRequestNotification(mockPrPayload, target, "deliv-pr-123");

      expect(notifOps.createNotificationRecord).toHaveBeenCalledWith("123", "deliv-pr-123", "discord", DEST, WS);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "pull_request",
          pullRequest: expect.objectContaining({ number: 88 }),
        }),
        URL_VALUE,
        { deadline: undefined },
      );
      expect(notifOps.markNotificationSent).toHaveBeenCalled();
    });
  });
});
