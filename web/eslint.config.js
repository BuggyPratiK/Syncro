import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * The web app may import backend code only from the API contract
 * (`src/contracts`). Anything else under the backend `src/` could pull server
 * logic, secrets handling or AWS clients into the browser bundle.
 */
export const BACKEND_IMPORT_PATTERN = {
  regex: "^(\\.\\./)+src/(?!contracts(/|$))",
  message: "The web app may import only the API contract (src/contracts) from the backend.",
};

export default defineConfig([
  globalIgnores(["dist/", "node_modules/", "coverage/"]),
  {
    files: ["**/*.{ts,tsx,js,mjs}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      globals: { ...globals.browser },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-restricted-imports": ["error", { patterns: [BACKEND_IMPORT_PATTERN] }],
      // Stored strings (commit messages, PR titles, repository names) must
      // always render as text.
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "Render text only; never inject HTML.",
        },
      ],
      // The Logto SDK manages its own session storage; application code never
      // writes tokens or other persistent state to localStorage.
      "no-restricted-globals": [
        "error",
        { name: "localStorage", message: "Do not use localStorage in application code." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "window", property: "localStorage", message: "Do not use localStorage in application code." },
      ],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat["recommended-latest"], reactRefresh.configs.vite],
  },
  {
    // Context modules export a provider and its hook together.
    files: ["src/**/*-context.tsx", "src/test/**/*.tsx", "src/**/*.test.tsx"],
    rules: { "react-refresh/only-export-components": "off" },
  },
  {
    // Tests inspect browser storage to prove nothing secret was written to it.
    files: ["src/**/*.test.{ts,tsx}"],
    rules: { "no-restricted-globals": "off", "no-restricted-properties": "off" },
  },
  {
    files: ["scripts/**/*.{js,mjs,ts}", "vite.config.ts", "eslint.config.js"],
    languageOptions: { globals: { ...globals.node } },
  },
]);
