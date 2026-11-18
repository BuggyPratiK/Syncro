/**
 * Dashboard API construct: an HTTP API (separate from the webhook REST API),
 * the dashboard Lambda and its own IAM role.
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
 * - No KMS Allow and no customer-managed key. One KMS Deny blocks decrypting
 *   any destination parameter, so URLs stay unreadable even if an SSM read
 *   permission were added by mistake or the AWS-managed key policy changed.
 * IAM cannot limit `PutParameter` to the caller's own workspace path (the
 * path wildcard spans workspaces), so the application derives every parameter
 * name server-side from the verified workspace and an owned destination.
 */

import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
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

/** Stage-wide throttle for all clients combined; API Gateway answers 429 above it. */
export const DASHBOARD_STAGE_THROTTLE = { rateLimit: 20, burstLimit: 40 } as const;

/** Tighter per-route throttle for routes that call GitHub or write secrets. */
export const DASHBOARD_ROUTE_THROTTLE = { rateLimit: 2, burstLimit: 5 } as const;

type RouteMethod = "GET" | "POST" | "PATCH" | "PUT";
const WS = "/api/workspaces/{workspaceId}";

/**
 * The only routes the HTTP API exposes; any other path is rejected by API
 * Gateway before the Lambda runs. Must match the application's route table
 * (a test checks they agree; infra code cannot import application code).
 */
export const DASHBOARD_ROUTES: ReadonlyArray<{ method: RouteMethod; path: string; routeThrottle: boolean }> = [
  { method: "GET", path: "/api/me", routeThrottle: false },
  { method: "POST", path: "/api/me/bootstrap", routeThrottle: true },
  { method: "POST", path: `${WS}/github/install-url`, routeThrottle: true },
  { method: "POST", path: `${WS}/github/claim`, routeThrottle: true },
  { method: "POST", path: `${WS}/github/authorize-url`, routeThrottle: true },
  { method: "POST", path: `${WS}/github/repo-listing`, routeThrottle: true },
  { method: "GET", path: `${WS}/installations`, routeThrottle: false },
  { method: "GET", path: `${WS}/repos`, routeThrottle: false },
  { method: "POST", path: `${WS}/repos`, routeThrottle: false },
  { method: "PATCH", path: `${WS}/repos/{repoId}`, routeThrottle: false },
  { method: "GET", path: `${WS}/destinations`, routeThrottle: false },
  { method: "POST", path: `${WS}/destinations`, routeThrottle: true },
  { method: "PATCH", path: `${WS}/destinations/{destinationId}`, routeThrottle: true },
  { method: "PUT", path: `${WS}/destinations/{destinationId}/webhook`, routeThrottle: true },
  { method: "GET", path: `${WS}/deliveries`, routeThrottle: false },
];

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
  public readonly api: apigwv2.HttpApi;

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
    // Parameter Store decrypts SecureStrings with the parameter's ARN as the
    // encryption context, so this denies reading destination URLs while leaving
    // writes (Encrypt/GenerateDataKey) and the OAuth secret's decryption alone.
    // The key ID of `aws/ssm` differs per account, so the resource is every key
    // in this account and Region; a Deny that wide grants nothing.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: "DenyDecryptDestinationSecrets",
        effect: iam.Effect.DENY,
        actions: ["kms:Decrypt"],
        resources: [stack.formatArn({ service: "kms", resource: "key", resourceName: "*" })],
        conditions: {
          StringLike: {
            "kms:EncryptionContext:PARAMETER_ARN": parameterArn(DASHBOARD_DESTINATION_PARAM_PATTERN),
          },
        },
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
      // The AWS SDK is bundled so production runs the pinned, tested version.
      bundling: { minify: true, sourceMap: true, target: "node24", bundleAwsSDK: true },
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

    // Browsers may call only from the dashboard's own origin. Requests carry a
    // bearer token, never cookies, so credentials stay disallowed.
    this.api = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: "syncro-dashboard-api",
      description: "Syncro dashboard API",
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: [props.corsOrigin],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PATCH,
          apigwv2.CorsHttpMethod.PUT,
        ],
        allowHeaders: ["authorization", "content-type"],
        exposeHeaders: ["retry-after"],
        allowCredentials: false,
        maxAge: cdk.Duration.minutes(10),
      },
    });

    const integration = new HttpLambdaIntegration("Integration", this.fn, {
      payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
    });
    const routes = DASHBOARD_ROUTES.flatMap((r) =>
      this.api.addRoutes({ path: r.path, methods: [apigwv2.HttpMethod[r.method]], integration }),
    );

    const stage = new apigwv2.HttpStage(this, "Stage", {
      httpApi: this.api,
      stageName: "$default",
      autoDeploy: true,
      throttle: DASHBOARD_STAGE_THROTTLE,
    });
    // Per-route throttles are only available on the underlying CloudFormation stage.
    const cfnStage = stage.node.defaultChild as apigwv2.CfnStage;
    cfnStage.routeSettings = Object.fromEntries(
      DASHBOARD_ROUTES.filter((r) => r.routeThrottle).map((r) => [
        `${r.method} ${r.path}`,
        {
          ThrottlingRateLimit: DASHBOARD_ROUTE_THROTTLE.rateLimit,
          ThrottlingBurstLimit: DASHBOARD_ROUTE_THROTTLE.burstLimit,
        },
      ]),
    );
    // Route settings name routes by key, so the routes must exist first.
    for (const route of routes) stage.node.addDependency(route);

    new cdk.CfnOutput(this, "Url", {
      value: this.api.apiEndpoint,
      description: "Dashboard API base URL",
    });
  }
}
