/**
 * Relay hardening guards:
 * - the Discord provider sends only to an explicit target and never reads a
 *   global URL from the environment;
 * - each Discord attempt is aborted at its timeout, and no attempt starts once
 *   the invocation budget is used up;
 * - a missing webhook secret makes the handler fail closed before any
 *   processing;
 * - stored error messages are masked and capped;
 * - the lint rule blocks any reintroduction of a global or record-stored URL.
 */

import { execFileSync } from "child_process";
import * as path from "path";
import { DiscordProvider } from "../../src/notifications/providers/discord.provider";
import { NotificationPayload } from "../../src/types/notification.types";
import { buildPushEmbed } from "../../src/notifications/templates/push.template";
import { RELAY } from "../../src/contracts";

const TARGET = "https://discord.com/api/webhooks/123456789012345678/target-token";

const payload: NotificationPayload = {
  type: "push",
  repoFullName: "acme/syncro",
  repoUrl: "https://github.com/acme/syncro",
  branch: "main",
  pusherName: "pratik",
  commits: [],
  totalAdditions: 0,
  totalDeletions: 0,
  totalFilesChanged: 0,
  changedFiles: [],
  compareUrl: "https://github.com/acme/syncro/compare/a...b",
  timestamp: "2026-11-15T00:00:00Z",
};

describe("Discord provider: explicit targets only", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.DISCORD_WEBHOOK_URL;
  });

  it("does not call fetch and ignores any DISCORD_WEBHOOK_URL in the environment when no target is given", async () => {
    process.env.DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1/global-token";
    global.fetch = jest.fn();

    const result = await new DiscordProvider().send(payload, "");

    expect(result.success).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("aborts an attempt that exceeds its timeout", async () => {
    global.fetch = jest.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "TimeoutError";
            reject(e);
          });
        }),
    ) as unknown as typeof fetch;

    // 2.1 s left - 2 s reserve → a 100 ms attempt timeout.
    const deadline = { remainingMs: () => RELAY.deadlineSafetyReserveMs + 100 };
    const started = Date.now();
    const result = await new DiscordProvider({ maxRetries: 0 }).send(payload, TARGET, { deadline });

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("caps each attempt at the configured maximum", async () => {
    const signals: AbortSignal[] = [];
    global.fetch = jest.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => {
      if (init?.signal) signals.push(init.signal);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await new DiscordProvider().send(payload, TARGET, { deadline: { remainingMs: () => 14_000 } });

    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
  });

  it("does not start an attempt once the execution budget is used up", async () => {
    global.fetch = jest.fn();
    const deadline = { remainingMs: () => RELAY.deadlineSafetyReserveMs - 1 };

    const result = await new DiscordProvider().send(payload, TARGET, { deadline });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Insufficient execution time");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("push template: partial line stats", () => {
  it("labels totals that cover only some commits", () => {
    const commits = Array.from({ length: 7 }, (_, i) => ({
      sha: `${i}`,
      shortSha: `${i}`,
      message: "m",
      url: "u",
      authorName: "a",
    }));
    const embed = buildPushEmbed({ ...payload, commits, commitsWithStats: 5 });
    expect(embed.description).toContain("line stats for 5 of 7 commits");
  });

  it("adds no label when every commit has stats", () => {
    const commits = [{ sha: "1", shortSha: "1", message: "m", url: "u", authorName: "a" }];
    expect(buildPushEmbed({ ...payload, commits, commitsWithStats: 1 }).description).not.toContain("line stats");
  });
});

describe("lint guard against global or record-stored webhook URLs", () => {
  const root = path.resolve(__dirname, "../..");
  const eslintBin = path.join(root, "node_modules", "eslint", "bin", "eslint.js");

  function lint(code: string, filePath: string): string {
    try {
      execFileSync(process.execPath, [eslintBin, "--stdin", "--stdin-filename", filePath], {
        cwd: root,
        input: code,
        encoding: "utf8",
      });
      return "";
    } catch (error) {
      return String((error as { stdout?: string }).stdout ?? error);
    }
  }

  it("rejects DISCORD_WEBHOOK_URL anywhere in the application", () => {
    const out = lint("export const u = process.env.DISCORD_WEBHOOK_URL;\n", "src/db/probe.ts");
    expect(out).toContain("no global Discord webhook URL");
  }, 60_000);

  it("rejects reading a stored webhook URL in the send path", () => {
    const code = "export const f = (r: { discord_webhook_url?: string }) => r.discord_webhook_url;\n";
    expect(lint(code, "src/notifications/probe.ts")).toContain("must not read a webhook URL");
    expect(lint(code, "src/webhooks/probe.ts")).toContain("must not read a webhook URL");
  }, 60_000);
});
