/**
 * Environment variable validation using Zod.
 * The application will throw at startup if any required variable is missing.
 * This surfaces misconfiguration immediately rather than at the point of use.
 *
 * The environment is split into `base`, `webhook` (sender) and `dashboard`
 * schemas, one per Lambda function. Lambda environments hold NON-SECRET values
 * only: secrets are referenced by SSM parameter NAME and read at runtime, so
 * they never appear in the Lambda configuration, CloudFormation templates or CI.
 * There is deliberately no global Discord webhook URL: every notification goes
 * to a destination configured by its workspace, or nowhere.
 */

import { z } from "zod";
import {
  SSM_PARAM_PREFIX_PATTERN,
  dashboardParamNames,
  senderParamNames,
} from "../secrets/param-names";

/** Production region. */
export const DEFAULT_AWS_REGION = "ap-southeast-2";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const githubNumericId = z.string().regex(/^[1-9][0-9]{0,18}$/);
const httpsUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith("https://"), "must be https");

export const baseEnvSchema = z.object({
  AWS_REGION: z.string().min(1).default(DEFAULT_AWS_REGION),
  DYNAMODB_TABLE_NAME: z.string().min(1).default("syncro"),
  DYNAMODB_ENDPOINT: z.string().url().optional(), // DynamoDB Local only
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** `/syncro/prod` in production. */
  SSM_PARAM_PREFIX: z.string().regex(SSM_PARAM_PREFIX_PATTERN),
  /**
   * Non-secret marker. Changing it changes the Lambda configuration, which
   * starts fresh containers that re-read secrets after a rotation.
   */
  SECRETS_EPOCH: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,64}$/)
    .optional(),
});

/**
 * Webhook sender Lambda. The secret parameter names must be exactly the
 * expected ones for the prefix, so this function can never be pointed at the
 * dashboard's secret or at a destination's parameter by configuration.
 */
export const webhookEnvSchema = baseEnvSchema
  .extend({
    GITHUB_APP_ID: githubNumericId,
    GITHUB_APP_PRIVATE_KEY_PARAM: z.string().min(1),
    GITHUB_WEBHOOK_SECRET_PARAM: z.string().min(1),
  })
  .superRefine((env, ctx) => {
    // An invalid prefix is already reported on SSM_PARAM_PREFIX.
    if (!SSM_PARAM_PREFIX_PATTERN.test(env.SSM_PARAM_PREFIX)) return;
    const expected = senderParamNames(env.SSM_PARAM_PREFIX);
    if (env.GITHUB_APP_PRIVATE_KEY_PARAM !== expected.githubAppPrivateKey) {
      ctx.addIssue({ code: "custom", path: ["GITHUB_APP_PRIVATE_KEY_PARAM"], message: "unexpected parameter name" });
    }
    if (env.GITHUB_WEBHOOK_SECRET_PARAM !== expected.githubWebhookSecret) {
      ctx.addIssue({ code: "custom", path: ["GITHUB_WEBHOOK_SECRET_PARAM"], message: "unexpected parameter name" });
    }
  });

/** Dashboard API Lambda. It may read only its own OAuth client secret, never the sender's secrets. */
export const dashboardEnvSchema = baseEnvSchema
  .extend({
    LOGTO_ISSUER: httpsUrl,
    LOGTO_JWKS_URI: httpsUrl,
    API_AUDIENCE: z.string().min(1).max(256),
    LOGTO_SPA_CLIENT_ID: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    /** Exact origin; never a wildcard. `http://localhost:<port>` only for the local runner. */
    CORS_ORIGIN: z
      .string()
      .regex(/^(https:\/\/[a-z0-9.-]+(:\d{1,5})?|http:\/\/localhost:\d{1,5})$/),
    GITHUB_APP_ID: githubNumericId,
    GITHUB_APP_CLIENT_ID: z.string().regex(/^[A-Za-z0-9.]{1,64}$/),
    GITHUB_APP_SLUG: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
    GITHUB_OAUTH_CLIENT_SECRET_PARAM: z.string().min(1),
  })
  .superRefine((env, ctx) => {
    if (!SSM_PARAM_PREFIX_PATTERN.test(env.SSM_PARAM_PREFIX)) return;
    if (env.GITHUB_OAUTH_CLIENT_SECRET_PARAM !== dashboardParamNames(env.SSM_PARAM_PREFIX).githubOAuthClientSecret) {
      ctx.addIssue({ code: "custom", path: ["GITHUB_OAUTH_CLIENT_SECRET_PARAM"], message: "unexpected parameter name" });
    }
  });

export type BaseEnv = z.infer<typeof baseEnvSchema>;
export type WebhookEnv = z.infer<typeof webhookEnvSchema>;
export type DashboardEnv = z.infer<typeof dashboardEnvSchema>;

export class InvalidEnvironmentError extends Error {
  /** Field names only — never values. */
  readonly fields: string[];
  constructor(fields: string[]) {
    super(`Invalid environment configuration: ${fields.join(", ")}`);
    this.name = "InvalidEnvironmentError";
    this.fields = fields;
  }
}

function parseWith<T>(schema: z.ZodType<T>, source: NodeJS.ProcessEnv): T {
  const result = schema.safeParse(source);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((i) => String(i.path[0] ?? "(root)")))].sort();
    throw new InvalidEnvironmentError(fields);
  }
  return result.data;
}

export function parseWebhookEnv(source: NodeJS.ProcessEnv = process.env): WebhookEnv {
  return parseWith(webhookEnvSchema, source);
}

export function parseDashboardEnv(source: NodeJS.ProcessEnv = process.env): DashboardEnv {
  return parseWith(dashboardEnvSchema, source);
}

export function parseBaseEnv(source: NodeJS.ProcessEnv = process.env): BaseEnv {
  return parseWith(baseEnvSchema, source);
}

let _baseEnv: BaseEnv | undefined;
/** Settings shared by every function (table, region, SSM prefix), validated once per container. */
export function getBaseEnv(): BaseEnv {
  if (!_baseEnv) _baseEnv = parseBaseEnv();
  return _baseEnv;
}

let _webhookEnv: WebhookEnv | undefined;
/** Sender env, validated once per container (cold start). */
export function getWebhookEnv(): WebhookEnv {
  if (!_webhookEnv) _webhookEnv = parseWebhookEnv();
  return _webhookEnv;
}

let _dashboardEnv: DashboardEnv | undefined;
/** Dashboard env, validated once per container (cold start). */
export function getDashboardEnv(): DashboardEnv {
  if (!_dashboardEnv) _dashboardEnv = parseDashboardEnv();
  return _dashboardEnv;
}

/** Test hook: forget the cached settings so the next call re-reads `process.env`. */
export function resetEnvCacheForTests(): void {
  _baseEnv = undefined;
  _webhookEnv = undefined;
  _dashboardEnv = undefined;
}
