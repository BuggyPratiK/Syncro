import { handlePullRequestEvent } from "../../src/webhooks/handlers/pull-request.handler";
import * as resolver from "../../src/webhooks/resolve-target";
import * as notificationEngine from "../../src/notifications/engine";
import * as deliveryOps from "../../src/db/operations/delivery.ops";
import { GitHubPullRequestPayload } from "../../src/types/github.types";
import type { TenantRepoConfigItem } from "../../src/types/tenant.types";

jest.mock("../../src/webhooks/resolve-target");
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

  const WS = "ws_11111111-1111-4111-8111-111111111111";
  const mockRepo: TenantRepoConfigItem = {
    PK: "REPO#12345",
    SK: "CONFIG",
    github_repo_id: "12345",
    github_full_name: "acme/syncro",
    github_url: "https://github.com/acme/syncro",
    workspace_id: WS,
    installation_id: "100",
    watched_branch: "main",
    is_active: true,
    ownership_verified_at: "2026-10-15T00:00:00Z",
    GSI1PK: `WS#${WS}#REPO`,
    created_at: "2026-10-15T00:00:00Z",
    updated_at: "2026-10-15T00:00:00Z",
  };
  const target = { repo: mockRepo };
  const stamp = {
    workspaceId: WS,
    summary: { repo_full_name: "acme/syncro", event_type: "pull_request", branch: "main", action: "opened", pr_number: 42 },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(["repo_not_found", "repo_not_tenant", "repo_inactive", "workspace_not_active", "installation_not_active"] as const)(
    "ignores the PR event when it does not resolve to an active workspace (%s)",
    async (reason) => {
      jest.spyOn(resolver, "resolveWebhookTarget").mockResolvedValue({ ok: false, reason });

      await handlePullRequestEvent(basePrPayload, "deliv-pr-1", 100);

      expect(resolver.resolveWebhookTarget).toHaveBeenCalledWith("12345", 100);
      expect(deliveryOps.markDeliveryIgnored).toHaveBeenCalledWith("deliv-pr-1", reason);
      expect(notificationEngine.dispatchPullRequestNotification).not.toHaveBeenCalled();
    },
  );

  it("ignores PR event when target base branch does not match watched branch", async () => {
    jest.spyOn(resolver, "resolveWebhookTarget").mockResolvedValue({ ok: true, target });

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

    await handlePullRequestEvent(devBranchPayload, "deliv-pr-2", 100);

    expect(deliveryOps.markDeliveryIgnored).toHaveBeenCalledWith("deliv-pr-2", "branch_not_watched");
    expect(notificationEngine.dispatchPullRequestNotification).not.toHaveBeenCalled();
  });

  it("ignores noisy/unhandled PR actions (e.g. labeled, assigned)", async () => {
    jest.spyOn(resolver, "resolveWebhookTarget").mockResolvedValue({ ok: true, target });

    const labeledPayload: GitHubPullRequestPayload = {
      ...basePrPayload,
      action: "labeled",
    };

    await handlePullRequestEvent(labeledPayload, "deliv-pr-3", 100);

    expect(deliveryOps.markDeliveryIgnored).toHaveBeenCalledWith("deliv-pr-3", "event_not_supported");
    expect(notificationEngine.dispatchPullRequestNotification).not.toHaveBeenCalled();
  });

  it("successfully dispatches notification for opened PR and marks delivery processed with the workspace stamp", async () => {
    jest.spyOn(resolver, "resolveWebhookTarget").mockResolvedValue({ ok: true, target });
    jest.spyOn(notificationEngine, "dispatchPullRequestNotification").mockResolvedValue();
    jest.spyOn(deliveryOps, "markDeliveryProcessed").mockResolvedValue();

    await handlePullRequestEvent(basePrPayload, "deliv-pr-4", 100);

    expect(notificationEngine.dispatchPullRequestNotification).toHaveBeenCalledWith(
      basePrPayload,
      target,
      "deliv-pr-4",
      undefined,
    );
    expect(deliveryOps.markDeliveryProcessed).toHaveBeenCalledWith("deliv-pr-4", stamp);
  });

  it("marks delivery failed (stamped) and rethrows when dispatching fails", async () => {
    jest.spyOn(resolver, "resolveWebhookTarget").mockResolvedValue({ ok: true, target });
    jest
      .spyOn(notificationEngine, "dispatchPullRequestNotification")
      .mockRejectedValue(new Error("Discord dispatch timeout"));
    jest.spyOn(deliveryOps, "markDeliveryFailed").mockResolvedValue();

    await expect(handlePullRequestEvent(basePrPayload, "deliv-pr-5", 100)).rejects.toThrow(
      "Discord dispatch timeout",
    );

    expect(deliveryOps.markDeliveryFailed).toHaveBeenCalledWith("deliv-pr-5", "Discord dispatch timeout", stamp);
  });
});
