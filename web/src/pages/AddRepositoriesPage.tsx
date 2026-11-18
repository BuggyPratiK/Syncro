import { Link, useNavigate } from "react-router";
import { Shell } from "../components/Shell";
import { DisabledNote, PageHeader } from "../components/ui";
import { RepoPicker } from "../features/RepoPicker";
import { PATHS } from "../paths";
import { useCanWrite, useWorkspace } from "../workspace/workspace-context";

export function AddRepositoriesPage() {
  const { workspaceId } = useWorkspace();
  const canWrite = useCanWrite();
  const navigate = useNavigate();
  return (
    <Shell>
      <PageHeader
        kicker="01"
        title="Add repositories"
        actions={
          <Link className="text-action" to={PATHS.repositories}>
            Back to Repositories
          </Link>
        }
      />
      <div className="max-w-[720px]">
        {canWrite ? (
          <RepoPicker workspaceId={workspaceId} onDone={() => navigate(PATHS.repositories)} />
        ) : (
          <DisabledNote>Only the workspace owner can add repositories.</DisabledNote>
        )}
      </div>
    </Shell>
  );
}
