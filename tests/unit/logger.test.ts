import { logger, maskWebhookUrl, sanitizeLogData } from "../../src/utils/logger";

describe("logger and secret masking", () => {
  it("maskWebhookUrl redacts token from standard Discord webhook URL", () => {
    const raw = "https://discord.com/api/webhooks/1234567890/aBcDeF-123_XYZ";
    expect(maskWebhookUrl(raw)).toBe("https://discord.com/api/webhooks/1234567890/[REDACTED]");
  });

  it("maskWebhookUrl redacts token from discordapp.com webhook URL", () => {
    const raw = "https://discordapp.com/api/webhooks/987654321/secret_token_here";
    expect(maskWebhookUrl(raw)).toBe("https://discordapp.com/api/webhooks/987654321/[REDACTED]");
  });

  it("maskWebhookUrl leaves non-webhook URLs unmodified", () => {
    const raw = "https://github.com/BuggyPratiK/Syncro";
    expect(maskWebhookUrl(raw)).toBe("https://github.com/BuggyPratiK/Syncro");
  });

  it("sanitizeLogData recursively redacts secrets, tokens, private keys and webhook URLs", () => {
    const sensitiveObj = {
      user: "pratik",
      discord_webhook_url: "https://discord.com/api/webhooks/111/secret_tok",
      secret: "super-secret-key",
      githubToken: "ghp_123456789",
      nested: {
        private_key: "-----BEGIN RSA PRIVATE KEY-----",
        normalField: "hello",
        webhookList: ["https://discord.com/api/webhooks/222/secret_tok_2"],
      },
    };

    const sanitized = sanitizeLogData(sensitiveObj) as any;

    expect(sanitized.discord_webhook_url).toBe("https://discord.com/api/webhooks/111/[REDACTED]");
    expect(sanitized.secret).toBe("[REDACTED]");
    expect(sanitized.githubToken).toBe("[REDACTED]");
    expect(sanitized.nested.private_key).toBe("[REDACTED]");
    expect(sanitized.nested.normalField).toBe("hello");
    expect(sanitized.nested.webhookList[0]).toBe("https://discord.com/api/webhooks/222/[REDACTED]");
  });

  it("logger.info sanitizes log message and context before writing to stdout", () => {
    const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    logger.info("Delivering to https://discord.com/api/webhooks/999/secret_xyz", {
      webhook_url: "https://discord.com/api/webhooks/999/secret_xyz",
      repo: "acme/syncro",
    });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const loggedOutput = consoleSpy.mock.calls[0][0];
    expect(loggedOutput).not.toContain("secret_xyz");
    expect(loggedOutput).toContain("https://discord.com/api/webhooks/999/[REDACTED]");

    consoleSpy.mockRestore();
  });
});

