/**
 * Dashboard API construct: the dashboard Lambda and its own IAM role.
 *
 * Instantiated by `SyncroStack` only when the dashboard is enabled; with the
 * flag off, none of these resources exist.
 *
 * Permission model for stored secrets (SSM SecureString, AWS-managed `aws/ssm` key):
 * - Discord destination URLs: `ssm:PutParameter` only. This function can store
 *   a URL but never read one back: no GetParameter(s), history, describe or
 *   by-path access on destination parameters.
 * - Its own GitHub OAuth client secret: `ssm:GetParameter` on that one name.
 * - Nothing under the sender's namespace (GitHub App private key, webhook secret).
 * - No KMS statement and no customer-managed key.
 * IAM cannot limit `PutParameter` to the caller's own workspace path (the
 * path wildcard spans workspaces), so the application derives every parameter
 * name server-side from the verified workspace and an owned destination.
 */

import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

/** Must match `SSM_PARAM_PREFIX` in `syncro-stack.ts` and the application's name derivation. */
const PREFIX = "/syncro/prod";

/** The dashboard's only readable secret. */
export const DASHBOARD_PARAMS = {
  githubOAuthClientSecret: `${PREFIX}/dashboard/github-oauth-client-secret`,
} as const;

/** Destination URL parameters (write-only for this function). */
export const DASHBOARD_DESTINATION_PARAM_PATTERN = `${PREFIX}/ws/*/dest/*/discord-webhook-url`;

/**
 * DynamoDB actions the dashboard's data operations use. Transactions are
 * authorized per item, so `TransactWriteItems` needs Put/Update/Delete/ConditionCheck.
 * Deliberately absent: Scan, BatchWriteItem, PartiQL, table management.
 */
export const DASHBOARD_DYNAMODB_ACTIONS = [
  "dynamodb:GetItem",
  "dynamodb:BatchGetItem",
  "dynamodb:Query",
  "dynamodb:PutItem",
  "dynamodb:UpdateItem",
  "dynamodb:DeleteItem",
  "dynamodb:ConditionCheckItem",
] as const;

export interface DashboardApiProps {
  table: dynamodb.ITable;
  githubAppId: string;
  githubAppClientId: string;
  githubAppSlug: string;
  logtoIssuer: string;
  logtoJwksUri: string;
  apiAudience: string;
  logtoSpaClientId: string;
  /** Exact browser origin of the dashboard; never a wildcard. */
  corsOrigin: string;
  logLevel?: "debug" | "info" | "warn" | "error";
  secretsEpoch?: string;
}

const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/;

/** Synth-time checks mirroring the application's dashboard env schema; never echoes values. */
function validate(props: DashboardApiProps): void {
  const checks: Array<[string, boolean]> = [
    ["githubAppId", /^[1-9][0-9]{0,18}$/.test(props.githubAppId)],
    ["githubAppClientId", /^[A-Za-z0-9.]{1,64}$/.test(props.githubAppClientId)],
    ["githubAppSlug", /^[a-z0-9][a-z0-9-]{0,99}$/.test(props.githubAppSlug)],
    ["logtoIssuer", HTTPS_URL.test(props.logtoIssuer)],
    ["logtoJwksUri", HTTPS_URL.test(props.logtoJwksUri)],
    ["apiAudience", props.apiAudience.length >= 1 && props.apiAudience.length <= 256],
    ["logtoSpaClientId", /^[A-Za-z0-9_-]{1,64}$/.test(props.logtoSpaClientId)],
    // Deployed dashboards are https only; localhost is for the local runner, never CDK.
    ["corsOrigin", /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(props.corsOrigin)],
    ["secretsEpoch", props.secretsEpoch === undefined || /^[A-Za-z0-9._:-]{1,64}$/.test(props.secretsEpoch)],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (bad.length > 0) throw new Error(`DashboardApi: invalid configuration: ${bad.join(", ")}`);
}

export class DashboardApi extends Construct {
  public readonly fn: lambdaNodejs.NodejsFunction;
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: DashboardApiProps) {
    super(scope, id);
    validate(props);
    const stack = cdk.Stack.of(this);

    const logGroup = new logs.LogGroup(this, "Logs", {
      logGroupName: "/syncro/dashboard-api",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Own role with no managed policies: every permission is listed below.
    this.role = new iam.Role(this, "Role", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Syncro dashboard API: write-only access to destination secrets",
    });

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WriteOwnLogs",
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [logGroup.logGroupArn],
      }),
    );

    const tableResources = [props.table.tableArn, `${props.table.tableArn}/index/*`];
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "TableAccess",
        actions: [...DASHBOARD_DYNAMODB_ACTIONS],
        resources: tableResources,
      }),
    );
    // Old global destination items (which held plaintext URLs) are never touchable.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "DenyLegacyDestinationItems",
        effect: iam.Effect.DENY,
        actions: ["dynamodb:*"],
        resources: tableResources,
        conditions: { "ForAnyValue:StringLike": { "dynamodb:LeadingKeys": ["DESTINATION#*"] } },
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "DenyScan",
        effect: iam.Effect.DENY,
        actions: ["dynamodb:Scan"],
        resources: tableResources,
      }),
    );

    const parameterArn = (name: string) =>
      stack.formatArn({ service: "ssm", resource: "parameter", resourceName: name.replace(/^\//, "") });

    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "WriteDestinationSecrets",
        actions: ["ssm:PutParameter"],
        resources: [parameterArn(DASHBOARD_DESTINATION_PARAM_PATTERN)],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadOwnOAuthClientSecret",
        actions: ["ssm:GetParameter"],
        resources: [parameterArn(DASHBOARD_PARAMS.githubOAuthClientSecret)],
      }),
    );

    // Environment: non-secret values and the NAME of the OAuth secret only.
    this.fn = new lambdaNodejs.NodejsFunction(this, "Handler", {
      functionName: "syncro-dashboard-api",
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: "src/dashboard/handler.ts",
      handler: "handler",
      memorySize: 256,
      // Claim makes several sequential GitHub calls (3 s timeout each); stays under the HTTP API's 30 s limit.
      timeout: cdk.Duration.seconds(25),
      role: this.role,
      logGroup,
      bundling: { minify: true, sourceMap: true, target: "node24" },
      environment: {
        LOG_LEVEL: props.logLevel ?? "info",
        DYNAMODB_TABLE_NAME: props.table.tableName,
        SSM_PARAM_PREFIX: PREFIX,
        GITHUB_OAUTH_CLIENT_SECRET_PARAM: DASHBOARD_PARAMS.githubOAuthClientSecret,
        GITHUB_APP_ID: props.githubAppId,
        GITHUB_APP_CLIENT_ID: props.githubAppClientId,
        GITHUB_APP_SLUG: props.githubAppSlug,
        LOGTO_ISSUER: props.logtoIssuer,
        LOGTO_JWKS_URI: props.logtoJwksUri,
        API_AUDIENCE: props.apiAudience,
        LOGTO_SPA_CLIENT_ID: props.logtoSpaClientId,
        CORS_ORIGIN: props.corsOrigin,
        ...(props.secretsEpoch ? { SECRETS_EPOCH: props.secretsEpoch } : {}),
      },
    });
  }
}
