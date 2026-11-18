// @vitest-environment node
/**
 * Tests for the CI guards: the bundle secret check and the lint rule that
 * keeps backend code (other than the API contract) out of the web app.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ESLint } from "eslint";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { scan } from "./check-bundle.mjs";
import { checkVercelConfig, parseCsp } from "./check-deploy-config.mjs";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function bundle(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "syncro-bundle-"));
  dirs.push(dir);
  mkdirSync(join(dir, "assets"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

describe("bundle secret check", () => {
  it("passes a clean bundle", () => {
    expect(scan(bundle({ "assets/index.js": "const a=1;", "index.html": "<html></html>" }))).toEqual([]);
  });

  it.each([
    ["PEM block", "-----BEGIN RSA PRIVATE KEY-----"],
    ["Discord webhook URL", "https://discord.com/api/webhooks/1/abc"],
    ["Discord webhook URL (legacy host)", "https://discordapp.com/api/webhooks/1/abc"],
    ["GitHub token prefix", "ghp_abc"],
    ["GitHub token prefix", "token=gho_x"],
    ["GitHub token prefix", "ghu_"],
    ["GitHub token prefix", "ghs_"],
    ["GitHub token prefix", "ghr_"],
  ])("flags %s", (name, text) => {
    const findings = scan(bundle({ "assets/index.js": `x="${text}"` }));
    expect(findings).toEqual([{ file: join("assets", "index.js"), name }]);
  });
});

describe("backend import rule", () => {
  const eslint = new ESLint({ cwd: join(import.meta.dirname, "..") });

  async function messages(code: string): Promise<string[]> {
    const [result] = await eslint.lintText(code, { filePath: join(import.meta.dirname, "..", "src", "pages", "x.ts") });
    return result.messages.map((m) => m.ruleId ?? m.message);
  }

  // The first lint loads the config and parser, which is slow on some file
  // systems (for example a Windows drive mounted in WSL). Pay that cost once
  // here so each case below keeps the default per-test timeout.
  beforeAll(async () => {
    await messages("export {};");
  }, 60_000);

  it.each([
    'import { ddb } from "../../../src/db/client";',
    'import { logger } from "../../../src/utils/logger";',
    'export * from "../../../src/secrets/destination-secrets";',
    'import x from "../../../src/contracts-extra/thing";',
  ])("rejects %s", async (code) => {
    expect(await messages(code)).toContain("no-restricted-imports");
  });

  it.each([
    'import { ROUTES } from "../../../src/contracts";',
    'import { ROUTES } from "../../../src/contracts/routes";',
    'import { ROUTES } from "@contracts";',
    'import { PATHS } from "../paths";',
  ])("allows %s", async (code) => {
    expect(await messages(`${code}\nexport const y = 1;`)).not.toContain("no-restricted-imports");
  });
});

describe("vercel.json check", () => {
  const committed = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "vercel.json"), "utf8"));

  function filled(): typeof committed {
    const text = JSON.stringify(committed)
      .replaceAll("__PRODUCTION_HOST__", "syncro-app.vercel.app")
      .replaceAll("__PROD_API_ORIGIN__", "https://prod.execute-api.ap-southeast-2.amazonaws.com")
      .replaceAll("__PROD_LOGTO_ORIGIN__", "https://prodtenant.logto.app")
      .replaceAll("__PREVIEW_API_ORIGIN__", "https://dev.execute-api.ap-southeast-2.amazonaws.com")
      .replaceAll("__DEV_LOGTO_ORIGIN__", "https://devtenant.logto.app");
    return JSON.parse(text);
  }

  it("accepts the committed file outside Vercel", () => {
    expect(checkVercelConfig(committed, {})).toEqual([]);
  });

  it("has the required CSP directives for production", () => {
    const rule = committed.headers.find((r: { has?: unknown }) => r.has);
    const csp = parseCsp(rule.headers[0].value);
    expect(csp["default-src"]).toEqual(["'self'"]);
    expect(csp["script-src"]).toEqual(["'self'"]);
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
    expect(csp["base-uri"]).toEqual(["'self'"]);
  });

  it("fails a Vercel build while placeholders remain", () => {
    expect(checkVercelConfig(committed, { VERCEL_ENV: "preview" })).toContain(
      "vercel.json still contains __PLACEHOLDER__ values",
    );
  });

  it("accepts a filled file whose CSP matches the build settings", () => {
    expect(
      checkVercelConfig(filled(), {
        VERCEL_ENV: "production",
        VERCEL_PROJECT_PRODUCTION_URL: "syncro-app.vercel.app",
        VITE_API_BASE: "https://prod.execute-api.ap-southeast-2.amazonaws.com/",
        VITE_LOGTO_ENDPOINT: "https://prodtenant.logto.app",
      }),
    ).toEqual([]);
    expect(
      checkVercelConfig(filled(), {
        VERCEL_ENV: "preview",
        VITE_API_BASE: "https://dev.execute-api.ap-southeast-2.amazonaws.com",
        VITE_LOGTO_ENDPOINT: "https://devtenant.logto.app",
      }),
    ).toEqual([]);
  });

  it("rejects a production build pointed at the dev tenant", () => {
    const problems = checkVercelConfig(filled(), {
      VERCEL_ENV: "production",
      VITE_API_BASE: "https://prod.execute-api.ap-southeast-2.amazonaws.com",
      VITE_LOGTO_ENDPOINT: "https://devtenant.logto.app",
    });
    expect(problems).toContain("CSP connect-src does not allow VITE_LOGTO_ENDPOINT");
  });

  it("rejects relaxed policies", () => {
    const relaxed = JSON.parse(JSON.stringify(committed).replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"));
    const problems = checkVercelConfig(relaxed, {});
    expect(problems.some((p: string) => p.includes("script-src must be exactly"))).toBe(true);
    expect(problems.some((p: string) => p.includes("forbidden source 'unsafe-inline'"))).toBe(true);
  });
});
