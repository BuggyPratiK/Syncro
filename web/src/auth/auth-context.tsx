/**
 * Authentication seen by the rest of the app. The Logto implementation lives
 * in `logto-auth.tsx`; tests and fixture mode provide a fake one.
 *
 * Tokens are never held here: `getAccessToken` asks the SDK each time, and the
 * SDK manages its own session storage.
 */

import { createContext, useContext, type ReactNode } from "react";

export interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  /** Redirects to the hosted sign-in page. */
  signIn(): void;
  /** Ends the session at the identity provider and returns to the start page. */
  signOut(): void;
  getAccessToken(): Promise<string | null>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ value, children }: { value: AuthState; children: ReactNode }) {
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
