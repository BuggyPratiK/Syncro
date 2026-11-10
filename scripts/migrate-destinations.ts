/**
 * Migration Script: Migrate Repository Configurations to Discord Destination Entities
 *
 * Normalizes existing repository records containing 'discord_webhook_url' into
 * separate 'DESTINATION#<id>' items referenced by 'discord_destination_id'.
 *
 * Features:
 * - Reuses existing destination when multiple repos share the same webhook URL
 * - Fully idempotent and safe to resume if interrupted
 * - Dry-run mode (--dry-run) to preview changes without modifying DynamoDB
 * - Never prints raw webhook URLs or tokens (always masked)
 * - Retains legacy discord_webhook_url on repo records for backward compatibility
 *
 * Usage:
 *   Dry-run: npm run migrate:destinations:dry-run
 *   Live:    npm run migrate:destinations
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { keys, gsiKeys } from "../src/db/table";
import { RepoConfigItem, DiscordDestinationItem } from "../src/types/dynamodb.types";
import { maskWebhookUrl } from "../src/utils/logger";
import { validateDiscordWebhookUrl } from "../src/utils/url-validator";

export interface MigrationOptions {
  dryRun?: boolean;
  tableName?: string;
  documentClient?: DynamoDBDocumentClient;
}

export interface MigrationPlanItem {
  repoId: string;
  repoFullName: string;
  watchedBranch: string;
  isActive: boolean;
  maskedUrl: string;
  destinationId: string;
  destinationDisplayName: string;
  isNewDestination: boolean;
  action: "SKIP_ALREADY_MIGRATED" | "LINK_EXISTING_DESTINATION" | "CREATE_AND_LINK_DESTINATION";
}

export interface MigrationSummary {
  dryRun: boolean;
  totalReposScanned: number;
  alreadyMigratedCount: number;
  newDestinationsCreated: number;
  reposUpdated: number;
  reusedDestinationsCount: number;
  plan: MigrationPlanItem[];
}

/**
 * Executes the destination migration logic.
 */
