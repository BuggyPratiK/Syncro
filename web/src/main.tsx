import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { HttpApiProvider } from "./api/api-context";
import { App } from "./App";
import { LogtoAuth } from "./auth/logto-auth";
import { LogtoCallback } from "./auth/LogtoCallback";
import { ConfigMissing } from "./components/ConfigMissing";
import { readConfig } from "./config";
import { createQueryClient } from "./query-client";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
const queryClient = createQueryClient();

function render(tree: ReactNode) {
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>{tree}</BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}

async function start() {
  // Development only. The condition is written inline (not via a shared
  // constant) so the bundler can see it is statically false in production
  // builds and drop the fixture chunk entirely; the CI bundle check verifies it.
  if (import.meta.env.DEV && import.meta.env.VITE_FIXTURES === "true") {
    const { FixtureRoot } = await import("./dev/fixture-root");
    render(<FixtureRoot />);
    return;
  }

  const result = readConfig();
  if (!result.ok) {
    render(<ConfigMissing missing={result.missing} />);
    return;
  }
  render(
    <LogtoAuth config={result.config}>
      <HttpApiProvider baseUrl={result.config.apiBase}>
        <App callback={<LogtoCallback />} />
      </HttpApiProvider>
    </LogtoAuth>,
  );
}

void start();
