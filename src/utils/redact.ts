/**
 * Secret redaction for logs and stored error messages.
 *
 * Anything that may end up in CloudWatch or DynamoDB passes through here first.
 * Redaction is fail-closed: if a value cannot be inspected safely (for example
 * a circular structure or a getter that throws), it is replaced by a
 * placeholder instead of being written out unredacted.
 */

import { RELAY } from "../contracts/constants";

const REDACTED = "[REDACTED]";

/**
 * Patterns for secret values that can appear inside free text (error
 * messages, upstream response bodies, stack traces).
 */
const SECRET_TEXT_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // Discord webhook URL: keep the non-secret webhook ID, drop the token.
  [/(discord(?:app)?\.com\/api\/webhooks\/\d+\/)[^\s"'>]+/gi, `$1${REDACTED}`],
  // PEM private keys (whole block, or a truncated header onwards).
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  // GitHub tokens: classic prefixes and fine-grained personal access tokens.
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED],
  // Authorization header values.
  [/\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // AWS access key IDs.
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
];

/** Object keys whose string values are always secrets. */
const SECRET_KEY_PATTERN = /secret|token|password|private_?key|authorization|oauth_?code/i;
/** Object keys holding webhook URLs: masked rather than dropped, to keep the webhook ID. */
const WEBHOOK_URL_KEY_PATTERN = /webhook_?url/i;

const MAX_DEPTH = 8;

/** Masks the token part of every Discord webhook URL in `text`. */
export function maskWebhookUrl(text: string): string {
  if (typeof text !== "string") return text;
  return text.replace(SECRET_TEXT_PATTERNS[0][0], SECRET_TEXT_PATTERNS[0][1]);
}

/** Replaces every known secret pattern in `text`. */
export function redactText(text: string): string {
  if (typeof text !== "string") return text;
  let out = text;
  for (const [pattern, replacement] of SECRET_TEXT_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactText(value);
  if (value instanceof Error) return redactText(value.message);
  if (value === null || typeof value !== "object") return value;

  if (depth >= MAX_DEPTH || seen.has(value)) return REDACTED;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(k) && typeof v === "string") {
      out[k] = REDACTED;
    } else if (WEBHOOK_URL_KEY_PATTERN.test(k) && typeof v === "string") {
      out[k] = maskWebhookUrl(redactText(v));
    } else {
      out[k] = redactValue(v, depth + 1, seen);
    }
  }
  return out;
}

/**
 * Recursively redacts secrets from log metadata. Never throws: on any failure
 * the whole value is replaced, so nothing unredacted is ever logged.
 */
export function sanitizeLogData(value: unknown): unknown {
  try {
    return redactValue(value, 0, new WeakSet());
  } catch {
    return REDACTED;
  }
}

/**
 * Prepares an error message for storage in DynamoDB: secrets are masked
 * FIRST, then the text is truncated to the stored-length cap. Never rejects
 * a message for being long, and never throws.
 */
export function sanitizeErrorForStorage(message: unknown): string {
  let text: string;
  try {
    text = redactText(message instanceof Error ? message.message : String(message));
  } catch {
    return REDACTED;
  }
  const max = RELAY.persistedErrorMaxChars;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
