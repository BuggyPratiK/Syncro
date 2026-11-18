/** @jest-config-loader ts-node */
// Jest loads this file with ts-node: Node's built-in TypeScript loader would
// require explicit file extensions on the imports below.
import type { Config } from "jest";
import { baseConfig } from "./jest.base";

/** Unit and integration suite (`npm test`). No network, no Docker. */
const config: Config = {
  ...baseConfig,
  // Keep local runs light on RAM and CPU; CI can override with --maxWorkers.
  maxWorkers: 2,
  roots: ["<rootDir>/tests", "<rootDir>/src"],
  testMatch: ["**/*.test.ts"],
  // DynamoDB Local suites need Docker and run separately (`npm run test:ddb`).
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/tests/ddb-local/"],
  setupFiles: ["<rootDir>/tests/setup.ts"],
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts"],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov", "html"],
};

export default config;
