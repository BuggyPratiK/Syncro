/**
 * Syncro CDK Stack
 * Defines all AWS infrastructure: DynamoDB, Lambda, API Gateway, IAM.
 * Uses NodejsFunction with esbuild for self-contained dependency bundling.
 *
 * Secrets never pass through CDK: the Lambda environment holds only
 * non-secret values and the NAMES of SSM SecureString parameters. The
 * function reads the parameters at runtime (encrypted with the AWS-managed
 * `aws/ssm` key; no customer-managed KMS key exists).
 */

import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { DashboardApi, type DashboardApiProps } from "./dashboard";

/** SSM parameter namespace for production secrets. */
export const SSM_PARAM_PREFIX = "/syncro/prod";

/** Secrets read by the webhook sender (created by the operator out of band). */
export const SENDER_PARAMS = {
  githubAppPrivateKey: `${SSM_PARAM_PREFIX}/sender/github-app-private-key`,
  githubWebhookSecret: `${SSM_PARAM_PREFIX}/sender/github-webhook-secret`,
} as const;

/** Per-destination Discord webhook URLs, one parameter per workspace destination. */
export const DESTINATION_PARAM_PATTERN = `${SSM_PARAM_PREFIX}/ws/*/dest/*/discord-webhook-url`;

export interface SyncroStackProps extends cdk.StackProps {
  /** The Syncro GitHub App's numeric ID (not a secret). */
  githubAppId: string;
  logLevel?: "debug" | "info" | "warn" | "error";
  /** Changing this value replaces running containers so they re-read secrets after a rotation. */
  secretsEpoch?: string;
  /** Dashboard API settings. Absent = dashboard disabled: no dashboard resources are created. */
  dashboard?: Omit<DashboardApiProps, "table" | "githubAppId" | "logLevel" | "secretsEpoch">;
}

export class SyncroStack extends cdk.Stack {
  /** The single table, shared with the dashboard construct. */
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: SyncroStackProps) {
    super(scope, id, props);

    // Fail the synth loudly rather than deploy a function that cannot start.
    if (!/^[1-9][0-9]{0,18}$/.test(props.githubAppId)) {
      throw new Error("SyncroStack: githubAppId must be the numeric GitHub App ID (set GITHUB_APP_ID)");
    }
    if (props.secretsEpoch !== undefined && !/^[A-Za-z0-9._:-]{1,64}$/.test(props.secretsEpoch)) {
      throw new Error("SyncroStack: secretsEpoch may only contain letters, digits and . _ : -");
    }

    // DynamoDB Table
    const table = new dynamodb.Table(this, "SyncroTable", {
      tableName: "syncro",
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // Scales to zero - Always Free
      timeToLiveAttribute: "ttl",
      encryption: dynamodb.TableEncryption.AWS_MANAGED, // Explicit server-side encryption at rest
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Never delete table on stack destroy
      deletionProtection: true, // The table cannot be deleted, even by a stack change, until this is turned off
    });
    this.table = table;

    // GSI for listing all repositories by type
    table.addGlobalSecondaryIndex({
      indexName: "type-index",
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "created_at", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // CloudWatch Log Group
    const logGroup = new logs.LogGroup(this, "SyncroLogs", {
      logGroupName: "/syncro/webhook-handler",
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Lambda Function with full dependency bundling via esbuild, including the
    // AWS SDK: production runs the SDK version the lockfile pins and the tests
    // exercised, not the copy the Lambda runtime ships and updates on its own.
    // Environment: non-secret values only (validated at cold start by the
    // webhook env schema); secrets are referenced by SSM parameter name.
    const fn = new lambdaNodejs.NodejsFunction(this, "SyncroHandler", {
      functionName: "syncro-webhook-handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: "src/handler.ts",
      handler: "handler",
      memorySize: 256,
      timeout: cdk.Duration.seconds(15),
      logGroup,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node24",
        bundleAwsSDK: true,
      },
      environment: {
        LOG_LEVEL: props.logLevel ?? "info",
        DYNAMODB_TABLE_NAME: table.tableName,
        GITHUB_APP_ID: props.githubAppId,
        SSM_PARAM_PREFIX,
        GITHUB_APP_PRIVATE_KEY_PARAM: SENDER_PARAMS.githubAppPrivateKey,
        GITHUB_WEBHOOK_SECRET_PARAM: SENDER_PARAMS.githubWebhookSecret,
        ...(props.secretsEpoch ? { SECRETS_EPOCH: props.secretsEpoch } : {}),
      },
    });

    // Grant Lambda read/write access to DynamoDB table
    table.grantReadWriteData(fn);

    // SSM: read-only, and only the sender's two secrets plus destination URLs.
    // No ssm:PutParameter: this function can never write a secret.
    // No KMS statement: the AWS-managed `aws/ssm` key's policy already allows
    // decryption through Parameter Store for principals in this account that
    // may call SSM, so access is governed entirely by ssm:GetParameter here.
    const parameterArn = (name: string) =>
      this.formatArn({
        service: "ssm",
        resource: "parameter",
        resourceName: name.replace(/^\//, ""),
      });
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "ReadSenderAndDestinationSecrets",
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: [
          parameterArn(SENDER_PARAMS.githubAppPrivateKey),
          parameterArn(SENDER_PARAMS.githubWebhookSecret),
          parameterArn(DESTINATION_PARAM_PATTERN),
        ],
      }),
    );

    // API Gateway
    const api = new apigateway.RestApi(this, "SyncroApi", {
      restApiName: "syncro-api",
      description: "Syncro GitHub Webhook Receiver",
      deployOptions: {
        stageName: "v1",
        throttlingBurstLimit: 100,
        throttlingRateLimit: 50,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ["POST", "GET"],
      },
    });

    const lambdaIntegration = new apigateway.LambdaIntegration(fn, {
      requestTemplates: { "application/json": '{ "statusCode": "200" }' },
    });

    // POST /webhooks/github
    const webhooks = api.root.addResource("webhooks");
    const github = webhooks.addResource("github");
    github.addMethod("POST", lambdaIntegration);

    // GET /health
    const health = api.root.addResource("health");
    health.addMethod("GET", lambdaIntegration);

    if (props.dashboard) {
      new DashboardApi(this, "Dashboard", {
        ...props.dashboard,
        table,
        githubAppId: props.githubAppId,
        logLevel: props.logLevel,
        secretsEpoch: props.secretsEpoch,
      });
    }

    // Stack Outputs
    new cdk.CfnOutput(this, "WebhookUrl", {
      value: `${api.url}webhooks/github`,
      description: "Paste this URL into GitHub webhook settings",
      exportName: "SyncroWebhookUrl",
    });

    new cdk.CfnOutput(this, "HealthUrl", {
      value: `${api.url}health`,
      description: "Health check URL",
    });

    new cdk.CfnOutput(this, "DynamoTableName", {
      value: table.tableName,
      description: "DynamoDB table name",
    });
  }
}
