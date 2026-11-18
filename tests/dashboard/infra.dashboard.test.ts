/**
 * Permission assertions for the dashboard and sender roles on the synthesized
 * template. Bundling is disabled, so no Lambda code is built and nothing
 * touches AWS.
 *
 * Model under test (stored Discord webhook URLs in SSM):
 *   dashboard: put destination parameters; never read them; read only its own OAuth secret
 *   sender:    read destination parameters and its two secrets; never write
 *   neither:   KMS statements or a customer-managed key
 */

import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { SyncroStack, type SyncroStackProps } from "../../infra/lib/syncro-stack";
import {
  DASHBOARD_DESTINATION_PARAM_PATTERN,
  DASHBOARD_DYNAMODB_ACTIONS,
  DASHBOARD_PARAMS,
} from "../../infra/lib/dashboard";
import { dashboardParamNames, deriveDestinationParamName } from "../../src/secrets/param-names";
import { dashboardEnvSchema, parseDashboardEnv } from "../../src/config/env";
import { SECRET_VALUE_PATTERNS } from "../../scripts/check-deploy-env-allowlist";

const ENV = { account: "123456789012", region: "ap-southeast-2" };

const DASHBOARD_CONFIG: NonNullable<SyncroStackProps["dashboard"]> = {
  githubAppClientId: "Iv23liTestClient01",
  githubAppSlug: "syncro-test",
  logtoIssuer: "https://tenant.logto.app/oidc",
  logtoJwksUri: "https://tenant.logto.app/oidc/jwks",
  apiAudience: "https://api.syncro.test",
  logtoSpaClientId: "spaclientid01",
  corsOrigin: "https://syncro.vercel.app",
};

function synth(props: Partial<SyncroStackProps> = {}) {
  const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
  const stack = new SyncroStack(app, "TestStack", { env: ENV, githubAppId: "123456", ...props });
  return Template.fromStack(stack);
}

type Statement = { Sid?: string; Action: string | string[]; Resource?: unknown; Effect: string; Condition?: unknown };
type PolicyResource = { Properties: { PolicyDocument: { Statement: Statement[] }; Roles: Array<{ Ref: string }> } };

const actionsOf = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const resourcesOf = (s: Statement) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]);

/** Logical ID of the role whose ID contains `fragment`. */
function roleId(template: Template, fragment: string): string {
  const ids = Object.keys(template.findResources("AWS::IAM::Role")).filter((id) => id.includes(fragment));
  expect(ids).toHaveLength(1);
  return ids[0];
}

/** Every inline-policy statement attached to the role. */
function statementsOf(template: Template, role: string): Statement[] {
  return (Object.values(template.findResources("AWS::IAM::Policy")) as PolicyResource[])
    .filter((p) => p.Properties.Roles.some((r) => r.Ref === role))
    .flatMap((p) => p.Properties.PolicyDocument.Statement);
}

/** Flattens a CloudFormation `Fn::Join` ARN to a comparable string. */
function arnText(resource: unknown): string {
  const join = (resource as { "Fn::Join"?: [string, unknown[]] })?.["Fn::Join"];
  if (!join) return JSON.stringify(resource);
  return join[1].map((part) => (typeof part === "string" ? part : "<ref>")).join(join[0]);
}

function lambdaByName(template: Template, name: string) {
  const fns = Object.values(template.findResources("AWS::Lambda::Function")) as Array<{
    Properties: { FunctionName?: string; Runtime: string; Role: unknown; Environment?: { Variables: Record<string, unknown> } };
  }>;
  return fns.find((f) => f.Properties.FunctionName === name);
}

