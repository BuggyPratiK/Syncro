/**
 * Commit enrichment: capped API usage, per-request timeouts sized from the
 * invocation deadline, and fallback to webhook data that never fails a delivery.
 */

import { App } from "@octokit/app";
import { enrichCommits } from "../../src/services/github.service";
import { setParameterReaderForTests } from "../../src/config/secrets";
import { RELAY } from "../../src/contracts";
import { GitHubCommit } from "../../src/types/github.types";

function commit(i: number): GitHubCommit {
  return {
    id: `${i}`.padStart(40, "a"),
    tree_id: "t",
    distinct: true,
    message: `commit ${i}`,
    timestamp: "2026-11-15T00:00:00Z",
    url: `https://github.com/acme/syncro/commit/${i}`,
    author: { name: "A", email: "a@example.com" },
    committer: { name: "A", email: "a@example.com" },
    added: [`added-${i}.ts`],
    removed: [],
    modified: [`mod-${i}.ts`],
  };
}

describe("enrichCommits", () => {
  let request: jest.Mock;

  beforeEach(() => {
    setParameterReaderForTests(async () => "dummy-secret-value");
    request = jest.fn().mockResolvedValue({
      data: { stats: { additions: 10, deletions: 2 }, files: [{ filename: "src/x.ts" }] },
    });
    jest
      .spyOn(App.prototype, "getInstallationOctokit")
      .mockResolvedValue({ request } as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    setParameterReaderForTests(undefined);
  });

  it(`calls the GitHub API for at most ${RELAY.enrichmentCap} commits and keeps every commit`, async () => {
    const commits = Array.from({ length: 8 }, (_, i) => commit(i));

    const out = await enrichCommits(1, "acme", "syncro", commits);

    expect(request).toHaveBeenCalledTimes(RELAY.enrichmentCap);
    expect(out).toHaveLength(8);
    expect(out.map((c) => c.id)).toEqual(commits.map((c) => c.id));
    expect(out.slice(0, 5).every((c) => c.statsFromApi === true && c.additions === 10)).toBe(true);
    expect(out.slice(5).every((c) => c.statsFromApi === false && c.additions === 0)).toBe(true);
    expect(out[7].allChangedFiles).toEqual(["added-7.ts", "mod-7.ts"]);
  });

  it("passes an abort signal with a bounded timeout on every request", async () => {
    await enrichCommits(1, "acme", "syncro", [commit(1)], { remainingMs: () => 14_000 });
    const opts = request.mock.calls[0][1];
    expect(opts.request.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to webhook data when a request fails or times out", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    request.mockRejectedValueOnce(timeout);

    const out = await enrichCommits(1, "acme", "syncro", [commit(1), commit(2)]);

    expect(out[0].statsFromApi).toBe(false);
    expect(out[0].changedFiles).toBe(2);
    expect(out[1].statsFromApi).toBe(true);
  });

  it("skips the API entirely when the remaining time is needed for the send", async () => {
    const reserve = RELAY.discordAttemptTimeoutMs + RELAY.deadlineSafetyReserveMs;
    const out = await enrichCommits(1, "acme", "syncro", [commit(1)], { remainingMs: () => reserve });

    expect(App.prototype.getInstallationOctokit).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(out[0].statsFromApi).toBe(false);
  });

  it("falls back for every commit when the App key cannot be read", async () => {
    // Fresh module copies: the App client is cached per container once created.
    await jest.isolateModulesAsync(async () => {
      const secrets = await import("../../src/config/secrets");
      const github = await import("../../src/services/github.service");
      secrets.setParameterReaderForTests(async () => {
        const e = new Error("denied");
        e.name = "AccessDeniedException";
        throw e;
      });

      const out = await github.enrichCommits(2, "acme", "syncro", [commit(1), commit(2)]);

      expect(out.every((c) => c.statsFromApi === false)).toBe(true);
      expect(out[0].changedFiles).toBe(2);
    });
    expect(request).not.toHaveBeenCalled();
  });
});
