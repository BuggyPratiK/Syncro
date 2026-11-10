/**
 * Seed script - inserts a repository config item and associated Discord destination into DynamoDB.
 * Run this once per repo you want Syncro to watch.
 *
 * Usage:
 *   Local:      DYNAMODB_ENDPOINT=http://localhost:8000 npm run seed
 *   Production: npm run seed
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import * as readline from "readline";
import { keys, gsiKeys } from "../src/db/table";
import { DiscordDestinationItem } from "../src/types/dynamodb.types";
import { maskWebhookUrl } from "../src/utils/logger";
import { validateDiscordWebhookUrl } from "../src/utils/url-validator";

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

  const githubRepoId = await ask(rl, "GitHub Repository ID (numeric):            ");
  const githubFullName = await ask(rl, "Repository full name (e.g. owner/repo):   ");
  const githubUrl = await ask(rl, "Repository URL:                             ");
  const discordWebhookUrlInput =
    (await ask(rl, `Discord Webhook URL [from .env.local]:     `)) ||
    process.env.DISCORD_WEBHOOK_URL ||
    "";
  const watchedBranch = (await ask(rl, "Branch to watch [main]:                     ")) || "main";

  rl.close();

  const validation = validateDiscordWebhookUrl(discordWebhookUrlInput);
  if (!validation.valid || !validation.cleanedUrl) {
    throw new Error(validation.error ?? "Invalid Discord webhook URL");
  }
  const cleanUrl = validation.cleanedUrl;

  const now = new Date().toISOString();

  // Check if an existing destination uses this webhook URL
  const existingDestinationsResult = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: "type-index",
      KeyConditionExpression: "GSI1PK = :gsi1pk",
      ExpressionAttributeValues: {
        ":gsi1pk": gsiKeys.allDestinations(),
      },
    }),
  );

  const existingDestinations = (existingDestinationsResult.Items ?? []) as DiscordDestinationItem[];
  let destination = existingDestinations.find(
    (d) => d.discord_webhook_url && d.discord_webhook_url.trim() === cleanUrl,
  );

  if (!destination) {
    const destId = randomUUID();
    const displayName = `Discord - ${githubFullName}`;
    destination = {
      ...keys.destination(destId),
      destination_id: destId,
      provider: "discord",
      display_name: displayName,
      discord_webhook_url: cleanUrl,
      is_active: true,
      GSI1PK: gsiKeys.allDestinations(),
      created_at: now,
      updated_at: now,
    };

    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: destination,
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
    console.log(`\nCreated new Discord destination: ${displayName} (${destId})`);
  } else {
    console.log(`\nReusing existing Discord destination: ${destination.display_name} (${destination.destination_id})`);
  }

  // Create repository config linked to destination
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...keys.repoConfig(githubRepoId),
        github_repo_id: String(githubRepoId),
        github_full_name: githubFullName,
        github_url: githubUrl,
        discord_destination_id: destination.destination_id,
        discord_webhook_url: cleanUrl, // Retained for backward compatibility
        watched_branch: watchedBranch,
        is_active: true,
        GSI1PK: gsiKeys.allRepos(),
        created_at: now,
        updated_at: now,
      },
    }),
  );

  console.log(`\nRepository registered successfully:`);
  console.log(`   ${githubFullName} (ID: ${githubRepoId})`);
  console.log(`   Watching branch: ${watchedBranch}`);
  console.log(`   Destination ID:  ${destination.destination_id}`);
  console.log(`   Webhook Target:  ${maskWebhookUrl(cleanUrl)}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Registration failed:", err);
    process.exit(1);
  });
}
