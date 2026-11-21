/**
 * Chooses repositories from the verified GitHub listing and registers them.
 * Only repositories the user administers can be added; the server checks the
 * listing again and is the authority.
 */

import {
  DEFAULT_WATCHED_BRANCH,
  REQUEST_LIMITS,
  WORKSPACE_LIMITS,
  type RegisterRepoBody,
  type RepoListingDto,
} from "@contracts";
import { useId, useState, type FormEvent } from "react";
import { useApi } from "../api/api-context";
import { ApiError, describeError } from "../api/errors";
import { useDestinations, useInstallations, useInvalidateWorkspace, useRepos } from "../api/queries";
import { StatusMark } from "../components/StatusMark";
import { ErrorLine, Field, LoadingRows, SectionHeader } from "../components/ui";
import { useListing } from "../github/listing-store";
import { formatTime } from "../lib/format";
import { ConnectGitHubButton, LoadRepositoriesButton } from "./GitHubActions";

type RowResult = { ok: true } | { ok: false; message: string };

export function RepoPicker({ workspaceId, onDone }: { workspaceId: string; onDone?: () => void }) {
  const listing = useListing();
  const installations = useInstallations(workspaceId);

  if (installations.isPending) return <LoadingRows rows={3} />;
  if (installations.isError) {
    return <ErrorLine error={installations.error} onRetry={() => void installations.refetch()} />;
  }

  const active = installations.data.filter((i) => i.status === "active");
  if (!listing) {
    return (
      <div className="flex flex-col gap-6">
        {active.length === 0 ? (
          <>
            <p>Connect GitHub first. Syncro lists only repositories you administer.</p>
            <ConnectGitHubButton workspaceId={workspaceId} installationCount={installations.data.length} />
          </>
        ) : (
          <>
            <p>
              Syncro needs a fresh list of your repositories from GitHub. GitHub asks you to confirm, then
              returns you here.
            </p>
            <LoadRepositoriesButton workspaceId={workspaceId} installations={installations.data} />
            <div className="border-t border-ru pt-4">
              <p className="mb-3 text-[13px] text-mu">Repositories in another account or organization?</p>
              <ConnectGitHubButton
                workspaceId={workspaceId}
                installationCount={installations.data.length}
                label="Connect another account"
                secondary
              />
            </div>
          </>
        )}
      </div>
    );
  }
  return <ListingChooser workspaceId={workspaceId} listing={listing} onDone={onDone} />;
}

function ListingChooser({
  workspaceId,
  listing,
  onDone,
}: {
  workspaceId: string;
  listing: RepoListingDto;
  onDone?: () => void;
}) {
  const repos = useRepos(workspaceId);
  if (repos.isPending) return <LoadingRows rows={4} />;
  if (repos.isError) return <ErrorLine error={repos.error} onRetry={() => void repos.refetch()} />;
  const activeIds = new Set(repos.data.filter((r) => r.isActive).map((r) => r.repoId));
  return <ChooserForm workspaceId={workspaceId} listing={listing} activeIds={activeIds} onDone={onDone} />;
}

/**
 * Repositories that can be added now, pre-selected in name order up to the free
 * active-repository slots. GitHub already asked which repositories the App may
 * read, so the usual case is to add all of them; the user can still untick any.
 */
function preselect(listing: RepoListingDto, activeIds: Set<string>): Set<string> {
  const remaining = WORKSPACE_LIMITS.activeRepos - activeIds.size;
  const eligible = [...listing.repos]
    .filter((r) => r.admin && !activeIds.has(r.repoId))
    .sort((a, b) => a.fullName.localeCompare(b.fullName))
    .slice(0, Math.max(0, remaining));
  return new Set(eligible.map((r) => r.repoId));
}

