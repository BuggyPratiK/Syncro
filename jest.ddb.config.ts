import type { Config } from "jest";
import { baseConfig } from "./jest.base";

/**
 * DynamoDB Local suite (`npm run test:ddb`). Needs DynamoDB Local running:
 * `npm run local:dynamo`, or set DDB_LOCAL_ENDPOINT. Each test file gets its
 * own throwaway table.
 */
const config: Config = {
  ...baseConfig,
  roots: ["<rootDir>/tests/ddb-local"],
  testMatch: ["**/*.ddb.test.ts"],
  setupFiles: ["<rootDir>/tests/setup.ts", "<rootDir>/tests/ddb-local/setup-env.ts"],
  globalSetup: "<rootDir>/tests/ddb-local/global-setup.ts",
  testTimeout: 30_000,
};

export default config;
