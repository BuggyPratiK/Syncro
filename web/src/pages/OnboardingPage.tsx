/**
 * Onboarding: create the workspace, connect GitHub, choose repositories, add
 * a Discord destination and assign it. Each step's state is derived from the
 * server, so the page resumes correctly after a reload or a GitHub redirect.
 */

import { ORG_INSTALLATIONS_SUPPORTED, type DestinationDto, type RepoDto } from "@contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { useApi } from "../api/api-context";
import { describeError } from "../api/errors";
import { queryKeys, useDestinations, useInstallations, useInvalidateWorkspace, useMe, useRepos } from "../api/queries";
import { PlainLayout } from "../components/Shell";
import { ErrorLine, Field, LoadingRows, SectionHeader } from "../components/ui";
import { DestinationForm } from "../features/DestinationForm";
import { ConnectGitHubButton } from "../features/GitHubActions";
import { RepoPicker } from "../features/RepoPicker";
import { useAction } from "../lib/use-action";
import { PATHS } from "../paths";

export function OnboardingPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const api = useApi();

  const needsWorkspace = me.isSuccess && (!me.data.profile || me.data.workspaces.length === 0);

  // Bootstrap is idempotent on the server (an existing profile returns
  // `created: false`), so it runs as a one-shot query when it is needed.
  const bootstrap = useQuery({
    queryKey: ["bootstrap"],
    enabled: needsWorkspace,
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
    queryFn: async () => {
      const result = await api.bootstrap();
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
      return result;
    },
  });

  let body;
  if (me.isPending) body = <LoadingRows rows={3} />;
  else if (me.isError) body = <ErrorLine error={me.error} onRetry={() => void me.refetch()} />;
  else if (needsWorkspace && bootstrap.isError) {
    body = <ErrorLine error={bootstrap.error} onRetry={() => void bootstrap.refetch()} />;
  } else if (needsWorkspace) {
    body =
      bootstrap.isSuccess && !me.isFetching ? (
        <ErrorLine message="Your workspace isn’t available. Contact the Syncro maintainers if this continues." />
      ) : (
        <p role="status" className="text-mu">
          Creating your workspace…
        </p>
      );
  } else {
    body = <Steps workspaceId={me.data.workspaces[0].workspaceId} />;
  }

  return <PlainLayout>{body}</PlainLayout>;
}

interface StepDef {
  n: string;
  title: string;
  done: boolean;
}

