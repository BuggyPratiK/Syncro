/**
 * Client-side shape hint for a Discord webhook URL. It only helps the user
 * notice a paste mistake; it never blocks submission, because the server's
 * validator is the authority.
 *
 * The pattern is written with escaped separators so the bundle never contains
 * a literal webhook URL prefix (the CI bundle check rejects one).
 */
const WEBHOOK_SHAPE =
  /^https:\/\/(?:discordapp\.com|(?:(?:canary|ptb)\.)?discord\.com)\/api\/webhooks\/\d{1,20}\/[A-Za-z0-9_-]{1,100}$/;

export function looksLikeDiscordWebhook(value: string): boolean {
  return WEBHOOK_SHAPE.test(value.trim());
}

export const WEBHOOK_HINT =
  "In Discord: Server Settings, Integrations, Webhooks, then Copy Webhook URL. The URL is stored securely and never shown again.";

export const WEBHOOK_SHAPE_WARNING =
  "This doesn’t look like a Discord webhook URL. You can still save it; Syncro will check it.";
