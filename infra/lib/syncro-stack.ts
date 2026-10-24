/**
 * Syncro CDK Stack
 * Defines all AWS infrastructure: DynamoDB, Lambda, API Gateway, IAM.
 * Uses NodejsFunction with esbuild for self-contained dependency bundling.
 */

import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

export class SyncroStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDB Table
    const table = new dynamodb.Table(this, "SyncroTable", {
      tableName: "syncro",
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // Scales to zero - Always Free
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Never delete table on stack destroy
    });

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

    // Lambda Function with full dependency bundling via esbuild
    const fn = new lambdaNodejs.NodejsFunction(this, "SyncroHandler", {
      functionName: "syncro-webhook-handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: "src/handler.ts",
      handler: "handler",
      memorySize: 256,
      timeout: cdk.Duration.seconds(15),
      logGroup,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node22",
      },
      environment: {
        NODE_ENV: "production",
        LOG_LEVEL: process.env.LOG_LEVEL || "info",
        DYNAMODB_TABLE_NAME: table.tableName,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: "1", // Reuse HTTP connections to AWS APIs
        GITHUB_APP_ID: process.env.GITHUB_APP_ID || "",
        GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY || "",
        GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET || "",
        DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || "",
      },
    });

    // Grant Lambda read/write access to DynamoDB table
    table.grantReadWriteData(fn);

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