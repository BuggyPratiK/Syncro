/**
 * Public build-time configuration. Every value here is compiled into the
 * browser bundle, so only non-secret values may ever be added.
 */

import { z } from "zod";

declare global {
  interface ImportMetaEnv {
    readonly VITE_LOGTO_ENDPOINT?: string;
    readonly VITE_LOGTO_APP_ID?: string;
    readonly VITE_API_RESOURCE?: string;
    readonly VITE_API_BASE?: string;
    readonly VITE_FIXTURES?: string;
  }
}

const httpsOrLocalUrl = z
  .url()
  .refine((value) => {
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    return url.protocol === "https:" || (local && url.protocol === "http:");
  }, "must be https (http only for localhost)")
  .transform((value) => value.replace(/\/+$/, ""));

const configSchema = z.object({
  logtoEndpoint: httpsOrLocalUrl,
  logtoAppId: z.string().min(1),
  apiResource: z.string().min(1),
  apiBase: httpsOrLocalUrl,
});

export type AppConfig = z.infer<typeof configSchema>;

export type ConfigResult = { ok: true; config: AppConfig } | { ok: false; missing: string[] };

const ENV_NAMES: Record<keyof AppConfig, string> = {
  logtoEndpoint: "VITE_LOGTO_ENDPOINT",
  logtoAppId: "VITE_LOGTO_APP_ID",
  apiResource: "VITE_API_RESOURCE",
  apiBase: "VITE_API_BASE",
};

export function readConfig(env: ImportMetaEnv = import.meta.env): ConfigResult {
  const parsed = configSchema.safeParse({
    logtoEndpoint: env.VITE_LOGTO_ENDPOINT,
    logtoAppId: env.VITE_LOGTO_APP_ID,
    apiResource: env.VITE_API_RESOURCE,
    apiBase: env.VITE_API_BASE,
  });
  if (parsed.success) return { ok: true, config: parsed.data };
  const missing = [...new Set(parsed.error.issues.map((i) => ENV_NAMES[i.path[0] as keyof AppConfig]))];
  return { ok: false, missing };
}

/**
 * Fixture mode runs the UI against in-memory data with a fake signed-in user.
 * `import.meta.env.DEV` is false in production builds, so the fixture code is
 * removed from the bundle entirely.
 */
export const FIXTURES_ENABLED = import.meta.env.DEV && import.meta.env.VITE_FIXTURES === "true";
