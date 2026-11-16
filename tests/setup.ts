// Non-secret test configuration. Secrets are never in the environment: tests
// that need them inject a fake SSM reader (see src/config/secrets.ts).
process.env.DYNAMODB_TABLE_NAME = "syncro-test-table";
process.env.GITHUB_APP_ID = "123456";
process.env.AWS_REGION = "ap-southeast-2";
process.env.SSM_PARAM_PREFIX = "/syncro/prod";
process.env.GITHUB_APP_PRIVATE_KEY_PARAM = "/syncro/prod/sender/github-app-private-key";
process.env.GITHUB_WEBHOOK_SECRET_PARAM = "/syncro/prod/sender/github-webhook-secret";
