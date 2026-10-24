import { enrichPushEvent } from "../../src/services/enrichment.service";
import * as githubService from "../../src/services/github.service";
import { GitHubPushPayload } from "../../src/types/github.types";

jest.mock("../../src/services/github.service");

describe("enrichPushEvent", () => {
  const mockPayload: GitHubPushPayload = {
    ref: "refs/heads/feature/bot",
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
        message: "feat: add enrichment test",
        timestamp: "2026-10-15T00:00:00Z",
        url: "https://github.com/acme/syncro/commit/a81f23c",
        author: { name: "Pratik", email: "pratik@example.com" },
        committer: { name: "Pratik", email: "pratik@example.com" },
        added: ["src/a.ts"],
        removed: [],
        modified: ["src/b.ts"],
        distinct: true,
      },
    ],
    compare: "https://github.com/acme/syncro/compare/a...b",
  };

  it("calculates totals and normalizes push event summary", async () => {
    jest.spyOn(githubService, "enrichCommits").mockResolvedValueOnce([
      {
        ...mockPayload.commits[0],
        additions: 25,
        deletions: 5,
        changedFiles: 2,
        allChangedFiles: ["src/a.ts", "src/b.ts"],
      },
    ]);

    const summary = await enrichPushEvent(mockPayload, 999, "deliv-100");

    expect(summary.repoId).toBe("12345");
    expect(summary.repoFullName).toBe("acme/syncro");
    expect(summary.branch).toBe("feature/bot");
    expect(summary.pusherName).toBe("pratik");
    expect(summary.totalAdditions).toBe(25);
    expect(summary.totalDeletions).toBe(5);
    expect(summary.totalFilesChanged).toBe(2);
    expect(summary.deliveryId).toBe("deliv-100");
    expect(summary.commits[0].shortSha).toBe("a81f23c");
  });
});