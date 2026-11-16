/**
 * Jest settings shared by the unit suite (jest.config.ts) and the DynamoDB
 * Local suite (jest.ddb.config.ts).
 */

import type { Config } from "jest";

/**
 * ESM-only packages that tests import. Jest runs tests as CommonJS, so these
 * are transpiled to CommonJS for tests only (the Lambda bundle and `tsc` use
 * them unchanged). `jose` verifies Logto access tokens.
 */
const ESM_PACKAGES = ["jose"];

export const baseConfig: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.json" }],
    // Transpile-only (no type checking) for the ESM packages' JavaScript.
    [`[\\\\/]node_modules[\\\\/](${ESM_PACKAGES.join("|")})[\\\\/].+\\.js$`]: [
      "ts-jest",
      {
        isolatedModules: true,
        tsconfig: { allowJs: true, module: "commonjs", target: "ES2022", esModuleInterop: true },
      },
    ],
  },
  // Everything in node_modules is left untouched except the ESM packages above.
  transformIgnorePatterns: [`/node_modules/(?!(${ESM_PACKAGES.join("|")})/)`],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    "^@octokit/app$": "<rootDir>/__mocks__/@octokit/app.ts",
    // Tests never call real AWS SSM; see __mocks__/@aws-sdk/client-ssm.ts.
    "^@aws-sdk/client-ssm$": "<rootDir>/__mocks__/@aws-sdk/client-ssm.ts",
  },
  clearMocks: true,
  restoreMocks: true,
};
