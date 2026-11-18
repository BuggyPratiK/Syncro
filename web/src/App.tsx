import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router";
import { useRepos } from "./api/queries";
import { RequireAuth } from "./auth/RequireAuth";
import { PlainLayout } from "./components/Shell";
import { ErrorLine, LoadingRows } from "./components/ui";
import { AccountPage } from "./pages/AccountPage";
import { ActivityPage } from "./pages/ActivityPage";
import { AddRepositoriesPage } from "./pages/AddRepositoriesPage";
import { DestinationsPage } from "./pages/DestinationsPage";
import { GitHubSetupPage } from "./pages/GitHubSetupPage";
import { PrivacyPage, TermsPage } from "./pages/LegalPages";
import { OnboardingPage } from "./pages/OnboardingPage";
import { RepositoriesPage } from "./pages/RepositoriesPage";
import { PATHS } from "./paths";
import { useWorkspace, WorkspaceGate } from "./workspace/workspace-context";

/** Signed-in, workspace-scoped page. */
function WorkspaceRoute({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <WorkspaceGate>{children}</WorkspaceGate>
    </RequireAuth>
  );
}

/** `/`: new workspaces start in onboarding; everyone else lands on Repositories. */
function Home() {
  const { workspaceId } = useWorkspace();
  const repos = useRepos(workspaceId);
  if (repos.isPending) {
    return (
      <PlainLayout>
        <LoadingRows rows={2} />
      </PlainLayout>
    );
  }
  if (repos.isError) {
    return (
      <PlainLayout>
        <ErrorLine error={repos.error} onRetry={() => void repos.refetch()} />
      </PlainLayout>
    );
  }
  return <Navigate to={repos.data.length === 0 ? PATHS.onboarding : PATHS.repositories} replace />;
}

function NotFound() {
  return (
    <PlainLayout>
      <h1 className="font-serif text-[38px]">Page not found</h1>
      <p className="mt-2 text-mu">This page doesn’t exist.</p>
    </PlainLayout>
  );
}

/**
 * Routes. `callback` is supplied by the entry point so the Logto SDK is only
 * loaded where it is used (tests and fixture mode provide their own).
 */
export function App({ callback }: { callback: ReactNode }) {
  return (
    <Routes>
      <Route path={PATHS.privacy} element={<PrivacyPage />} />
      <Route path={PATHS.terms} element={<TermsPage />} />
      <Route path={PATHS.callback} element={callback} />

      <Route
        path={PATHS.home}
        element={
          <WorkspaceRoute>
            <Home />
          </WorkspaceRoute>
        }
      />
      <Route
        path={PATHS.onboarding}
        element={
          <RequireAuth>
            <OnboardingPage />
          </RequireAuth>
        }
      />
      <Route
        path={PATHS.githubSetup}
        element={
          <RequireAuth>
            <GitHubSetupPage />
          </RequireAuth>
        }
      />
      <Route path={PATHS.repositories} element={<WorkspaceRoute><RepositoriesPage /></WorkspaceRoute>} />
      <Route path={PATHS.addRepositories} element={<WorkspaceRoute><AddRepositoriesPage /></WorkspaceRoute>} />
      <Route path={PATHS.activity} element={<WorkspaceRoute><ActivityPage /></WorkspaceRoute>} />
      <Route path={PATHS.destinations} element={<WorkspaceRoute><DestinationsPage /></WorkspaceRoute>} />
      <Route path={PATHS.account} element={<WorkspaceRoute><AccountPage /></WorkspaceRoute>} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