describe("dashboard flag", () => {
  it("creates no dashboard resources when the dashboard is disabled", () => {
    const off = synth();
    expect(lambdaByName(off, "syncro-dashboard-api")).toBeUndefined();
    expect(Object.keys(off.findResources("AWS::IAM::Role")).filter((id) => id.includes("Dashboard"))).toEqual([]);
    expect(JSON.stringify(off.toJSON())).not.toContain("dashboard");
  });

  it("adds only the dashboard function, its role and log group when enabled", () => {
    const off = synth().toJSON().Resources as Record<string, { Type: string }>;
    const on = synth({ dashboard: DASHBOARD_CONFIG }).toJSON().Resources as Record<string, { Type: string }>;
    const added = Object.keys(on).filter((id) => !(id in off));
    expect(added.every((id) => id.startsWith("Dashboard"))).toBe(true);
    // Existing resources are unchanged.
    for (const id of Object.keys(off)) expect(on[id]).toEqual(off[id]);
  });

  it("refuses an invalid dashboard configuration without echoing values", () => {
    expect(() => synth({ dashboard: { ...DASHBOARD_CONFIG, corsOrigin: "*" } })).toThrow(/corsOrigin/);
    expect(() => synth({ dashboard: { ...DASHBOARD_CONFIG, corsOrigin: "http://localhost:5173" } })).toThrow(/corsOrigin/);
    expect(() => synth({ dashboard: { ...DASHBOARD_CONFIG, logtoIssuer: "http://tenant.logto.app/oidc" } })).toThrow(/logtoIssuer/);
  });
});

describe("dashboard role", () => {
  const template = synth({ dashboard: DASHBOARD_CONFIG, secretsEpoch: "2026-11-18.1" });
  const role = roleId(template, "DashboardRole");
  const statements = statementsOf(template, role);
  const allows = statements.filter((s) => s.Effect === "Allow");
  const allowedActions = allows.flatMap(actionsOf);

  it("is the dashboard function's own role, with no managed policies", () => {
    const fn = lambdaByName(template, "syncro-dashboard-api")!;
    expect(fn.Properties.Role).toEqual({ "Fn::GetAtt": [role, "Arn"] });
    const r = template.findResources("AWS::IAM::Role")[role] as { Properties: { ManagedPolicyArns?: unknown } };
    expect(r.Properties.ManagedPolicyArns).toBeUndefined();
  });

  it("can put destination parameters and nothing else on the destination path", () => {
    const put = allows.filter((s) => actionsOf(s).includes("ssm:PutParameter"));
    expect(put).toHaveLength(1);
    expect(actionsOf(put[0])).toEqual(["ssm:PutParameter"]);
    expect(resourcesOf(put[0]).map(arnText)).toEqual([
      `arn:<ref>:ssm:ap-southeast-2:123456789012:parameter${DASHBOARD_DESTINATION_PARAM_PATTERN}`,
    ]);
  });

  it("can read only its own OAuth client secret", () => {
    const get = allows.filter((s) => actionsOf(s).includes("ssm:GetParameter"));
    expect(get).toHaveLength(1);
    expect(actionsOf(get[0])).toEqual(["ssm:GetParameter"]);
    expect(resourcesOf(get[0]).map(arnText)).toEqual([
      `arn:<ref>:ssm:ap-southeast-2:123456789012:parameter${DASHBOARD_PARAMS.githubOAuthClientSecret}`,
    ]);
  });

  it("has exactly those two SSM permissions: no reads, history, describe or wildcards", () => {
    expect(allowedActions.filter((a) => a.startsWith("ssm:")).sort()).toEqual(["ssm:GetParameter", "ssm:PutParameter"]);
    for (const a of ["ssm:GetParameters", "ssm:GetParameterHistory", "ssm:GetParametersByPath", "ssm:DescribeParameters", "ssm:*"]) {
      expect(allowedActions).not.toContain(a);
    }
  });

  it("has no access to the sender's secrets", () => {
    expect(JSON.stringify(statements)).not.toContain("/sender/");
  });

  it("has no KMS, Lambda or CloudFormation permissions and no customer-managed key exists", () => {
    expect(allowedActions.filter((a) => /^(kms|lambda|cloudformation):/i.test(a))).toEqual([]);
    template.resourceCountIs("AWS::KMS::Key", 0);
    template.resourceCountIs("AWS::KMS::Alias", 0);
  });

  it("never grants an action or resource wildcard", () => {
    for (const s of allows) {
      expect(actionsOf(s).some((a) => a === "*" || a.endsWith(":*"))).toBe(false);
      expect(resourcesOf(s)).not.toContain("*");
    }
  });

  it("uses explicit DynamoDB actions on the table and its indexes, never Scan", () => {
    const ddb = allows.filter((s) => actionsOf(s).some((a) => a.startsWith("dynamodb:")));
    expect(ddb).toHaveLength(1);
    expect([...actionsOf(ddb[0])].sort()).toEqual([...DASHBOARD_DYNAMODB_ACTIONS].sort());
    expect(allowedActions).not.toContain("dynamodb:Scan");
    expect(JSON.stringify(ddb[0].Resource)).toContain("/index/*");
  });

  it("explicitly denies Scan and every access to legacy DESTINATION# items", () => {
    const denies = statements.filter((s) => s.Effect === "Deny");
    expect(denies.some((s) => actionsOf(s).includes("dynamodb:Scan") && s.Condition === undefined)).toBe(true);
    const legacy = denies.find((s) => actionsOf(s).includes("dynamodb:*"));
    expect(legacy?.Condition).toEqual({ "ForAnyValue:StringLike": { "dynamodb:LeadingKeys": ["DESTINATION#*"] } });
  });

  it("writes only to its own log group", () => {
    const logs = allows.filter((s) => actionsOf(s).some((a) => a.startsWith("logs:")));
    expect(logs).toHaveLength(1);
    expect([...actionsOf(logs[0])].sort()).toEqual(["logs:CreateLogStream", "logs:PutLogEvents"]);
    expect(JSON.stringify(logs[0].Resource)).toContain("DashboardLogs");
  });

  it("runs on Node 24 with only non-secret settings that satisfy the dashboard env schema", () => {
    const fn = lambdaByName(template, "syncro-dashboard-api")!;
    expect(fn.Properties.Runtime).toBe("nodejs24.x");
    const env = fn.Properties.Environment!.Variables;
    const schemaKeys = Object.keys((dashboardEnvSchema as unknown as { _def: { schema: { shape: object } } })._def.schema.shape);
    for (const k of Object.keys(env)) expect(schemaKeys).toContain(k);
    const asStrings = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, typeof v === "string" ? v : "syncro"]));
    expect(() => parseDashboardEnv(asStrings)).not.toThrow();
    const json = JSON.stringify(env);
    for (const p of SECRET_VALUE_PATTERNS) expect(json).not.toMatch(p);
  });
});

