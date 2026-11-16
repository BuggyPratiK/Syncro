/**
 * The deploy-workflow allowlist check.
 */

import * as fs from "fs";
import * as path from "path";
import { checkWorkflow, deployStepEnv } from "../../scripts/check-deploy-env-allowlist";

const real = fs.readFileSync(path.resolve(__dirname, "../../.github/workflows/deploy.yml"), "utf8");

function workflow(envLines: string[], extraSteps = ""): string {
  return [
    "jobs:",
    "  deploy:",
    "    steps:",
    "      - name: Checkout",
    "        uses: actions/checkout@v4",
    extraSteps,
    "      - name: CDK Deploy",
    "        run: npm run cdk:deploy",
    "        env:",
    ...envLines.map((l) => `          ${l}`),
    "      - name: After",
    "        run: echo done",
  ].join("\n");
}

describe("deploy env allowlist check", () => {
  it("accepts the repository's Deploy workflow", () => {
    expect(checkWorkflow(real)).toEqual([]);
    expect(Object.keys(deployStepEnv(real)!).sort()).toEqual(["AWS_REGION", "GITHUB_APP_ID", "LOG_LEVEL", "SECRETS_EPOCH"]);
  });

  it("reads only the CDK Deploy step's env block", () => {
    const wf = workflow(["GITHUB_APP_ID: ${{ vars.GH_APP_ID }}", "# a comment", ""]);
    expect(deployStepEnv(wf)).toEqual({ GITHUB_APP_ID: "${{ vars.GH_APP_ID }}" });
  });

  it.each([
    ["a non-allowlisted key", ["GITHUB_APP_PRIVATE_KEY: ${{ vars.X }}"], "Key not allowlisted"],
    ["the global Discord URL", ["DISCORD_WEBHOOK_URL: x"], "Key not allowlisted"],
    ["a legacy compatibility variable", ["LEGACY_COMPAT_ENABLED: ${{ vars.LEGACY_COMPAT_ENABLED }}"], "Key not allowlisted"],
    ["an allowlisted key sourced from a secret", ["GITHUB_APP_ID: ${{ secrets.GH_APP_ID }}"], "must not be sourced from a GitHub Actions secret"],
    ["a PEM literal", ["SECRETS_EPOCH: -----BEGIN RSA PRIVATE KEY-----"], "looks like a secret"],
    ["a GitHub token literal", ["SECRETS_EPOCH: ghs_abcdefghijklmnopqrstuvwxyz0123"], "looks like a secret"],
    ["a Discord webhook URL literal", ["CORS_ORIGIN: https://discord.com/api/webhooks/123/token"], "looks like a secret"],
  ])("rejects %s", (_label, envLines, message) => {
    expect(checkWorkflow(workflow(envLines)).join("\n")).toContain(message);
  });

  it("rejects a retired secret referenced anywhere in the workflow", () => {
    const step = "      - name: Leak\n        run: echo ${{ secrets.GH_APP_PRIVATE_KEY }}";
    expect(checkWorkflow(workflow(["GITHUB_APP_ID: ${{ vars.GH_APP_ID }}"], step)).join("\n")).toContain("retired secret GH_APP_PRIVATE_KEY");
  });

  it("allows AWS_REGION and LOG_LEVEL from secrets (non-sensitive, historical)", () => {
    expect(checkWorkflow(workflow(["AWS_REGION: ${{ secrets.AWS_REGION || 'ap-southeast-2' }}", "LOG_LEVEL: ${{ secrets.LOG_LEVEL || 'info' }}"]))).toEqual([]);
  });

  it("fails when the step or its env block is missing, or a line cannot be parsed", () => {
    expect(checkWorkflow("jobs:\n  deploy:\n    steps: []\n")).toEqual(['Could not find the "CDK Deploy" step and its env block']);
    expect(checkWorkflow(workflow([]).replace("        env:\n", ""))[0]).toContain("Could not find");
    expect(checkWorkflow(workflow(["not a key value line"]))[0]).toContain("Unparseable env line");
  });

  it("the workflow loads no credentials before the allowlist and cutover gates", () => {
    const order = ["Deploy env allowlist check", "Tenant cutover readiness gate", "Configure AWS credentials", "CDK Deploy"].map((n) =>
      real.indexOf(`- name: ${n}`),
    );
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(real).toMatch(/TENANT_CUTOVER_READY: \$\{\{ vars\.TENANT_CUTOVER_READY \}\}/);
    expect(real).toMatch(/!= "confirmed"/);
  });
});
