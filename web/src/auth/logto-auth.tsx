import { LogtoProvider, useLogto, type LogtoConfig } from "@logto/react";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { AppConfig } from "../config";
import { PATHS } from "../paths";
import { AuthProvider, type AuthState } from "./auth-context";

function LogtoBridge({ resource, children }: { resource: string; children: ReactNode }) {
  const logto = useLogto();
  // The SDK's functions are not referentially stable; keep the latest in a ref
  // so consumers get a stable AuthState between authentication changes.
  const latest = useRef(logto);
  useEffect(() => {
    latest.current = logto;
  });

  const value = useMemo<AuthState>(
    () => ({
      isAuthenticated: logto.isAuthenticated,
      isLoading: logto.isLoading,
      signIn: () => {
        void latest.current.signIn(`${window.location.origin}${PATHS.callback}`);
      },
      signOut: () => {
        void latest.current.signOut(`${window.location.origin}/`);
      },
      getAccessToken: async () => (await latest.current.getAccessToken(resource)) ?? null,
    }),
    [logto.isAuthenticated, logto.isLoading, resource],
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