function ChooserForm({
  workspaceId,
  listing,
  activeIds,
  onDone,
}: {
  workspaceId: string;
  listing: RepoListingDto;
  activeIds: Set<string>;
  onDone?: () => void;
}) {
  const api = useApi();
  const destinations = useDestinations(workspaceId);
  const invalidate = useInvalidateWorkspace(workspaceId);
  const branchId = useId();
  const destinationId = useId();
  const [selected, setSelected] = useState<Set<string>>(() => preselect(listing, activeIds));
  const [branch, setBranch] = useState<string>(DEFAULT_WATCHED_BRANCH);
  const [destination, setDestination] = useState("");
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const [busy, setBusy] = useState(false);
  const [stopError, setStopError] = useState<unknown>(null);

  const activeDestinations = (destinations.data ?? []).filter((d) => d.status === "active");
  const sorted = [...listing.repos].sort((a, b) => a.fullName.localeCompare(b.fullName));
  const remaining = WORKSPACE_LIMITS.activeRepos - activeIds.size;
  const overLimit = selected.size > remaining;

  function toggle(repoId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(repoId)) next.delete(repoId);
      else next.add(repoId);
      return next;
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || selected.size === 0 || overLimit) return;
    setBusy(true);
    setStopError(null);
    const outcome: Record<string, RowResult> = {};
    for (const repoId of selected) {
      const body: RegisterRepoBody = {
        listingId: listing.listingId,
        repoId,
        watchedBranch: branch.trim() || DEFAULT_WATCHED_BRANCH,
        ...(destination ? { destinationId: destination } : {}),
      };
      try {
        await api.registerRepo(workspaceId, body);
        outcome[repoId] = { ok: true };
      } catch (error) {
        outcome[repoId] = { ok: false, message: describeError(error) };
        // Stop on refusals that will repeat for every remaining repository.
        if (error instanceof ApiError && ["rate_limited", "listing_invalid", "repo_limit_reached", "unauthenticated"].includes(error.code)) {
          setStopError(error);
          break;
        }
      }
    }
    setResults(outcome);
    setSelected(new Set());
    setBusy(false);
    await invalidate();
    const all = Object.values(outcome);
    if (onDone && all.length > 0 && all.every((r) => r.ok)) onDone();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <p className="text-[13px] text-mu">
        GitHub decided which repositories Syncro may read. Choose which of them post to Discord; you can
        pause or change them later. Only repositories you administer can be added.
      </p>
      <div>
        <SectionHeader aside={`${activeIds.size} of ${WORKSPACE_LIMITS.activeRepos} active · ${selected.size} selected`}>
          Repositories
        </SectionHeader>
        <ul>
          {sorted.map((repo) => {
            const added = activeIds.has(repo.repoId);
            const disabled = added || !repo.admin || busy;
            const result = results[repo.repoId];
            return (
              <li key={repo.repoId} className="border-b border-ru py-2.75">
                <label className={`flex min-h-7 items-center gap-3 ${disabled ? "text-mu" : ""}`}>
                  <input
                    type="checkbox"
                    checked={added || selected.has(repo.repoId)}
                    disabled={disabled}
                    onChange={() => toggle(repo.repoId)}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{repo.fullName}</span>
                  {added ? (
                    <StatusMark kind="ok" label="Added" />
                  ) : !repo.admin ? (
                    <span className="text-[12px]">Needs admin access</span>
                  ) : null}
                </label>
                {result && !result.ok ? <p className="mt-1 pl-7 text-[12px] text-er">{result.message}</p> : null}
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-[12px] text-mu">This list is valid until {formatTime(listing.expiresAt)}.</p>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Branch to watch" htmlFor={branchId} hint="One exact branch name, used for every repository added now.">
          <input
            id={branchId}
            className="input font-mono text-[12px]"
            value={branch}
            maxLength={REQUEST_LIMITS.branchMax}
            onChange={(e) => setBranch(e.target.value)}
          />
        </Field>
        <Field label="Destination" htmlFor={destinationId} hint="Optional. You can assign one later.">
          <select
            id={destinationId}
            className="input"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
          >
            <option value="">No destination yet</option>
            {activeDestinations.map((d) => (
              <option key={d.destinationId} value={d.destinationId}>
                {d.displayName}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {overLimit ? (
        <p className="text-[13px] text-er" role="alert">
          You can add {remaining} more active {remaining === 1 ? "repository" : "repositories"} (limit{" "}
          {WORKSPACE_LIMITS.activeRepos}).
        </p>
      ) : null}
      {stopError ? <ErrorLine error={stopError} /> : null}

      <div>
        <button type="submit" className="btn-primary" disabled={busy || selected.size === 0 || overLimit}>
          {busy ? "Adding…" : selected.size > 1 ? `Add ${selected.size} repositories` : "Add repository"}
        </button>
      </div>
    </form>
  );
}