describe("sender role with the dashboard enabled", () => {
  const template = synth({ dashboard: DASHBOARD_CONFIG });
  const statements = statementsOf(template, roleId(template, "SyncroHandlerServiceRole"));
  const actions = statements.flatMap(actionsOf);

  it("reads exactly its two secrets and destination parameters", () => {
    const ssm = statements.filter((s) => actionsOf(s).some((a) => a.startsWith("ssm:")));
    expect(ssm).toHaveLength(1);
    expect(actionsOf(ssm[0])).toEqual(["ssm:GetParameter"]);
    expect(resourcesOf(ssm[0]).map(arnText).sort()).toEqual(
      [
        "arn:<ref>:ssm:ap-southeast-2:123456789012:parameter/syncro/prod/sender/github-app-private-key",
        "arn:<ref>:ssm:ap-southeast-2:123456789012:parameter/syncro/prod/sender/github-webhook-secret",
        `arn:<ref>:ssm:ap-southeast-2:123456789012:parameter${DASHBOARD_DESTINATION_PARAM_PATTERN}`,
      ].sort(),
    );
  });

  it("can never write, delete or describe parameters, and has no KMS statement", () => {
    expect(actions.filter((a) => /^ssm:(Put|Delete|Label|AddTags|Describe|GetParameterHistory|GetParametersByPath|\*)/.test(a))).toEqual([]);
    expect(actions.filter((a) => a.startsWith("kms:"))).toEqual([]);
  });

  it("cannot read the dashboard's OAuth client secret", () => {
    expect(JSON.stringify(statements)).not.toContain("/dashboard/");
  });
});

describe("parameter names agree with the application", () => {
  it("derives destination names inside the IAM pattern and the OAuth name exactly", () => {
    expect(DASHBOARD_PARAMS).toEqual(dashboardParamNames("/syncro/prod"));
    const name = deriveDestinationParamName(
      "ws_11111111-1111-4111-8111-111111111111",
      "8c0e6f1a-2b3c-4d5e-8f90-a1b2c3d4e5f6",
      "/syncro/prod",
    );
    const pattern = new RegExp(`^${DASHBOARD_DESTINATION_PARAM_PATTERN.replace(/[.]/g, "\\.").replace(/\*/g, "[^/]+")}$`);
    expect(name).toMatch(pattern);
  });
});
