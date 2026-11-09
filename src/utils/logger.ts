/**
 * Structured JSON logger for CloudWatch Logs.
 * Each log line is a valid JSON object — CloudWatch Logs Insights can query these fields.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  requestId?: string;
  [key: string]: unknown;
}

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel =
  (process.env.LOG_LEVEL as LogLevel) ?? "info";

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[currentLevel];
}

/**
 * Masks the sensitive token portion of a Discord webhook URL.
 * e.g. "https://discord.com/api/webhooks/1234567890/secret-token"
 *   -> "https://discord.com/api/webhooks/1234567890/[REDACTED]"
 */
export function maskWebhookUrl(url: string): string {
  if (typeof url !== "string") return url;
  return url.replace(
    /(discord(?:app)?\.com\/api\/webhooks\/\d+\/)[^\s"'>]+/gi,
    "$1[REDACTED]",
  );
}

/**
 * Recursively scrubs sensitive data such as Discord webhook tokens,
 * passwords, private keys, and secrets from log messages and metadata objects.
 */
export function sanitizeLogData(value: unknown): unknown {
  if (typeof value === "string") {
    return maskWebhookUrl(value);
  }
  if (value instanceof Error) {
    return maskWebhookUrl(value.message);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeLogData);
  }
  if (value !== null && typeof value === "object") {
    const sanitizedObj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (/secret|token|password|private_?key/i.test(k) && typeof v === "string") {
        sanitizedObj[k] = "[REDACTED]";
      } else if (/webhook_?url/i.test(k) && typeof v === "string") {
        sanitizedObj[k] = maskWebhookUrl(v);
      } else {
        sanitizedObj[k] = sanitizeLogData(v);
      }
    }
    return sanitizedObj;
  }
  return value;
}

function log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;

  const sanitizedMessage = typeof message === "string" ? maskWebhookUrl(message) : message;
  const sanitizedContext = context
    ? (sanitizeLogData(context) as Record<string, unknown>)
    : undefined;

  const entry: LogEntry = {
    level,
    message: sanitizedMessage,
    timestamp: new Date().toISOString(),
    ...sanitizedContext,
  };

  // CloudWatch captures stdout — use console.log for all levels so they appear in log groups
  console.log(JSON.stringify(entry));
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) =>
    log("debug", message, context),
  info: (message: string, context?: Record<string, unknown>) =>
    log("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) =>
    log("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) =>
    log("error", message, context),
};
