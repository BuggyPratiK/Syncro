/**
 * Authentication seen by the rest of the app. The Logto implementation lives
 * in `logto-auth.tsx`; tests and fixture mode provide a fake one.
 *
 * Tokens are never held here: `getAccessToken` asks the SDK each time, and the
 * SDK manages its own session storage.
 *
 * The app never starts a sign-in on its own. A missing or rejected token only
 * ends the session in the UI (`endSession`), and the user chooses to sign in
 * again. Automatic redirects could race a sign-out in progress and silently
 * sign the user back in, or loop when the identity provider keeps refusing.
 */

import { createContext, useContext, type ReactNode } from "react";

export interface AuthState {
  /** True only while the SDK holds a session and it has not been ended or signed out. */
  isAuthenticated: boolean;
  isLoading: boolean;
  /** Sign-out has started; the app shows a neutral screen until the browser leaves. */
  isSigningOut: boolean;
  /** The session ended because no valid token was available (not a user sign-out). */
  sessionEnded: boolean;
  /** Redirects to the hosted sign-in page. Ignored while signing out. */
  signIn(): void;
  /** Ends the session at the identity provider and returns to the start page. */
  signOut(): void;
  /** Marks the session as ended so the sign-in page is shown; never redirects. */
  endSession(): void;
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
