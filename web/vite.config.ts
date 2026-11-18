import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The API contract lives in the backend tree and is the only backend code the
// web app may import (enforced by the lint configuration).
const contractsDir = fileURLToPath(new URL("../src/contracts", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@contracts": contractsDir },
    // The contract schemas import `zod`. Resolve it from web/node_modules so the
    // web build does not depend on the backend's installed packages (CI installs
    // only web/ for the web job).
    dedupe: ["zod"],
  },
  server: {
    // The local dashboard API allows exactly this origin (CORS).
    port: 5173,
    strictPort: true,
    fs: { allow: [".", contractsDir] },
  },
  build: {
    target: "es2022",
    sourcemap: false,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    restoreMocks: true,
    // Keep local runs light; matches the root suite's default.
    maxWorkers: 2,
  },
});
