import { LogtoProvider, useLogto, type LogtoConfig } from "@logto/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AppConfig } from "../config";
import { PATHS } from "../paths";
import { AuthProvider, type AuthState } from "./auth-context";

type Phase = "active" | "signing_out" | "ended";

function LogtoBridge({ resource, children }: { resource: string; children: ReactNode }) {
  const logto = useLogto();
  const [phase, setPhase] = useState<Phase>("active");
  // The SDK's functions are not referentially stable; keep the latest in a ref
  // so consumers get a stable AuthState between authentication changes.
  const latest = useRef(logto);
  useEffect(() => {
    latest.current = logto;
  });
  // Read synchronously by signIn: a sign-in requested after sign-out started
  // (for example by a request still in flight) must never be sent.
  const signingOut = useRef(false);

  const value = useMemo<AuthState>(
    () => ({
      isAuthenticated: logto.isAuthenticated && phase === "active",
      isLoading: logto.isLoading,
      isSigningOut: phase === "signing_out",
      sessionEnded: phase === "ended",
      signIn: () => {
        if (signingOut.current) return;
        void latest.current.signIn(`${window.location.origin}${PATHS.callback}`);
      },
      signOut: () => {
        signingOut.current = true;
        // Unmount the signed-in app first so nothing else requests a token.
        setPhase("signing_out");
        void latest.current.signOut(`${window.location.origin}/`);
      },
      endSession: () => setPhase((p) => (p === "signing_out" ? p : "ended")),
      getAccessToken: async () => (await latest.current.getAccessToken(resource)) ?? null,
    }),
    [logto.isAuthenticated, logto.isLoading, phase, resource],
  );

  return <AuthProvider value={value}>{children}</AuthProvider>;
}

export function LogtoAuth({ config, children }: { config: AppConfig; children: ReactNode }) {
  const logtoConfig = useMemo<LogtoConfig>(
    () => ({
      endpoint: config.logtoEndpoint,
      appId: config.logtoAppId,
      resources: [config.apiResource],
    }),
    [config],
  );
  return (
    <LogtoProvider config={logtoConfig}>
      <LogtoBridge resource={config.apiResource}>{children}</LogtoBridge>
    </LogtoProvider>
  );
}
