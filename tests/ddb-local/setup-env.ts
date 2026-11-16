/**
 * Environment for DynamoDB Local suites (runs before each test file).
 *
 * Safety: the endpoint must be a local DynamoDB (localhost, 127.0.0.1, or the
 * `dynamodb` service hostname used in CI). Anything else aborts the run, so
 * these tests can never touch a real AWS table. Credentials are dummies.
 */

import { randomUUID } from "crypto";

const endpoint = process.env.DDB_LOCAL_ENDPOINT ?? "http://localhost:8000";
const host = new URL(endpoint).hostname;
if (!["localhost", "127.0.0.1", "dynamodb"].includes(host)) {
  throw new Error(`Refusing to run DynamoDB tests against a non-local endpoint: ${host}`);
}

process.env.DYNAMODB_ENDPOINT = endpoint;
process.env.AWS_ACCESS_KEY_ID = "local";
process.env.AWS_SECRET_ACCESS_KEY = "local";
delete process.env.AWS_SESSION_TOKEN;
delete process.env.AWS_PROFILE;

// One throwaway table per test file, so files cannot interfere with each other.
process.env.DYNAMODB_TABLE_NAME = `syncro-test-${randomUUID()}`;
