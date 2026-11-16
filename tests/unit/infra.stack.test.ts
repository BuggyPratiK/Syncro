/**
 * Infrastructure assertions on the synthesized CloudFormation template.
 * Bundling is disabled, so no Lambda code is built and nothing touches AWS.
 */

import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import {
  DESTINATION_PARAM_PATTERN,
  SENDER_PARAMS,
  SSM_PARAM_PREFIX,
  SyncroStack,
  type SyncroStackProps,
} from "../../infra/lib/syncro-stack";
import { deriveDestinationParamName, senderParamNames } from "../../src/secrets/param-names";
import { parseWebhookEnv } from "../../src/config/env";
import { SECRET_VALUE_PATTERNS } from "../../scripts/check-deploy-env-allowlist";
import { TABLE_SCHEMA } from "../ddb-local/harness";

const ENV = { account: "123456789012", region: "ap-southeast-2" };

function synth(props: Partial<SyncroStackProps> = {}) {
  const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
  const stack = new SyncroStack(app, "TestStack", { env: ENV, githubAppId: "123456", ...props });
  return { stack, template: Template.fromStack(stack) };
}

type Statement = { Action: string | string[]; Resource?: unknown; Effect: string; Condition?: unknown };

function allStatements(template: Template): Statement[] {
  const policies = template.findResources("AWS::IAM::Policy");
  return Object.values(policies).flatMap(
    (p) => (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement,
  );
}

const actionsOf = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);

function lambdaEnv(template: Template): Record<string, unknown> {
  const fns = Object.values(template.findResources("AWS::Lambda::Function")) as Array<{
    Properties: { FunctionName?: string; Environment?: { Variables: Record<string, unknown> } };
  }>;
  const fn = fns.find((f) => f.Properties.FunctionName === "syncro-webhook-handler");
  return fn!.Properties.Environment!.Variables;
}

