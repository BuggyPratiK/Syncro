import { handlePushEvent } from "../../src/webhooks/handlers/push.handler";
import * as resolver from "../../src/webhooks/resolve-target";
import * as enrichmentService from "../../src/services/enrichment.service";
import * as notificationEngine from "../../src/notifications/engine";
import * as commitOps from "../../src/db/operations/commit.ops";
import * as deliveryOps from "../../src/db/operations/delivery.ops";
import { GitHubPushPayload, PushEventSummary } from "../../src/types/github.types";
import type { TenantRepoConfigItem } from "../../src/types/tenant.types";

jest.mock("../../src/webhooks/resolve-target");
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
    summary: { repo_full_name: "acme/syncro", event_type: "push", branch: "main", commit_count: 1, head_short_sha: "a81f23c" },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(["repo_not_found", "repo_not_tenant", "repo_inactive", "workspace_not_active", "installation_mismatch"] as const)(
    "skips and marks ignored when the delivery does not resolve to an active workspace (%s)",
    async (reason) => {
      jest.spyOn(resolver, "resolveWebhookTarget").mockResolvedValueOnce({ ok: false, reason });

      await handlePushEvent(basePayload, "deliv-1", 100);

      expect(resolver.resolveWebhookTarget).toHaveBeenCalledWith("12345", 100);
      expect(deliveryOps.markDeliveryIgnored).toHaveBeenCalledWith("deliv-1", reason);
      expect(enrichmentService.enrichPushEvent).not.toHaveBeenCalled();
      expect(deliveryOps.markDeliveryProcessed).not.toHaveBeenCalled();
    },
  );

  it("skips and marks ignored if branch does not match watched branch", async () => {
    jest.spyOn(resolver, "resolveWebhookTarget").mockResolvedValueOnce({ ok: true, target });
    const featurePayload = { ...basePayload, ref: "refs/heads/feature/experiment" };

    await handlePushEvent(featurePayload, "deliv-2", 100);

    expect(deliveryOps.markDeliveryIgnored).toHaveBeenCalledWith("deliv-2", "branch_not_watched");
    expect(enrichmentService.enrichPushEvent).not.toHaveBeenCalled();
  });

  it("skips and marks ignored if branch was deleted or has 0 commits", async () => {
    jest.spyOn(resolver, "resolveWebhookTarget").mockResolvedValueOnce({ ok: true, target });
    const emptyPayload = { ...basePayload, commits: [] };

    await handlePushEvent(emptyPayload, "deliv-3", 100);

    expect(deliveryOps.markDeliveryIgnored).toHaveBeenCalledWith("deliv-3", "event_not_supported");
    expect(enrichmentService.enrichPushEvent).not.toHaveBeenCalled();
  });

  it("executes the full pipeline: enrich, persist, notify, mark processed with the workspace stamp", async () => {
    jest.spyOn(resolver, "resolveWebhookTarget").mockResolvedValueOnce({ ok: true, target });
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

    expect(enrichmentService.enrichPushEvent).toHaveBeenCalledWith(basePayload, 100, "deliv-4", undefined);
    expect(commitOps.saveCommit).toHaveBeenCalledTimes(1);
    expect(commitOps.saveCommit).toHaveBeenCalledWith("12345", "deliv-4", "main", mockSummary.commits[0], WS);
    expect(notificationEngine.dispatchPushNotification).toHaveBeenCalledWith(mockSummary, target, undefined);
    expect(deliveryOps.markDeliveryProcessed).toHaveBeenCalledWith("deliv-4", stamp);
  });

  it("marks delivery failed (stamped) and rethrows on failure", async () => {
    jest.spyOn(resolver, "resolveWebhookTarget").mockResolvedValueOnce({ ok: true, target });
    jest.spyOn(enrichmentService, "enrichPushEvent").mockRejectedValueOnce(new Error("GitHub API Error"));

    await expect(handlePushEvent(basePayload, "deliv-5", 100)).rejects.toThrow("GitHub API Error");
    expect(deliveryOps.markDeliveryFailed).toHaveBeenCalledWith("deliv-5", "GitHub API Error", stamp);
  });
});
