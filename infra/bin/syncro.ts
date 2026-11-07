import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { SyncroStack } from "../lib/syncro-stack";

const envLocal = path.resolve(__dirname, "../../.env.local");
const envDefault = path.resolve(__dirname, "../../.env");
if (fs.existsSync(envLocal)) {
  dotenv.config({ path: envLocal });
} else if (fs.existsSync(envDefault)) {
  dotenv.config({ path: envDefault });
}

const app = new cdk.App();

new SyncroStack(app, "SyncroStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID,
    region: process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION ?? "ap-southeast-2",
  },
  description: "Syncro - GitHub Notification Bot (Lambda + API Gateway + DynamoDB)",
});