describe("SyncroStack", () => {
  const { stack, template } = synth({ secretsEpoch: "2026-11-16.1" });

  it("protects the table from deletion and keeps it on stack removal", () => {
    template.hasResource("AWS::DynamoDB::Table", {
      Properties: { DeletionProtectionEnabled: true, TableName: "syncro" },
      DeletionPolicy: "Retain",
    });
  });

  it("exposes the table for later constructs", () => {
    expect(stack.table).toBeDefined();
  });

  it("creates no customer-managed KMS key", () => {
    template.resourceCountIs("AWS::KMS::Key", 0);
    template.resourceCountIs("AWS::KMS::Alias", 0);
  });

  it("gives the sender ssm:GetParameter on exactly the two sender secrets and the destination pattern", () => {
    const ssm = allStatements(template).filter((s) => actionsOf(s).some((a) => a.startsWith("ssm:")));
    expect(ssm).toHaveLength(1);
    expect(actionsOf(ssm[0])).toEqual(["ssm:GetParameter"]);
    const resources = JSON.stringify(ssm[0].Resource);
    expect(resources).toContain(":parameter/syncro/prod/sender/github-app-private-key");
    expect(resources).toContain(":parameter/syncro/prod/sender/github-webhook-secret");
    expect(resources).toContain(":parameter/syncro/prod/ws/*/dest/*/discord-webhook-url");
    expect((ssm[0].Resource as unknown[]).length).toBe(3);
    expect(resources).not.toContain("dashboard");
  });

  it("never grants ssm:PutParameter or any write to SSM", () => {
    const actions = allStatements(template).flatMap(actionsOf);
    expect(actions.filter((a) => /^ssm:(Put|Delete|Label|AddTags|\*)/.test(a))).toEqual([]);
  });

  it("has no KMS permissions (aws/ssm decrypts through Parameter Store)", () => {
    expect(allStatements(template).flatMap(actionsOf).filter((a) => a.startsWith("kms:"))).toEqual([]);
  });

  it("puts only non-secret, allowlisted settings in the Lambda environment, and they satisfy the webhook schema", () => {
    const env = lambdaEnv(template);
    expect(Object.keys(env).sort()).toEqual(
      ["DYNAMODB_TABLE_NAME", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY_PARAM", "GITHUB_WEBHOOK_SECRET_PARAM", "LOG_LEVEL", "SECRETS_EPOCH", "SSM_PARAM_PREFIX"].sort(),
    );
    for (const k of ["DISCORD_WEBHOOK_URL", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "LEGACY_COMPAT_ENABLED"]) {
      expect(env).not.toHaveProperty(k);
    }
    // The table name is a CloudFormation reference here; substitute a value to validate the rest.
    const asStrings = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, typeof v === "string" ? v : "syncro"]));
    expect(() => parseWebhookEnv(asStrings)).not.toThrow();
  });

  it("keeps the Lambda environment well under the 4 KB limit", () => {
    const env = lambdaEnv(template);
    const bytes = Object.entries(env).reduce((n, [k, v]) => n + k.length + (typeof v === "string" ? v.length : 64), 0);
    expect(bytes).toBeLessThan(1024);
  });

  it("the DynamoDB Local test table has the same schema as the production table", () => {
    const table = Object.values(template.findResources("AWS::DynamoDB::Table"))[0] as { Properties: Record<string, unknown> };
    const p = table.Properties as {
      BillingMode: string;
      KeySchema: unknown[];
      AttributeDefinitions: Array<{ AttributeName: string }>;
      GlobalSecondaryIndexes: unknown[];
      TimeToLiveSpecification: { AttributeName: string; Enabled: boolean };
    };
    const byName = (a: { AttributeName?: string }, b: { AttributeName?: string }) => String(a.AttributeName).localeCompare(String(b.AttributeName));
    expect(p.BillingMode).toBe(TABLE_SCHEMA.BillingMode);
    expect(p.KeySchema).toEqual(TABLE_SCHEMA.KeySchema);
    expect([...p.AttributeDefinitions].sort(byName)).toEqual([...(TABLE_SCHEMA.AttributeDefinitions ?? [])].sort(byName));
    expect(p.GlobalSecondaryIndexes).toEqual(TABLE_SCHEMA.GlobalSecondaryIndexes);
    // TTL is not part of CreateTable; DynamoDB Local tests check expiry explicitly instead of relying on deletion.
    expect(p.TimeToLiveSpecification).toEqual({ AttributeName: "ttl", Enabled: true });
  });

  it("contains no secret-looking value anywhere in the template", () => {
    const json = JSON.stringify(template.toJSON());
    for (const p of SECRET_VALUE_PATTERNS) expect(json).not.toMatch(p);
  });

  it("keeps the webhook API routes unchanged: POST /webhooks/github and GET /health only", () => {
    const parts = Object.values(template.findResources("AWS::ApiGateway::Resource")).map(
      (r) => (r as { Properties: { PathPart: string } }).Properties.PathPart,
    );
    expect(parts.sort()).toEqual(["github", "health", "webhooks"]);
    const methods = Object.values(template.findResources("AWS::ApiGateway::Method"))
      .map((m) => (m as { Properties: { HttpMethod: string } }).Properties.HttpMethod)
      .filter((m) => m !== "OPTIONS");
    expect(methods.sort()).toEqual(["GET", "POST"]);
  });
});

describe("SyncroStack configuration", () => {
  it("uses the same SSM names as the application", () => {
    expect(SSM_PARAM_PREFIX).toBe("/syncro/prod");
    expect(SENDER_PARAMS).toEqual(senderParamNames(SSM_PARAM_PREFIX));
    const sample = deriveDestinationParamName("ws_11111111-1111-4111-8111-111111111111", "8c0e6f1a-2b3c-4d5e-8f90-a1b2c3d4e5f6", SSM_PARAM_PREFIX);
    const pattern = new RegExp(`^${DESTINATION_PARAM_PATTERN.replace(/[.]/g, "\\.").replace(/\*/g, "[^/]+")}$`);
    expect(sample).toMatch(pattern);
  });

  it.each(["", "abc", "0123"])("refuses to synthesize with an invalid GitHub App ID (%p)", (githubAppId) => {
    expect(() => synth({ githubAppId })).toThrow("githubAppId");
  });

  it("refuses an invalid secrets epoch and omits it when unset", () => {
    expect(() => synth({ secretsEpoch: "has space" })).toThrow("secretsEpoch");
    expect(lambdaEnv(synth().template)).not.toHaveProperty("SECRETS_EPOCH");
  });
});
