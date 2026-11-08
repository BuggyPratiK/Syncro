import { DiscordProvider } from "../../src/notifications/providers/discord.provider";
import { NotificationPayload } from "../../src/types/notification.types";

const mockPayload: NotificationPayload = {
  type: "push",
  repoFullName: "acme/syncro",
  repoUrl: "https://github.com/acme/syncro",
  branch: "main",
  pusherName: "pratik",
  commits: [
    {
      sha: "a81f23c",
      shortSha: "a81f23c",
      message: "feat: add discord notifications",
      url: "https://github.com/acme/syncro/commit/a81f23c",
      authorName: "Pratik",
    },
  ],
  totalAdditions: 10,
  totalDeletions: 2,
  totalFilesChanged: 1,
  changedFiles: ["src/notifications/providers/discord.provider.ts"],
  compareUrl: "https://github.com/acme/syncro/compare/a...b",
  timestamp: "2026-10-15T00:00:00Z",
};

describe("DiscordProvider", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      DYNAMODB_TABLE_NAME: "test-table",
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "dummy-key",
      GITHUB_WEBHOOK_SECRET: "dummy-secret",
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/mock",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it("returns success: true when Discord API responds with 204 No Content", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 204,
    } as any);

    const provider = new DiscordProvider();
    const result = await provider.send(mockPayload);

    expect(result.success).toBe(true);
    expect(result.channel).toBe("discord");
    expect(result.retried).toBe(false);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("handles rate limiting (429) by waiting and retrying once", async () => {
    const setTimeoutSpy = jest
      .spyOn(global, "setTimeout")
      .mockImplementation((fn: any) => {
        fn();
        return 0 as any;
      });

    const rateLimitResponse = {
      ok: false,
      status: 429,
      headers: {
        get: (header: string) => (header.toLowerCase() === "retry-after" ? "0.05" : null),
      },
    };
    const successResponse = {
      ok: true,
      status: 200,
    };

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(rateLimitResponse as any)
      .mockResolvedValueOnce(successResponse as any);

    const provider = new DiscordProvider();
    const result = await provider.send(mockPayload);

    expect(result.success).toBe(true);
    expect(result.channel).toBe("discord");
    expect(result.retried).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);

    setTimeoutSpy.mockRestore();
  });

  it("returns success: false when Discord returns error code and retries fail", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: jest.fn().mockResolvedValue("Internal Server Error"),
    } as any);

    const provider = new DiscordProvider();
    const result = await provider.send(mockPayload);

    expect(result.success).toBe(false);
    expect(result.channel).toBe("discord");
    expect(result.error).toContain("Discord API error 500");
  });

  it("formats and delivers pull_request payloads using buildPrEmbed", async () => {
    let capturedBody = "";
    global.fetch = jest.fn().mockImplementation((_url, options) => {
      capturedBody = options.body;
      return Promise.resolve({ ok: true, status: 200 } as any);
    });

    const prPayload: NotificationPayload = {
      type: "pull_request",
      repoFullName: "acme/syncro",
      repoUrl: "https://github.com/acme/syncro",
      branch: "main",
      pusherName: "pratik",
      commits: [],
      totalAdditions: 45,
      totalDeletions: 12,
      totalFilesChanged: 2,
      changedFiles: [],
      compareUrl: "https://github.com/acme/syncro/pull/99",
      timestamp: "2026-11-08T10:00:00Z",
      pullRequest: {
        action: "opened",
        number: 99,
        title: "feat: add pr notifications",
        url: "https://github.com/acme/syncro/pull/99",
        authorName: "pratik",
        baseBranch: "main",
        headBranch: "feature/pr",
      },
    };

    const provider = new DiscordProvider();
    const result = await provider.send(prPayload);

    expect(result.success).toBe(true);
    expect(capturedBody).toContain("PR #99 opened - acme/syncro");
  });
});