import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAuth } from "../auth/auth-context";
import { createHttpClient } from "./client";
import type { DashboardApi } from "./types";

const ApiContext = createContext<DashboardApi | null>(null);

/** Provides a ready-made client (tests, fixture mode). */
export function ApiProvider({ api, children }: { api: DashboardApi; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

/** Provides the HTTP client bound to the current auth session. */
export function HttpApiProvider({ baseUrl, children }: { baseUrl: string; children: ReactNode }) {
  const auth = useAuth();
  const api = useMemo(
    () =>
      createHttpClient({
        baseUrl,
        getAccessToken: () => auth.getAccessToken(),
        // Never redirect from a request: show the sign-in page and let the user choose.
        onSignInRequired: () => auth.endSession(),
      }),
    [auth, baseUrl],
  );
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): DashboardApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi must be used inside an API provider");
  return api;
}
