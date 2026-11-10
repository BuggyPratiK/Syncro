/**
 * Webhook URL validation and SSRF prevention.
 * Validates external webhook URLs against approved domains, protocols, and path formats.
 */

const ALLOWED_DISCORD_HOSTS = new Set([
  "discord.com",
  "discordapp.com",
  "canary.discord.com",
  "ptb.discord.com",
]);

export interface UrlValidationResult {
  valid: boolean;
  error?: string;
  cleanedUrl?: string;
}

/**
 * Validates a Discord incoming webhook URL.
 * Enforces:
 * - HTTPS protocol
 * - No userinfo (user:pass@)
 * - Strict whitelist of Discord domains (case-insensitive)
 * - Discord webhook path format: /api/webhooks/<snowflake_id>/<webhook_token>
 * - Snowflake ID is numeric (15 to 22 digits)
 * - Token is URL-safe alphanumeric (+ _ and -)
 * - Strips any query parameters or hash fragments to prevent parameter pollution
 */
export function validateDiscordWebhookUrl(rawUrl: string): UrlValidationResult {
  if (!rawUrl || typeof rawUrl !== "string") {
    return { valid: false, error: "Discord webhook URL must be a non-empty string" };
  }

  const trimmed = rawUrl.trim();
  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: "Invalid URL structure" };
  }

  // 1. Enforce HTTPS
  if (parsed.protocol !== "https:") {
    return { valid: false, error: "Discord webhook URL must use HTTPS" };
  }

  // 2. Reject credentials in URL
  if (parsed.username || parsed.password) {
    return { valid: false, error: "Discord webhook URL must not contain credentials" };
  }

  // 3. Reject non-standard ports
  if (parsed.port && parsed.port !== "443") {
    return { valid: false, error: "Discord webhook URL must not specify non-standard ports" };
  }

  // 4. Strict hostname whitelist
  const hostname = parsed.hostname.toLowerCase();
  if (!ALLOWED_DISCORD_HOSTS.has(hostname)) {
    return {
      valid: false,
      error: `Invalid webhook domain: '${hostname}'. Only official Discord domains are permitted`,
    };
  }

  // 5. Strict path format: /api/webhooks/<snowflake>/<token>
  const match = parsed.pathname.match(/^\/api\/webhooks\/(\d{15,22})\/([a-zA-Z0-9_-]+)$/);
  if (!match) {
    return {
      valid: false,
      error: "Invalid Discord webhook path. Expected '/api/webhooks/<id>/<token>'",
    };
  }

  // Clean canonical URL without search/hash
  const cleanedUrl = `https://${hostname}${parsed.pathname}`;

  return {
    valid: true,
    cleanedUrl,
  };
}

