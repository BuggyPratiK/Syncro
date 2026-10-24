/**
 * Seed script - inserts a repository config item into DynamoDB.
 * Run this once per repo you want Syncro to watch.
 *
 * Usage:
 *   Local:      DYNAMODB_ENDPOINT=http://localhost:8000 npx ts-node scripts/seed-repo.ts
 *   Production: npm run seed
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import * as readline from "readline";

const envLocal = path.resolve(__dirname, "../.env.local");
if (fs.existsSync(envLocal)) {
  dotenv.config({ path: envLocal });
}

const client = new DynamoDBClient({
  region: process.env.AWS_REGION ?? "ap-southeast-2",
  ...(process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {}),
});
const ddb = DynamoDBDocumentClient.from(client);
const TABLE = process.env.DYNAMODB_TABLE_NAME ?? "syncro";

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (ans) => resolve(ans.trim())));
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("\n=======================================================");
  console.log("             Syncro - Register Repository              ");
  console.log("=======================================================\n");

  const githubRepoId = await ask(rl, "GitHub Repository ID (numeric):          ");
  const githubFullName = await ask(rl, "Repository full name (e.g. owner/repo): ");
  const githubUrl = await ask(rl, "Repository URL:                           ");
  const discordWebhookUrl =
    (await ask(rl, `Discord Webhook URL [from .env.local]:   `)) ||
    process.env.DISCORD_WEBHOOK_URL ||
    "";
  const watchedBranch = (await ask(rl, "Branch to watch [main]:                   ")) || "main";

  rl.close();

  const now = new Date().toISOString();

  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `REPO#${githubRepoId}`,
        SK: "CONFIG",
        github_repo_id: String(githubRepoId),
        github_full_name: githubFullName,
        github_url: githubUrl,
        discord_webhook_url: discordWebhookUrl,
        watched_branch: watchedBranch,
        is_active: true,
        GSI1PK: "TYPE#REPO",
        created_at: now,
        updated_at: now,
      },
    }),
  );

  console.log(`\nRepository registered successfully:`);
  console.log(`   ${githubFullName} (ID: ${githubRepoId})`);
  console.log(`   Watching branch: ${watchedBranch}`);
  console.log(`   Target: Discord Webhook\n`);
}

main().catch((err) => {
  console.error("Registration failed:", err);
  process.exit(1);
});