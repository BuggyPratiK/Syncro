import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { SyncroStack } from "../lib/syncro-stack";

// Configuration comes only from the process environment, which the Deploy
// workflow restricts to an allowlist of non-secret values. No .env file is
// loaded: secrets never pass through CDK (they live in SSM Parameter Store).
const logLevel = process.env.LOG_LEVEL;
if (logLevel !== undefined && !["debug", "info", "warn", "error"].includes(logLevel)) {
  throw new Error("LOG_LEVEL must be one of debug, info, warn, error");
}

const app = new cdk.App();

new SyncroStack(app, "SyncroStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID,
    region: process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION ?? "ap-southeast-2",
  },
  description: "Syncro - GitHub Notification Bot (Lambda + API Gateway + DynamoDB)",
  githubAppId: process.env.GITHUB_APP_ID ?? "",
  logLevel: logLevel as "debug" | "info" | "warn" | "error" | undefined,
  secretsEpoch: process.env.SECRETS_EPOCH || undefined,
});
