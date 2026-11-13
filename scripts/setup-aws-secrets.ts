/**
 * Local Secrets Configuration Script
 *
 * Runs locally on your machine to write credentials into .env.local for local
 * development and approved local checks (cdk synth / cdk diff). When CDK runs
 * locally, it reads .env.local and places these values in the synthesized
 * Lambda environment variables.
 *
 * .env.local is not used by production deploys. Production deploys run only
 * through the GitHub Actions Deploy workflow, using secrets from the protected
 * GitHub Actions "production" environment. This script does not use AWS SSM
 * Parameter Store.
 *
 * Usage:
 *   npm run setup:secrets
 */

import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string, defaultValue?: string): Promise<string> {
  const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

async function main() {
  console.log("\n=======================================================");
  console.log("             Syncro - Local Secrets Setup              ");
  console.log("=======================================================\n");
  console.log("Configuring your GitHub App and Discord credentials into .env.local.");
  console.log("For local development and approved local checks (cdk synth / cdk diff) only.");
  console.log("Production deploys use the protected GitHub Actions \"production\" environment, not this file.\n");

  const region = await ask("AWS Region", process.env.AWS_REGION || "ap-southeast-2");
  const accountId = await ask("AWS Account ID", process.env.AWS_ACCOUNT_ID || "");

  // 1. GitHub App ID
  let appId = "";
  while (!appId) {
    appId = await ask("Enter your GitHub App ID (numbers only)");
    if (!/^\d+$/.test(appId)) {
      console.log("Invalid App ID. It must be numeric (e.g. 1045231).");
      appId = "";
    }
  }

  // 2. Private Key (.pem file)
  let privateKey = "";
  while (!privateKey) {
    const pemPath = await ask("Enter the path to your downloaded .pem file (e.g. C:\\Users\\...\\app.private-key.pem)");
    const resolvedPath = path.resolve(pemPath.replace(/^["']|["']$/g, ""));

    if (!fs.existsSync(resolvedPath)) {
      console.log(`File not found at: ${resolvedPath}. Please check the path.`);
      continue;
    }

    try {
      const fileContent = fs.readFileSync(resolvedPath, "utf-8").trim();
      if (!fileContent.includes("PRIVATE KEY-----")) {
        console.log("File does not appear to be a valid RSA private key.");
        continue;
      }
      privateKey = fileContent;
      console.log("Private key loaded successfully.");
    } catch (err) {
      console.log("Could not read file:", err instanceof Error ? err.message : err);
    }
  }

  // 3. GitHub Webhook Secret
  let webhookSecret = "";
  while (!webhookSecret) {
    webhookSecret = await ask("Enter your GitHub Webhook Secret");
    if (!webhookSecret) {
      console.log("Webhook secret cannot be empty.");
    }
  }

  // 4. Discord Webhook URL
  let discordUrl = "";
  while (!discordUrl) {
    discordUrl = await ask("Enter your Discord Channel Webhook URL");
    if (!discordUrl.startsWith("https://discord.com/api/webhooks/")) {
      console.log("Invalid Discord webhook URL. It should start with https://discord.com/api/webhooks/");
      discordUrl = "";
    }
  }

  // Write .env.local
  const envLocalContent = `# Syncro Environment Configuration (Auto-generated)
NODE_ENV=production
LOG_LEVEL=info
AWS_REGION=${region}
AWS_ACCOUNT_ID=${accountId}
DYNAMODB_TABLE_NAME=syncro
GITHUB_APP_ID=${appId}
GITHUB_APP_PRIVATE_KEY="${privateKey.replace(/\r/g, "").replace(/\n/g, "\\n")}"
GITHUB_WEBHOOK_SECRET=${webhookSecret}
DISCORD_WEBHOOK_URL=${discordUrl}
`;

  fs.writeFileSync(".env.local", envLocalContent, "utf-8");

  console.log("\n=======================================================");
  console.log("All credentials saved to .env.local (kept in .gitignore)!");
  console.log("Local configuration only. It is not used by production deploys.");
  console.log("=======================================================\n");
  console.log("Next step:");
  console.log("  Use .env.local for local development and approved local checks (cdk synth / cdk diff).");
  console.log("  Production deploys run only through the GitHub Actions Deploy workflow, after approval");
  console.log("  on the protected \"production\" environment (see README \"Deploy to AWS\").\n");

  rl.close();
}

main().catch((err) => {
  console.error("\nSetup failed:", err instanceof Error ? err.message : err);
  rl.close();
  process.exit(1);
});