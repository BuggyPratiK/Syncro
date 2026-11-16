/**
 * CI guard: the Deploy workflow may pass only allowlisted, non-secret values
 * into the CDK deploy step.
 *
 *   npx ts-node scripts/check-deploy-env-allowlist.ts [path/to/deploy.yml]
 *
 * Fails (exit 1) when:
 * - the "CDK Deploy" step or its `env:` block cannot be found;
 * - the step's env contains a key that is not on the allowlist;
 * - a literal value looks like a secret (PEM key, GitHub token, Discord webhook URL);
 * - a GitHub Actions secret is mapped into a key other than AWS_REGION / LOG_LEVEL;
 * - the workflow references any of the retired application secrets.
 *
 * Application secrets live in SSM Parameter Store and never pass through the
 * workflow. Deliberately dependency-free (a small line-based reader for this
 * one workflow shape) and strict: anything it cannot parse is a failure.
 */

import * as fs from "fs";
import * as path from "path";

/** Keys the CDK deploy step may set. All values are non-secret. */
export const DEPLOY_ENV_ALLOWLIST: readonly string[] = [
  "AWS_REGION",
  "LOG_LEVEL",
  "GITHUB_APP_ID",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_SLUG",
  "LOGTO_ISSUER",
  "LOGTO_JWKS_URI",
  "API_AUDIENCE",
  "LOGTO_SPA_CLIENT_ID",
  "CORS_ORIGIN",
  "DASHBOARD_ENABLED",
  "SECRETS_EPOCH",
];

/** Keys that may take their value from a GitHub Actions secret (historical; not sensitive). */
const SECRET_SOURCED_KEYS = new Set(["AWS_REGION", "LOG_LEVEL"]);

/** Application secrets that moved to SSM and must never reappear in the workflow. */
const RETIRED_SECRETS = ["GH_APP_PRIVATE_KEY", "GH_WEBHOOK_SECRET", "DISCORD_WEBHOOK_URL"];

export const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /discord(?:app)?\.com\/api\/webhooks\/\d+\/[^\s"']+/i,
];

const indentOf = (line: string) => line.length - line.trimStart().length;

/** The `env:` map of the step named "CDK Deploy", or null if it cannot be found. */
export function deployStepEnv(workflow: string): Record<string, string> | null {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*-\s+name:\s*["']?CDK Deploy["']?\s*$/.test(l));
  if (start === -1) return null;
  const stepIndent = indentOf(lines[start]);

  let envIndent = -1;
  const env: Record<string, string> = {};
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = indentOf(line);
    if (indent <= stepIndent) break; // next step or end of the steps list
    if (envIndent === -1) {
      if (/^\s*env:\s*$/.test(line)) envIndent = indent;
      continue;
    }
    if (indent <= envIndent) break; // left the env block
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!m) throw new Error(`Unparseable env line in the CDK Deploy step: ${line.trim()}`);
    env[m[1]] = m[2].trim();
  }
  return envIndent === -1 ? null : env;
}

export function checkWorkflow(workflow: string): string[] {
  const problems: string[] = [];
  let env: Record<string, string> | null;
  try {
    env = deployStepEnv(workflow);
  } catch (error) {
    return [(error as Error).message];
  }
  if (!env) return ['Could not find the "CDK Deploy" step and its env block'];

  for (const [key, value] of Object.entries(env)) {
    if (!DEPLOY_ENV_ALLOWLIST.includes(key)) problems.push(`Key not allowlisted for the CDK deploy step: ${key}`);
    if (SECRET_VALUE_PATTERNS.some((p) => p.test(value))) problems.push(`Value of ${key} looks like a secret`);
    if (/\$\{\{\s*secrets\./.test(value) && !SECRET_SOURCED_KEYS.has(key)) {
      problems.push(`${key} must not be sourced from a GitHub Actions secret`);
    }
  }
  for (const name of RETIRED_SECRETS) {
    if (new RegExp(`secrets\\.${name}\\b`).test(workflow)) {
      problems.push(`Workflow references the retired secret ${name} (application secrets live in SSM)`);
    }
  }
  return problems;
}

function main(): void {
  const file = process.argv[2] ?? path.resolve(__dirname, "../.github/workflows/deploy.yml");
  const problems = checkWorkflow(fs.readFileSync(file, "utf8"));
  if (problems.length > 0) {
    problems.forEach((p) => console.error(`deploy env allowlist: ${p}`));
    process.exitCode = 1;
    return;
  }
  console.log("deploy env allowlist: OK");
}

if (require.main === module) main();
