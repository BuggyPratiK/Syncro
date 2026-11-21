import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { ApiProvider } from "../api/api-context";
import type { DashboardApi } from "../api/types";
import { App } from "../App";
import { AuthProvider, type AuthState } from "../auth/auth-context";
import { createFixtureApi } from "../dev/fixture-api";

export function fakeAuth(overrides: Partial<AuthState> = {}): AuthState {
  return {
    isAuthenticated: true,
    isLoading: false,
    isSigningOut: false,
    sessionEnded: false,
    signIn: () => {},
    signOut: () => {},
    endSession: () => {},
    getAccessToken: async () => "test-token",
    ...overrides,
  };
}

/** Shows the router's current path so tests can assert navigation. */
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

export function renderApp({
  path = "/",
  api = createFixtureApi({ seeded: true }),
  auth = fakeAuth(),
  strict = false,
}: {
  path?: string;
  api?: DashboardApi;
  auth?: AuthState;
  strict?: boolean;
} = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const tree: ReactNode = (
    <QueryClientProvider client={queryClient}>
      <AuthProvider value={auth}>
        <ApiProvider api={api}>
          <MemoryRouter initialEntries={[path]}>
            <App callback={<p>callback</p>} />
            <Routes>
              <Route path="*" element={<LocationProbe />} />
            </Routes>
          </MemoryRouter>
        </ApiProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
  return { api, queryClient, ...render(strict ? <StrictMode>{tree}</StrictMode> : tree) };
}
