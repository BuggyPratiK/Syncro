/**
 * Fixture mode entry (development only): a fake signed-in user and the
 * in-memory API, so the UI can be exercised without Logto or the backend.
 */

import { useMemo, useState } from "react";
import { Navigate } from "react-router";
import { ApiProvider } from "../api/api-context";
import { App } from "../App";
import { AuthProvider, type AuthState } from "../auth/auth-context";
import { PATHS } from "../paths";
import { createFixtureApi } from "./fixture-api";

const api = createFixtureApi({ latencyMs: 250 });

export function FixtureRoot() {
  const [signedIn, setSignedIn] = useState(true);
  const auth = useMemo<AuthState>(
    () => ({
      isAuthenticated: signedIn,
      isLoading: false,
      isSigningOut: false,
      sessionEnded: false,
      signIn: () => setSignedIn(true),
      signOut: () => setSignedIn(false),
      endSession: () => setSignedIn(false),
      getAccessToken: async () => (signedIn ? "fixture-token" : null),
    }),
    [signedIn],
  );
  return (
    <AuthProvider value={auth}>
      <ApiProvider api={api}>
        <App callback={<Navigate to={PATHS.home} replace />} />
      </ApiProvider>
    </AuthProvider>
  );
}