function Steps({ workspaceId }: { workspaceId: string }) {
  const installations = useInstallations(workspaceId);
  const repos = useRepos(workspaceId);
  const destinations = useDestinations(workspaceId);
  const [viewing, setViewing] = useState<number | null>(null);

  if (installations.isPending || repos.isPending || destinations.isPending) return <LoadingRows rows={5} />;
  const failed = installations.error ?? repos.error ?? destinations.error;
  if (failed || !installations.data || !repos.data || !destinations.data) {
    return (
      <ErrorLine
        error={failed}
        onRetry={() => {
          void installations.refetch();
          void repos.refetch();
          void destinations.refetch();
        }}
      />
    );
  }

  const activeRepos = repos.data.filter((r) => r.isActive);
  const activeDestinations = destinations.data.filter((d) => d.status === "active");
  const activeDestinationIds = new Set(activeDestinations.map((d) => d.destinationId));
  const steps: StepDef[] = [
    { n: "00", title: "Sign in", done: true },
    { n: "01", title: "Connect GitHub", done: installations.data.some((i) => i.status === "active") },
    { n: "02", title: "Choose repositories", done: activeRepos.length > 0 },
    { n: "03", title: "Add a Discord destination", done: activeDestinations.length > 0 },
    {
      n: "04",
      title: "Assign the destination",
      done: activeRepos.some((r) => r.destinationId !== undefined && activeDestinationIds.has(r.destinationId)),
    },
  ];
  const firstOpen = steps.findIndex((s) => !s.done);
  const complete = firstOpen === -1;
  const shown = viewing ?? (complete ? steps.length - 1 : firstOpen);

  return (
    <div>
      <div className="mb-8 flex flex-col gap-3">
        <div className="flex gap-1" aria-hidden="true">
          {steps.map((s, i) => (
            <span key={s.n} className={`h-0.75 flex-1 ${s.done ? "bg-ink" : i === shown ? "bg-ac" : "bg-ru"}`} />
          ))}
        </div>
        <p className="text-[13px] text-mu">
          {complete ? "Setup complete" : `Step ${firstOpen + 1} of ${steps.length} · ${steps[firstOpen].title}`}
        </p>
      </div>

      <div className="flex flex-col gap-10 lg:flex-row lg:gap-16">
        <ol className="lg:w-82.5 lg:shrink-0" aria-label="Setup steps">
          {steps.map((s, i) => (
            <li key={s.n} className="border-b border-ru">
              <button
                type="button"
                className={`flex w-full items-center gap-3 py-2.75 text-left ${i === shown ? "font-semibold text-ac" : ""}`}
                aria-current={i === shown ? "step" : undefined}
                onClick={() => setViewing(i)}
              >
                <StepGlyph state={s.done ? "done" : i === firstOpen ? "current" : "upcoming"} />
                <span className="font-mono text-[12px] text-mu">{s.n}</span>
                <span>{s.title}</span>
                <span className="sr-only">{s.done ? "(done)" : i === firstOpen ? "(current)" : "(not started)"}</span>
              </button>
            </li>
          ))}
        </ol>

        <section className="min-w-0 max-w-155 flex-1">
          {complete && viewing === null ? (
            <Complete />
          ) : (
            <StepPanel
              index={shown}
              workspaceId={workspaceId}
              installationCount={installations.data.length}
              activeRepos={activeRepos}
              activeDestinations={activeDestinations}
              onNext={() => setViewing(null)}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function StepGlyph({ state }: { state: "done" | "current" | "upcoming" }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false" className="shrink-0">
      {state === "done" ? (
        <circle cx="6" cy="6" r="5" fill="var(--ink)" />
      ) : state === "current" ? (
        <circle cx="6" cy="6" r="4.75" fill="none" stroke="var(--ac)" strokeWidth="1.5" />
      ) : (
        <circle cx="6" cy="6" r="4.75" fill="none" stroke="var(--mu)" strokeWidth="1.5" strokeDasharray="2 2" />
      )}
    </svg>
  );
}

function StepPanel({
  index,
  workspaceId,
  installationCount,
  activeRepos,
  activeDestinations,
  onNext,
}: {
  index: number;
  workspaceId: string;
  installationCount: number;
  activeRepos: RepoDto[];
  activeDestinations: DestinationDto[];
  onNext: () => void;
}) {
  switch (index) {
    case 0:
      return (
        <StepBody title="Signed in">
          <p>Your Syncro workspace is ready.</p>
        </StepBody>
      );
    case 1:
      return (
        <StepBody title="Connect GitHub">
          <p>
            Install the Syncro GitHub App on your account and choose which repositories it can see. GitHub then
            returns you here.
          </p>
          <ul className="list-disc pl-5 text-[13px] text-mu">
            <li>Personal accounts are supported.</li>
            {ORG_INSTALLATIONS_SUPPORTED ? (
              <li>
                For an organization, you must be an organization admin, and the organization must approve the App’s
                read-only access to its member list.
              </li>
            ) : (
              <li>Organization installations are not supported yet.</li>
            )}
          </ul>
          <ConnectGitHubButton workspaceId={workspaceId} installationCount={installationCount} />
          <p className="text-[12px] text-mu">
            Ended up on GitHub instead of back here? The app was probably installed on that account before.
            Uninstall it in GitHub (Settings, Applications, Installed GitHub Apps), then connect again.
          </p>
        </StepBody>
      );
    case 2:
      return (
        <StepBody title="Choose repositories">
          <RepoPicker workspaceId={workspaceId} onDone={onNext} />
        </StepBody>
      );
    case 3:
      return (
        <StepBody title="Add a Discord destination">
          <p>Paste the webhook URL of the Discord channel that should receive notifications.</p>
          <p className="text-[13px] text-mu">
            Everyone in that channel will see commit messages and pull request titles, including from private
            repositories.
          </p>
          <DestinationForm workspaceId={workspaceId} activeCount={activeDestinations.length} onCreated={onNext} />
        </StepBody>
      );
    default:
      return (
        <StepBody title="Assign the destination">
          <AssignForm
            workspaceId={workspaceId}
            repos={activeRepos}
            destinations={activeDestinations}
            onDone={onNext}
          />
        </StepBody>
      );
  }
}

function StepBody({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-5">
      <h1 className="font-serif text-[32px] leading-tight lg:text-[44px]">{title}</h1>
      {children}
    </div>
  );
}

function AssignForm({
  workspaceId,
  repos,
  destinations,
  onDone,
}: {
  workspaceId: string;
  repos: RepoDto[];
  destinations: DestinationDto[];
  onDone: () => void;
}) {
  const api = useApi();
  const invalidate = useInvalidateWorkspace(workspaceId);
  const action = useAction();
  const selectId = useId();
  const [destinationId, setDestinationId] = useState(destinations[0]?.destinationId ?? "");
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(repos.filter((r) => !r.destinationId).map((r) => r.repoId)),
  );
  const [failures, setFailures] = useState<Record<string, string>>({});

  if (repos.length === 0 || destinations.length === 0) {
    return <p className="text-mu">Add at least one repository and one destination first.</p>;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const failed: Record<string, string> = {};
    await action.run(async () => {
      for (const repoId of chosen) {
        try {
          await api.updateRepo(workspaceId, repoId, { destinationId });
        } catch (error) {
          failed[repoId] = describeError(error);
        }
      }
    });
    setFailures(failed);
    await invalidate();
    if (Object.keys(failed).length === 0) onDone();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <Field label="Destination" htmlFor={selectId}>
        <select id={selectId} className="input" value={destinationId} onChange={(e) => setDestinationId(e.target.value)}>
          {destinations.map((d) => (
            <option key={d.destinationId} value={d.destinationId}>
              {d.displayName}
            </option>
          ))}
        </select>
      </Field>
      <div>
        <SectionHeader>Repositories</SectionHeader>
        <ul>
          {repos.map((r) => (
            <li key={r.repoId} className="border-b border-ru py-2.75">
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={chosen.has(r.repoId)}
                  onChange={() =>
                    setChosen((prev) => {
                      const next = new Set(prev);
                      if (next.has(r.repoId)) next.delete(r.repoId);
                      else next.add(r.repoId);
                      return next;
                    })
                  }
                />
                <span className="font-mono text-[12px]">{r.fullName}</span>
              </label>
              {failures[r.repoId] ? <p className="mt-1 pl-7 text-[12px] text-er">{failures[r.repoId]}</p> : null}
            </li>
          ))}
        </ul>
      </div>
      <p className="text-[13px] text-mu">
        Syncro sends push and pull request events for the watched branch. Both are always on.
      </p>
      {action.error ? <ErrorLine error={action.error} /> : null}
      <div>
        <button type="submit" className="btn-primary" disabled={action.pending || chosen.size === 0}>
          {action.pending ? "Saving…" : "Assign destination"}
        </button>
      </div>
    </form>
  );
}

function Complete() {
  return (
    <div className="flex flex-col gap-5">
      <h1 className="font-serif text-[32px] leading-tight lg:text-[44px]">You’re set up</h1>
      <p>Pushes and pull requests on your watched branches now go to Discord.</p>
      <p className="flex flex-wrap gap-4">
        <Link className="btn-primary" to={PATHS.repositories}>
          Go to Repositories
        </Link>
        <Link className="text-action self-center" to={PATHS.activity}>
          View activity
        </Link>
      </p>
    </div>
  );
}
