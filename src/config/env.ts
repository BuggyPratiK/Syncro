/**
 * Environment variable validation using Zod.
 * The application will throw at startup if any required variable is missing.
 * This surfaces misconfiguration immediately rather than at the point of use.
 */

import { z } from "zod";

const envSchema = z.object({
  // AWS
  AWS_REGION: z.string().min(1).default("ap-south-1"),
  DYNAMODB_TABLE_NAME: z.string().min(1).default("syncro"),
  DYNAMODB_ENDPOINT: z.string().url().optional(), // Only for local dev with DynamoDB Local

  // GitHub App
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),

  // Discord -mvp
  DISCORD_WEBHOOK_URL: z.string().url(),

  // Default config
  DEFAULT_WATCHED_BRANCH: z.string().min(1).default("main"),

  // Logging
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // Runtime environment
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),

  //For later..
  TELEGRAM_BOT_TOKEN: z.string().optional(),

  //For later...
  SLACK_WEBHOOK_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validated environment variables.
 * Import this throughout the app — never use process.env directly.
 */
function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error(
      "Invalid environment variables:",
      JSON.stringify(result.error.flatten().fieldErrors, null, 2),
    );
    throw new Error("Invalid environment configuration — check your .env.local file");
  }
  return result.data;
}

// Lazy singleton — only validates once per Lambda cold start
let _env: Env | undefined;
export function getEnv(): Env {
  if (!_env) {
    _env = validateEnv();
  }
  return _env;
}
