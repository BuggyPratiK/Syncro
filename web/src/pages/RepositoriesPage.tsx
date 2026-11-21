/**
 * Repositories: table plus an edit panel (a full-screen sheet on mobile).
 * Pausing sets `isActive: false`; the API has no delete, so a paused
 * repository stays listed and can be resumed. Paused repositories do not
 * count toward the active-repository limit.
 */

import { REQUEST_LIMITS, WORKSPACE_LIMITS, type DestinationDto, type RepoDto, type UpdateRepoBody } from "@contracts";
import { useCallback, useId, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useApi } from "../api/api-context";
import { ApiError } from "../api/errors";
import { useDestinations, useInvalidateWorkspace, useRepos } from "../api/queries";
import { Shell } from "../components/Shell";
import { StatusMark } from "../components/StatusMark";
import { DisabledNote, EmptyState, ErrorLine, Field, LoadingRows, PageHeader, SuccessLine } from "../components/ui";
import { repoStatus } from "../lib/status";
import { useAction } from "../lib/use-action";
import { PATHS } from "../paths";
import { useCanWrite, useWorkspace } from "../workspace/workspace-context";

export function RepositoriesPage() {
  const { workspaceId } = useWorkspace();
  const canWrite = useCanWrite();
  const repos = useRepos(workspaceId);
  const destinations = useDestinations(workspaceId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const clearSaved = useCallback(() => setSaved(false), []);

  const header = (
    <PageHeader
      kicker={repos.data ? `${repos.data.length} registered` : "Repositories"}
      title="Repositories"
      actions={
        canWrite ? (
          <Link className="btn-primary" to={PATHS.addRepositories}>
            Add repositories
          </Link>
        ) : null
      }
    >
      {repos.data ? (
        <p className="mt-2 text-[13px] text-mu">
          {repos.data.filter((r) => r.isActive).length} of {WORKSPACE_LIMITS.activeRepos} active repositories. Paused
          repositories don’t count toward the limit.
        </p>
      ) : null}
      {saved ? (
        <div className="mt-3">
          <SuccessLine message="Saved" onDone={clearSaved} />
        </div>
      ) : null}
    </PageHeader>
  );

  if (repos.isPending || destinations.isPending) {
    return (
      <Shell>
        {header}
        <LoadingRows />
      </Shell>
    );
  }
  if (repos.isError || destinations.isError) {
    return (
      <Shell>
        {header}
        <ErrorLine
          error={repos.error ?? destinations.error}
          onRetry={() => {
            void repos.refetch();
            void destinations.refetch();
          }}
        />
      </Shell>
    );
  }

  if (repos.data.length === 0) {
    return (
      <Shell>
        {header}
        <EmptyState
          title="No repositories yet"
          body="Connect GitHub and choose the repositories whose pushes and pull requests Syncro should relay."
          steps={["Connect GitHub", "Choose repositories", "Add a Discord destination"]}
          action={
            <Link className="btn-primary" to={PATHS.onboarding}>
              Start setup
            </Link>
          }
        />
      </Shell>
    );
  }

  const byId = new Map(destinations.data.map((d) => [d.destinationId, d]));
  const selected = repos.data.find((r) => r.repoId === selectedId) ?? null;

  return (
    <Shell>
      {header}
      <div className="flex gap-9 xl:gap-9">
        <div className="min-w-0 flex-1">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-ink">
                <th className="label py-2 font-normal">Repository</th>
                <th className="label hidden py-2 font-normal sm:table-cell">Status</th>
                <th className="label hidden py-2 font-normal xl:table-cell">Branch</th>
                <th className="label hidden py-2 font-normal md:table-cell">Destination</th>
                <th className="py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {repos.data.map((repo) => {
                const status = repoStatus(repo.isActive);
                const destination = repo.destinationId ? byId.get(repo.destinationId) : undefined;
                const isSelected = repo.repoId === selectedId;
                return (
                  <tr
                    key={repo.repoId}
                    className={`border-b border-ru align-top ${isSelected ? "bg-sf" : ""}`}
                  >
                    <td className={`border-l-3 py-2.75 pl-3 pr-3 ${isSelected ? "border-l-ac" : "border-l-transparent"}`}>
                      <span className="block truncate font-mono text-[12px]">{repo.fullName}</span>
                      <span className="mt-1 block sm:hidden">
                        <StatusMark {...status} />
                      </span>
                    </td>
                    <td className="hidden py-2.75 pr-3 sm:table-cell">
                      <StatusMark {...status} />
                    </td>
                    <td className="hidden py-2.75 pr-3 font-mono text-[12px] xl:table-cell">{repo.watchedBranch}</td>
                    <td className="hidden py-2.75 pr-3 md:table-cell">
                      <DestinationName destination={destination} />
                    </td>
                    <td className="py-2.75 text-right">
                      <button
                        type="button"
                        className="text-action inline-flex min-h-11 items-center sm:min-h-0"
                        onClick={() => setSelectedId(isSelected ? null : repo.repoId)}
                        aria-expanded={isSelected}
                      >
                        {isSelected ? "Close" : "Edit"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {selected ? (
          <EditPanel
            key={selected.repoId}
            workspaceId={workspaceId}
            repo={selected}
            destinations={destinations.data}
            canWrite={canWrite}
            activeCount={repos.data.filter((r) => r.isActive).length}
            onClose={() => setSelectedId(null)}
            onSaved={() => setSaved(true)}
          />
        ) : null}
      </div>
    </Shell>
  );
}

function DestinationName({ destination }: { destination: DestinationDto | undefined }) {
  if (!destination) return <span className="text-[13px] text-mu">No destination</span>;
  return (
    <span className="text-[13px]">
      {destination.displayName}
      {destination.status !== "active" ? <span className="text-mu"> (inactive)</span> : null}
    </span>
  );
}

function EditPanel({
  workspaceId,
  repo,
  destinations,
  canWrite,
  activeCount,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  repo: RepoDto;
  destinations: DestinationDto[];
  canWrite: boolean;
  activeCount: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useApi();
  const invalidate = useInvalidateWorkspace(workspaceId);
  const action = useAction();
  const branchId = useId();
  const destinationId = useId();
  const routingId = useId();
  const [isActive, setIsActive] = useState(repo.isActive);
  const [branch, setBranch] = useState(repo.watchedBranch);
  const [destination, setDestination] = useState(repo.destinationId ?? "");

  const patch: UpdateRepoBody = {};
  if (isActive !== repo.isActive) patch.isActive = isActive;
  if (branch !== repo.watchedBranch) patch.watchedBranch = branch;
  if (destination !== (repo.destinationId ?? "")) patch.destinationId = destination === "" ? null : destination;
  const dirty = Object.keys(patch).length > 0;
  const resumingAtLimit = isActive && !repo.isActive && activeCount >= WORKSPACE_LIMITS.activeRepos;

  const branchError =
    action.error instanceof ApiError &&
    action.error.code === "invalid_request" &&
    action.error.fields?.some((f) => f.startsWith("watchedBranch"))
      ? `Use one exact branch name, 1 to ${REQUEST_LIMITS.branchMax} characters, without leading or trailing spaces.`
      : undefined;

  const choices = destinations.filter((d) => d.status === "active" || d.destinationId === repo.destinationId);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!dirty) return;
    const result = await action.run(() => api.updateRepo(workspaceId, repo.repoId, patch));
    if (result.ok) {
      await invalidate();
      onSaved();
      onClose();
    }
  }

  return (
    <aside
      className="fixed inset-0 z-50 overflow-y-auto bg-bg px-5 py-6 sm:static sm:z-auto sm:w-80 sm:shrink-0 sm:border-l sm:border-ru sm:bg-transparent sm:py-0 sm:pl-7 sm:pr-0 xl:w-85"
      aria-label={`Edit ${repo.fullName}`}
    >
      <form onSubmit={save} className="flex flex-col gap-5">
        <div>
          <p className="label">Edit repository</p>
          <h2 className="break-all font-serif text-[22px] leading-tight">{repo.fullName}</h2>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend id={routingId} className="label mb-1.5">
            Routing
          </legend>
          {[
            { value: true, label: "Active", note: "Notifications are sent." },
            { value: false, label: "Paused", note: "Nothing is sent; the repository stays listed." },
          ].map((option) => (
            <label key={option.label} className="flex items-start gap-3">
              <input
                type="radio"
                name={routingId}
                checked={isActive === option.value}
                onChange={() => setIsActive(option.value)}
                disabled={!canWrite}
                className="mt-1"
              />
              <span>
                {option.label}
                <span className="block text-[12px] text-mu">{option.note}</span>
              </span>
            </label>
          ))}
          {resumingAtLimit ? (
            <p className="text-[12px] text-er">
              {WORKSPACE_LIMITS.activeRepos} repositories are already active. Pause another one first.
            </p>
          ) : null}
        </fieldset>

        <div>
          <p className="label mb-1.5">Events</p>
          <p className="text-[13px]">
            <span className="font-mono text-[12px]">push</span> · <span className="font-mono text-[12px]">pull_request</span>
          </p>
          <p className="text-[12px] text-mu">Both are always sent; they can’t be turned off per repository yet.</p>
        </div>

        <Field label="Branch" htmlFor={branchId} hint="One exact branch name." error={branchError}>
          <input
            id={branchId}
            className="input font-mono text-[12px]"
            value={branch}
            maxLength={REQUEST_LIMITS.branchMax}
            onChange={(e) => setBranch(e.target.value)}
            disabled={!canWrite}
          />
        </Field>

        <Field label="Destination" htmlFor={destinationId}>
          <select
            id={destinationId}
            className="input"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            disabled={!canWrite}
          >
            <option value="">No destination (nothing is sent)</option>
            {choices.map((d) => (
              <option key={d.destinationId} value={d.destinationId}>
                {d.displayName}
                {d.status !== "active" ? " (inactive)" : ""}
              </option>
            ))}
          </select>
        </Field>

        {action.error && !branchError ? <ErrorLine error={action.error} /> : null}
        {!canWrite ? <DisabledNote>Only the workspace owner can change repositories.</DisabledNote> : null}

        <div className="flex flex-wrap items-center gap-4 border-t border-ru pt-4">
          <button
            type="submit"
            className="btn-primary"
            disabled={!canWrite || !dirty || action.pending || resumingAtLimit}
          >
            {action.pending ? "Saving…" : "Save changes"}
          </button>
          <button type="button" className="text-action" onClick={onClose} disabled={action.pending}>
            Cancel
          </button>
        </div>
      </form>
    </aside>
  );
}
