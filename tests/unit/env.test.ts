/**
 * Environment schemas: non-secret values only, secrets by SSM name only,
 * no DISCORD_WEBHOOK_URL, region default ap-southeast-2, and errors that name
 * fields but never echo values.
 */

import {
  DEFAULT_AWS_REGION,
  InvalidEnvironmentError,
  baseEnvSchema,
  dashboardEnvSchema,
  parseDashboardEnv,
  parseWebhookEnv,
  webhookEnvSchema,
} from "../../src/config/env";

const webhookEnv = {
  DYNAMODB_TABLE_NAME: "syncro",
  SSM_PARAM_PREFIX: "/syncro/prod",
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY_PARAM: "/syncro/prod/sender/github-app-private-key",
  GITHUB_WEBHOOK_SECRET_PARAM: "/syncro/prod/sender/github-webhook-secret",
  SECRETS_EPOCH: "2026-11-15.1",
};

const dashboardEnv = {
  DYNAMODB_TABLE_NAME: "syncro",
  SSM_PARAM_PREFIX: "/syncro/prod",
  LOGTO_ISSUER: "https://tenant.logto.app/oidc",
  LOGTO_JWKS_URI: "https://tenant.logto.app/oidc/jwks",
  API_AUDIENCE: "https://api.syncro",
  LOGTO_SPA_CLIENT_ID: "spaclient123",
  CORS_ORIGIN: "https://syncro.vercel.app",
  GITHUB_APP_ID: "123456",
  GITHUB_APP_CLIENT_ID: "Iv23liABCDEF",
  GITHUB_APP_SLUG: "syncro-app",
  GITHUB_OAUTH_CLIENT_SECRET_PARAM: "/syncro/prod/dashboard/github-oauth-client-secret",
};

function webhookShapeKeys(): string[] {
  return Object.keys(baseEnvSchema.shape).concat([
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY_PARAM",
    "GITHUB_WEBHOOK_SECRET_PARAM",
  ]);
}

describe("webhook (sender) env schema", () => {
  it("parses the sender's non-secret settings and defaults the region to ap-southeast-2", () => {
    const env = parseWebhookEnv(webhookEnv);
    expect(env.AWS_REGION).toBe("ap-southeast-2");
    expect(DEFAULT_AWS_REGION).toBe("ap-southeast-2");
    expect(env.GITHUB_APP_PRIVATE_KEY_PARAM).toBe("/syncro/prod/sender/github-app-private-key");
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("has no secret-value keys and no DISCORD_WEBHOOK_URL / LEGACY_COMPAT_*", () => {
    const parsed = parseWebhookEnv({
      ...webhookEnv,
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/x",
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----",
      GITHUB_WEBHOOK_SECRET: "s3cret",
      LEGACY_COMPAT_ENABLED: "true",
    }) as Record<string, unknown>;
    for (const k of ["DISCORD_WEBHOOK_URL", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "LEGACY_COMPAT_ENABLED"]) {
      expect(parsed[k]).toBeUndefined();
    }
    for (const k of webhookShapeKeys()) {
      expect(k).not.toMatch(/^DISCORD_WEBHOOK_URL$|PRIVATE_KEY$|WEBHOOK_SECRET$|^LEGACY_COMPAT_/);
    }
  });

  it("requires the exact sender parameter names for the prefix", () => {
    for (const bad of [
      { GITHUB_APP_PRIVATE_KEY_PARAM: "/syncro/prod/dashboard/github-oauth-client-secret" },
      { GITHUB_WEBHOOK_SECRET_PARAM: "/syncro/prod/ws/x/dest/y/discord-webhook-url" },
      { SSM_PARAM_PREFIX: "/syncro/dev" },
    ]) {
      expect(() => parseWebhookEnv({ ...webhookEnv, ...bad })).toThrow(InvalidEnvironmentError);
    }
  });

  it("rejects an invalid prefix, app id or epoch", () => {
    for (const bad of [
      { SSM_PARAM_PREFIX: "/syncro/prod/" },
      { SSM_PARAM_PREFIX: "syncro/prod" },
      { GITHUB_APP_ID: "abc" },
      { SECRETS_EPOCH: "has space" },
    ]) {
      expect(() => parseWebhookEnv({ ...webhookEnv, ...bad })).toThrow(InvalidEnvironmentError);
    }
  });

  it("reports field names only, never values", () => {
    const secretish = "/syncro/prod/sender/NOT-THE-RIGHT-NAME-SECRET-VALUE";
    try {
      parseWebhookEnv({ ...webhookEnv, GITHUB_WEBHOOK_SECRET_PARAM: secretish });
      fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidEnvironmentError);
      expect((e as InvalidEnvironmentError).fields).toEqual(["GITHUB_WEBHOOK_SECRET_PARAM"]);
      expect((e as Error).message).not.toContain("NOT-THE-RIGHT-NAME");
    }
  });

  it("reports a missing required field", () => {
    try {
      parseWebhookEnv({ ...webhookEnv, GITHUB_APP_ID: undefined });
      fail("expected throw");
    } catch (e) {
      expect((e as InvalidEnvironmentError).fields).toEqual(["GITHUB_APP_ID"]);
    }
  });

  it("reports an invalid prefix as a field error (no raw throw)", () => {
    try {
      parseWebhookEnv({ ...webhookEnv, SSM_PARAM_PREFIX: "/other" });
      fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidEnvironmentError);
      expect((e as InvalidEnvironmentError).fields).toContain("SSM_PARAM_PREFIX");
    }
    expect(() => parseDashboardEnv({ ...dashboardEnv, SSM_PARAM_PREFIX: "/other" })).toThrow(InvalidEnvironmentError);
  });

  it("is exported for the infrastructure env-allowlist check", () => {
    expect(webhookEnvSchema).toBeDefined();
  });
});

describe("dashboard env schema", () => {
  it("parses the dashboard's non-secret settings", () => {
    const env = parseDashboardEnv(dashboardEnv);
    expect(env.CORS_ORIGIN).toBe("https://syncro.vercel.app");
    expect(env.GITHUB_OAUTH_CLIENT_SECRET_PARAM).toBe("/syncro/prod/dashboard/github-oauth-client-secret");
  });

  it("never accepts a sender parameter as its OAuth secret name", () => {
    expect(() =>
      parseDashboardEnv({ ...dashboardEnv, GITHUB_OAUTH_CLIENT_SECRET_PARAM: "/syncro/prod/sender/github-app-private-key" }),
    ).toThrow(InvalidEnvironmentError);
  });

  it.each(["*", "https://*.vercel.app", "http://syncro.vercel.app", "https://syncro.vercel.app/", "null"])(
    "rejects CORS_ORIGIN %s",
    (origin) => {
      expect(() => parseDashboardEnv({ ...dashboardEnv, CORS_ORIGIN: origin })).toThrow(InvalidEnvironmentError);
    },
  );

  it("allows a localhost origin for the local runner only", () => {
    expect(parseDashboardEnv({ ...dashboardEnv, CORS_ORIGIN: "http://localhost:5173" }).CORS_ORIGIN).toBe(
      "http://localhost:5173",
    );
  });

  it("requires https issuer and JWKS URIs", () => {
    expect(() => parseDashboardEnv({ ...dashboardEnv, LOGTO_ISSUER: "http://tenant.logto.app/oidc" })).toThrow(
      InvalidEnvironmentError,
    );
  });

  it("is exported", () => {
    expect(dashboardEnvSchema).toBeDefined();
  });
});
