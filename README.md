# Syncro

> **A Serverless GitHub Automation Bot** that monitors repository commits and broadcasts rich, real-time update notifications to contributor channels (Discord) - built on an **Always-Free AWS Serverless Architecture** ($0/month indefinitely).

[![CI](https://github.com/pratik/Syncro/actions/workflows/ci.yml/badge.svg)](https://github.com/pratik/Syncro/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue?logo=typescript)](https://www.typescriptlang.org/)
[![AWS Serverless](https://img.shields.io/badge/AWS-Serverless-orange?logo=amazon-aws)](https://aws.amazon.com/)
[![DynamoDB](https://img.shields.io/badge/Amazon-DynamoDB-4053D6?logo=amazon-dynamodb)](https://aws.amazon.com/dynamodb/)
[![Jest Coverage](https://img.shields.io/badge/Coverage-91%25-brightgreen?logo=jest)](https://jestjs.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## Architecture

Syncro runs 100% serverless across permanent AWS Always-Free tier services:

```text
  GitHub Repository
         |
         v (git push webhook via HTTPS)
 Amazon API Gateway (REST API)
         |
         v (Proxy Integration)
   AWS Lambda (Node.js 22 + TypeScript)
         |
         |-- 1. Verify HMAC-SHA256 Signature (timingSafeEqual)
         |-- 2. Atomic Deduplication Lock via DynamoDB (attribute_not_exists)
         |-- 3. Enrich Commits & Stats via GitHub REST API (Octokit)
         \-- 4. Build Rich Embed & Dispatch
                     |
                     v
             Discord Webhook
                     |
                     v
          "MAIN updated - owner/repo
           3 commits pushed by Dev | +45 / -12 | 4 files changed
           Commits:
             a81f23c feat: add webhook idempotency
             c92bd11 fix: resolve DynamoDB condition
           Sync your repo before starting work:
             git pull origin main"
```

---

## Key Architectural Features

- **Permanent Always-Free Tier**: Powered by AWS Lambda (1M free requests/month forever) and Amazon DynamoDB (25 GB storage + 25 WCU/RCU forever). Runs at **$0/month indefinitely**.
- **Atomic Idempotency & Deduplication**: Prevents duplicate notifications during GitHub webhook retries using conditional DynamoDB `PutItem` (`attribute_not_exists(PK)`). Zero duplicate notifications even under concurrent delivery bursts.
- **Single-Table Design**: All entities (Repository Configs, Delivery Deduplication Records, Commit History, Notification Logs) live in a single DynamoDB table with composite partition and sort keys (`PK` / `SK`).
- **Cryptographic Security**: Every incoming payload is validated using HMAC-SHA256 signatures with constant-time equality comparisons (`crypto.timingSafeEqual`) to prevent timing attack vulnerabilities.
- **Resilient Delivery**: Automatic retry with exponential backoff on HTTP `429 Too Many Requests` respecting Discord's `Retry-After` rate-limit headers.
- **Infrastructure as Code (IaC)**: Fully defined and reproducible using **AWS CDK (TypeScript)**. One-command deployments and teardowns.
- **Comprehensive Test Suite**: 15 test suites and 67 unit tests covering **~91% of the codebase**.

---

## DynamoDB Single-Table Schema

| Entity | PK | SK | Key Attributes |
|---|---|---|---|
| **Repository Config** | `REPO#<github_repo_id>` | `CONFIG` | `discord_webhook_url`, `watched_branch`, `is_active`, `GSI1PK=TYPE#REPO` |
| **Delivery Lock** | `DELIVERY#<delivery_id>` | `DELIVERY#<delivery_id>` | `status`, `received_at`, `ttl` (auto-expires in 30 days) |
| **Commit Record** | `REPO#<github_repo_id>` | `COMMIT#<sha>` | `short_sha`, `author_name`, `message`, `additions`, `deletions`, `files` |
| **Notification Log** | `REPO#<github_repo_id>` | `NOTIF#<ISO_timestamp>` | `channel`, `status`, `message_id`, `retry_count` |

---

## Getting Started

### Prerequisites

- Node.js 22+ & npm
- AWS CLI configured with active credentials
- A GitHub App created with **Repository: Contents (Read)** & **Metadata (Read)** permissions
- A Discord Webhook URL for your target channel

### 1. Installation

```bash
git clone https://github.com/<your-username>/Syncro.git
cd Syncro
npm install
```

### 2. Configure Credentials

Run the guided local configuration script to populate `.env.local` (never committed):

```bash
npm run setup:secrets
```

### 3. Deploy to AWS

Deploy the complete serverless stack in one command:

```bash
npm run cdk:deploy
```

Upon completion, CDK outputs your live API Gateway webhook endpoint:
```text
Outputs:
SyncroStack.WebhookUrl = https://<api-id>.execute-api.<region>.amazonaws.com/v1/webhooks/github
SyncroStack.HealthUrl = https://<api-id>.execute-api.<region>.amazonaws.com/v1/health
```

### 4. Register a Repository to Watch

```bash
npm run seed
```

Enter your repository's numeric GitHub ID, full name (`owner/repo`), and branch (`main`).

---

## Testing & Code Quality

```bash
# Run unit tests
npm test

# Run tests with code coverage report
npm run test:coverage

# Run TypeScript type-checker across source and infra
npm run type-check

# Run ESLint
npm run lint
```

---

## License

This project is licensed under the MIT License.