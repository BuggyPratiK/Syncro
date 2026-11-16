import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

const GLOBAL_URL_MESSAGE =
  "There is no global Discord webhook URL. Send only to the destination configured for the repository.";
const STORED_URL_MESSAGE =
  "The send path must not read a webhook URL from a record; resolve the repository's destination instead.";

export default [
  {
    files: ["src/**/*.ts", "infra/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  // Guard: no global Discord webhook URL anywhere in the application, and the
  // send path must never read a webhook URL stored on a record. Targets come
  // only from a repository's configured destination.
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "Identifier[name='DISCORD_WEBHOOK_URL']", message: GLOBAL_URL_MESSAGE },
        { selector: "Literal[value='DISCORD_WEBHOOK_URL']", message: GLOBAL_URL_MESSAGE },
      ],
    },
  },
  {
    files: ["src/notifications/**/*.ts", "src/webhooks/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "Identifier[name='DISCORD_WEBHOOK_URL']", message: GLOBAL_URL_MESSAGE },
        { selector: "Literal[value='DISCORD_WEBHOOK_URL']", message: GLOBAL_URL_MESSAGE },
        { selector: "MemberExpression[property.name='discord_webhook_url']", message: STORED_URL_MESSAGE },
        { selector: "Literal[value='discord_webhook_url']", message: STORED_URL_MESSAGE },
      ],
      // Webhooks are delivered only through the workspace path; the older global
      // repository/destination operations must never be reachable from it.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/db/operations/destination.ops", "**/db/operations/repository.ops", "**/services/destination.service", "**/services/repository.service"],
              message: "The send path resolves repositories and destinations only through the workspace path (webhooks/resolve-target).",
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ["node_modules/**", "dist/**", "infra/dist/**", "coverage/**", "cdk.out/**"],
  },
];