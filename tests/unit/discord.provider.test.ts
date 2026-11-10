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
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123456789012345678/mock-token",
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

  it("does not retry permanent client errors (400, 401, 404) and returns immediately", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: jest.fn().mockResolvedValue("Bad Request: Invalid Embed"),
    } as any);

    const provider = new DiscordProvider();
    const result = await provider.send(mockPayload);

    expect(result.success).toBe(false);
    expect(result.channel).toBe("discord");
    expect(result.statusCode).toBe(400);
    expect(result.retried).toBe(false);
    expect(result.error).toContain("Discord API error 400: Bad Request: Invalid Embed");
    // Verified: Called ONLY ONCE — no retries for permanent errors!
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("handles transient 5xx errors by retrying with backoff", async () => {
    const setTimeoutSpy = jest
      .spyOn(global, "setTimeout")
      .mockImplementation((fn: any) => {
        fn();
        return 0 as any;
      });

    const error500 = {
      ok: false,
      status: 500,
      text: jest.fn().mockResolvedValue("Internal Server Error"),
    };
    const success200 = {
      ok: true,
      status: 200,
    };

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(error500 as any)
      .mockResolvedValueOnce(success200 as any);

    const provider = new DiscordProvider({ initialDelayMs: 10 });
    const result = await provider.send(mockPayload);

    expect(result.success).toBe(true);
    expect(result.retried).toBe(true);
    expect(result.retryCount).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(2);

    setTimeoutSpy.mockRestore();
  });

  it("handles transient network errors by retrying with backoff", async () => {
    const setTimeoutSpy = jest
      .spyOn(global, "setTimeout")
      .mockImplementation((fn: any) => {
        fn();
        return 0 as any;
      });

    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed (ECONNRESET)"))
      .mockResolvedValueOnce({ ok: true, status: 204 } as any);

    const provider = new DiscordProvider({ initialDelayMs: 10 });
    const result = await provider.send(mockPayload);

    expect(result.success).toBe(true);
    expect(result.retried).toBe(true);
    expect(result.retryCount).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(2);

    setTimeoutSpy.mockRestore();
  });

  it("aborts rate limit retry when retry-after exceeds maxRetryDelayMs", async () => {
    const rateLimitResponse = {
      ok: false,
      status: 429,
      headers: {
        get: (h: string) => (h.toLowerCase() === "retry-after" ? "60" : null), // 60 seconds!
      },
      text: jest.fn().mockResolvedValue("You are being rate limited."),
    };

    global.fetch = jest.fn().mockResolvedValue(rateLimitResponse as any);

    const provider = new DiscordProvider({ maxRetryDelayMs: 2000 });
    const result = await provider.send(mockPayload);

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(429);
    expect(result.error).toContain("exceeds max delay");
    // Did NOT sleep or retry
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("aborts rate limit retry when remaining execution budget is insufficient", async () => {
    const rateLimitResponse = {
      ok: false,
      status: 429,
      headers: {
        get: (h: string) => (h.toLowerCase() === "retry-after" ? "2.5" : null), // 2500ms
      },
      text: jest.fn().mockResolvedValue("Rate limited"),
    };

    global.fetch = jest.fn().mockResolvedValue(rateLimitResponse as any);

    // Only 3000ms left in Lambda; 2500ms + 2000ms safety buffer > 3000ms
    const provider = new DiscordProvider({
      getRemainingTimeMs: () => 3000,
    });
    const result = await provider.send(mockPayload);

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(429);
    expect(result.error).toContain("exceeds execution budget");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("redacts secret tokens from Discord webhook URLs in error messages", async () => {
    global.fetch = jest.fn().mockRejectedValue(
      new Error("Failed to post to https://discord.com/api/webhooks/1234567890/super_secret_token_val"),
    );

    const provider = new DiscordProvider({ maxRetries: 0 });
    const result = await provider.send(mockPayload);

    expect(result.success).toBe(false);
    expect(result.error).toContain("https://discord.com/api/webhooks/1234567890/[REDACTED]");
    expect(result.error).not.toContain("super_secret_token_val");
  });

  it("returns failure when missing Discord webhook URL", async () => {
    const provider = new DiscordProvider();
    const result = await provider.send(mockPayload, "");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Missing Discord webhook URL");
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

  it("sends to repository webhook URL passed as targetUrl parameter", async () => {
    let capturedUrl = "";
    let capturedOptions: any;
    global.fetch = jest.fn().mockImplementation((url, options) => {
      capturedUrl = String(url);
      capturedOptions = options;
      return Promise.resolve({ ok: true, status: 200 } as any);
    });

    const customRepoWebhook = "https://discord.com/api/webhooks/987654321098765432/custom-repo-channel";
    const provider = new DiscordProvider();
    const result = await provider.send(mockPayload, customRepoWebhook);

    expect(result.success).toBe(true);
    expect(capturedUrl).toBe(customRepoWebhook);
    expect(capturedOptions.redirect).toBe("error");
  });

  it("rejects malicious or invalid webhook URLs with SSRF protection", async () => {
    const provider = new DiscordProvider();
    const badUrl = "http://internal-metadata.aws/secret";
    const result = await provider.send(mockPayload, badUrl);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid Discord webhook URL");
  });
});