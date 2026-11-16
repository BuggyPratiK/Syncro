/**
 * Structured JSON logger for CloudWatch Logs.
 * Each log line is a valid JSON object — CloudWatch Logs Insights can query these fields.
 */

import { redactText, sanitizeLogData } from "./redact";

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

// Redaction lives in ./redact; re-exported so existing imports keep working.
export { maskWebhookUrl, sanitizeLogData } from "./redact";

function log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;

  const sanitizedMessage = typeof message === "string" ? redactText(message) : message;
  const redactedContext = context ? sanitizeLogData(context) : undefined;
  // Fail closed: if redaction could not produce an object, log a marker instead of raw data.
  const sanitizedContext =
    redactedContext === undefined || (typeof redactedContext === "object" && redactedContext !== null)
      ? (redactedContext as Record<string, unknown> | undefined)
      : { context: redactedContext };

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
