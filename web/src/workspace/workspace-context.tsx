import { roleSatisfies, type WorkspaceMembershipDto } from "@contracts";
import { createContext, useContext, type ReactNode } from "react";
import { Navigate } from "react-router";
import { useMe } from "../api/queries";
import { PlainLayout } from "../components/Shell";
import { ErrorLine, LoadingRows } from "../components/ui";
import { PATHS } from "../paths";

const WorkspaceContext = createContext<WorkspaceMembershipDto | null>(null);

/**
 * Resolves the signed-in user's workspace. Users without a profile or
 * workspace are sent to onboarding, which creates them.
 */
export function WorkspaceGate({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.isPending) {
    return (
      <PlainLayout>
        <LoadingRows rows={3} />
      </PlainLayout>
    );
  }
  if (me.isError) {
    return (
      <PlainLayout>
        <ErrorLine error={me.error} onRetry={() => void me.refetch()} />
      </PlainLayout>
    );
  }
  const membership = me.data.workspaces[0];
  if (!me.data.profile || !membership) return <Navigate to={PATHS.onboarding} replace />;
  return <WorkspaceContext.Provider value={membership}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceMembershipDto {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside WorkspaceGate");
  return value;
}

/** Writes are owner-only per the route table; the server enforces it regardless. */
export function useCanWrite(): boolean {
  return roleSatisfies(useWorkspace().role, "owner");
}
