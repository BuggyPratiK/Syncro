import { validateDiscordWebhookUrl } from "../../src/utils/url-validator";

describe("validateDiscordWebhookUrl", () => {
  const VALID_WEBHOOK_URL =
    "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_0123456789-ABCDEFG";

  it("accepts valid official Discord webhook URLs", () => {
    const result = validateDiscordWebhookUrl(VALID_WEBHOOK_URL);
    expect(result.valid).toBe(true);
    expect(result.cleanedUrl).toBe(VALID_WEBHOOK_URL);
  });

  it("accepts valid discordapp.com domain", () => {
    const url = "https://discordapp.com/api/webhooks/987654321098765432/token-xyz_123";
    const result = validateDiscordWebhookUrl(url);
    expect(result.valid).toBe(true);
    expect(result.cleanedUrl).toBe(url);
  });

  it("accepts canary.discord.com and ptb.discord.com", () => {
    const canary = "https://canary.discord.com/api/webhooks/123456789012345678/valid_token-123";
    const ptb = "https://ptb.discord.com/api/webhooks/123456789012345678/valid_token-123";
    expect(validateDiscordWebhookUrl(canary).valid).toBe(true);
    expect(validateDiscordWebhookUrl(ptb).valid).toBe(true);
  });

  it("strips query parameters and hash fragments to prevent parameter tampering", () => {
    const dirtyUrl = `${VALID_WEBHOOK_URL}?wait=true&evil=1#section`;
    const result = validateDiscordWebhookUrl(dirtyUrl);
    expect(result.valid).toBe(true);
    expect(result.cleanedUrl).toBe(VALID_WEBHOOK_URL);
  });

  it("rejects non-HTTPS URLs (e.g. plain HTTP)", () => {
    const httpUrl = "http://discord.com/api/webhooks/123456789012345678/token";
    const result = validateDiscordWebhookUrl(httpUrl);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("must use HTTPS");
  });

  it("rejects non-Discord domains (SSRF prevention)", () => {
    const attackerUrls = [
      "https://attacker.com/api/webhooks/123456789012345678/token",
      "https://169.254.169.254/latest/meta-data/",
      "https://localhost:8080/api/webhooks/123456789012345678/token",
      "https://evil-discord.com/api/webhooks/123456789012345678/token",
      "https://discord.com.attacker.com/api/webhooks/123456789012345678/token",
    ];

    for (const url of attackerUrls) {
      const result = validateDiscordWebhookUrl(url);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Invalid webhook domain|Invalid URL|non-standard ports/);
    }
  });

  it("rejects URLs with embedded credentials (user:pass@)", () => {
    const credUrl = "https://admin:secret@discord.com/api/webhooks/123456789012345678/token";
    const result = validateDiscordWebhookUrl(credUrl);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("must not contain credentials");
  });

  it("rejects URLs with non-standard ports", () => {
    const portUrl = "https://discord.com:8443/api/webhooks/123456789012345678/token";
    const result = validateDiscordWebhookUrl(portUrl);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("non-standard ports");
  });

  it("rejects invalid path formats", () => {
    const invalidPaths = [
      "https://discord.com/api/v10/channels/1234/messages",
      "https://discord.com/api/webhooks",
      "https://discord.com/api/webhooks/not-a-number/token",
      "https://discord.com/api/webhooks/123/token-too-short-snowflake",
      "https://discord.com/api/webhooks/123456789012345678/",
    ];

    for (const url of invalidPaths) {
      const result = validateDiscordWebhookUrl(url);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid Discord webhook path");
    }
  });

  it("rejects empty or non-string inputs", () => {
    expect(validateDiscordWebhookUrl("").valid).toBe(false);
    expect(validateDiscordWebhookUrl(null as any).valid).toBe(false);
    expect(validateDiscordWebhookUrl(undefined as any).valid).toBe(false);
  });
});