export async function migrateDestinations(options?: MigrationOptions): Promise<MigrationSummary> {
  const dryRun = options?.dryRun ?? false;
  const tableName = options?.tableName ?? process.env.DYNAMODB_TABLE_NAME ?? "syncro";

  let ddb = options?.documentClient;
  if (!ddb) {
    const envLocal = path.resolve(__dirname, "../.env.local");
    if (fs.existsSync(envLocal)) {
      dotenv.config({ path: envLocal });
    }

    const client = new DynamoDBClient({
      region: process.env.AWS_REGION ?? "ap-southeast-2",
      ...(process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {}),
    });
    ddb = DynamoDBDocumentClient.from(client);
  }

  // 1. Fetch all existing destinations to build URL lookup and avoid duplicate creation
  const existingDestinationsResult = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: "type-index",
      KeyConditionExpression: "GSI1PK = :gsi1pk",
      ExpressionAttributeValues: {
        ":gsi1pk": gsiKeys.allDestinations(),
      },
    }),
  );

  const existingDestinations = (existingDestinationsResult.Items ?? []) as DiscordDestinationItem[];
  const urlToDestinationMap = new Map<string, DiscordDestinationItem>();
  const idToDestinationMap = new Map<string, DiscordDestinationItem>();

  for (const dest of existingDestinations) {
    if (dest.discord_webhook_url) {
      urlToDestinationMap.set(dest.discord_webhook_url.trim(), dest);
    }
    idToDestinationMap.set(dest.destination_id, dest);
  }

  // 2. Fetch all repositories
  const reposResult = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: "type-index",
      KeyConditionExpression: "GSI1PK = :gsi1pk",
      ExpressionAttributeValues: {
        ":gsi1pk": gsiKeys.allRepos(),
      },
    }),
  );

  const repos = (reposResult.Items ?? []) as RepoConfigItem[];
  const plan: MigrationPlanItem[] = [];
  let newDestinationsCreated = 0;
  let reposUpdated = 0;
  let reusedDestinationsCount = 0;
  let alreadyMigratedCount = 0;

  for (const repo of repos) {
    const rawUrl = repo.discord_webhook_url?.trim();
    const existingDestId = repo.discord_destination_id;

    // Check if repository already points to a valid destination
    if (existingDestId && idToDestinationMap.has(existingDestId)) {
      const dest = idToDestinationMap.get(existingDestId)!;
      plan.push({
        repoId: repo.github_repo_id,
        repoFullName: repo.github_full_name,
        watchedBranch: repo.watched_branch,
        isActive: repo.is_active,
        maskedUrl: maskWebhookUrl(dest.discord_webhook_url),
        destinationId: dest.destination_id,
        destinationDisplayName: dest.display_name,
        isNewDestination: false,
        action: "SKIP_ALREADY_MIGRATED",
      });
      alreadyMigratedCount++;
      continue;
    }

    if (!rawUrl) {
      continue;
    }

    const validation = validateDiscordWebhookUrl(rawUrl);
    if (!validation.valid || !validation.cleanedUrl) {
      continue;
    }

    const cleanUrl = validation.cleanedUrl;
    let targetDest = urlToDestinationMap.get(cleanUrl);
    let isNew = false;

    if (!targetDest) {
      // Must create a new destination
      const newDestId = randomUUID();
      const now = new Date().toISOString();
      const displayName = `Discord - ${repo.github_full_name}`;

      targetDest = {
        ...keys.destination(newDestId),
        destination_id: newDestId,
        provider: "discord",
        display_name: displayName,
        discord_webhook_url: cleanUrl,
        is_active: true,
        GSI1PK: gsiKeys.allDestinations(),
        created_at: now,
        updated_at: now,
      };

      if (!dryRun) {
        await ddb.send(
          new PutCommand({
            TableName: tableName,
            Item: targetDest,
            ConditionExpression: "attribute_not_exists(PK)",
          }),
        );
      }

      urlToDestinationMap.set(cleanUrl, targetDest);
      idToDestinationMap.set(newDestId, targetDest);
      newDestinationsCreated++;
      isNew = true;
    } else {
      reusedDestinationsCount++;
    }

    // Link repo to destination
    if (!dryRun) {
      await ddb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: keys.repoConfig(repo.github_repo_id),
          UpdateExpression: "SET discord_destination_id = :destId, updated_at = :now",
          ExpressionAttributeValues: {
            ":destId": targetDest.destination_id,
            ":now": new Date().toISOString(),
          },
        }),
      );
    }

    reposUpdated++;
    plan.push({
      repoId: repo.github_repo_id,
      repoFullName: repo.github_full_name,
      watchedBranch: repo.watched_branch,
      isActive: repo.is_active,
      maskedUrl: maskWebhookUrl(cleanUrl),
      destinationId: targetDest.destination_id,
      destinationDisplayName: targetDest.display_name,
      isNewDestination: isNew,
      action: isNew ? "CREATE_AND_LINK_DESTINATION" : "LINK_EXISTING_DESTINATION",
    });
  }

  return {
    dryRun,
    totalReposScanned: repos.length,
    alreadyMigratedCount,
    newDestinationsCreated,
    reposUpdated,
    reusedDestinationsCount,
    plan,
  };
}

/**
 * CLI Entrypoint
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run") || args.includes("-d") || process.env.DRY_RUN === "true";

  console.log("\n=======================================================");
  console.log(`  Syncro - Destination Migration [${dryRun ? "DRY-RUN MODE" : "LIVE MODE"}]  `);
  console.log("=======================================================\n");

  const summary = await migrateDestinations({ dryRun });

  console.log(`Repositories Scanned:      ${summary.totalReposScanned}`);
  console.log(`Already Migrated:          ${summary.alreadyMigratedCount}`);
  console.log(`New Destinations ${dryRun ? "to create" : "created"}:  ${summary.newDestinationsCreated}`);
  console.log(`Reused Destinations:       ${summary.reusedDestinationsCount}`);
  console.log(`Repositories ${dryRun ? "to update" : "updated"}:    ${summary.reposUpdated}\n`);

  console.log("Execution Details:");
  for (const item of summary.plan) {
    console.log(
      ` - [${item.action}] Repo: ${item.repoFullName} (ID: ${item.repoId}) -> Destination: ${item.destinationDisplayName} (${item.destinationId}) | URL: ${item.maskedUrl}`,
    );
  }

  if (dryRun) {
    console.log("\n[DRY RUN COMPLETE] No records were modified in DynamoDB.");
    console.log("Run 'npm run migrate:destinations' to apply these changes.");
  } else {
    console.log("\n[MIGRATION SUCCESSFUL] DynamoDB records updated.");
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}

