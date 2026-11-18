/**
 * Destinations: one ruled block per Discord destination. Stored webhook URLs
 * are never shown; the API returns only a masked form built from the
 * non-secret webhook ID. Replacing a URL is write-only.
 */

import { REQUEST_LIMITS, WORKSPACE_LIMITS, type DestinationDto, type RepoDto } from "@contracts";
import { useCallback, useId, useState, type FormEvent } from "react";
import { useApi } from "../api/api-context";
import { ApiError, describeError } from "../api/errors";
import { useDestinations, useInvalidateWorkspace, useRepos } from "../api/queries";
import { Shell } from "../components/Shell";
import { StatusMark } from "../components/StatusMark";
import { WebhookUrlInput } from "../components/WebhookUrlInput";
import {
  ConfirmDialog,
  DisabledNote,
  EmptyState,
  ErrorLine,
  Field,
  LoadingRows,
  PageHeader,
  SuccessLine,
} from "../components/ui";
import { DestinationForm } from "../features/DestinationForm";
import { destinationStatus } from "../lib/status";
import { useAction } from "../lib/use-action";
import { useCanWrite, useWorkspace } from "../workspace/workspace-context";

export function DestinationsPage() {
  const { workspaceId } = useWorkspace();
  const canWrite = useCanWrite();
  const destinations = useDestinations(workspaceId);
  const repos = useRepos(workspaceId);
  const [adding, setAdding] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const clearSuccess = useCallback(() => setSuccess(null), []);

  const activeCount = destinations.data?.filter((d) => d.status === "active").length ?? 0;
  const atLimit = activeCount >= WORKSPACE_LIMITS.activeDestinations;

  const header = (
    <PageHeader
      kicker={destinations.data ? `${destinations.data.length} configured` : "Destinations"}
      title="Destinations"
      actions={
        canWrite && !adding ? (
          <button type="button" className="btn-primary" onClick={() => setAdding(true)} disabled={atLimit || !destinations.data}>
            Add destination
          </button>
        ) : null
      }
    >
      {destinations.data ? (
        <p className="mt-2 text-[13px] text-mu">
          {activeCount} of {WORKSPACE_LIMITS.activeDestinations} active destinations. Only Discord is supported.
        </p>
      ) : null}
      {success ? (
        <div className="mt-3">
          <SuccessLine message={success} onDone={clearSuccess} />
        </div>
      ) : null}
    </PageHeader>
  );

  const addForm = adding ? (
    <section className="mb-10 border-t border-ink pt-4">
      <h2 className="mb-4 font-serif text-[22px]">New Discord destination</h2>
      <div className="max-w-[620px]">
        <DestinationForm
          workspaceId={workspaceId}
          activeCount={activeCount}
          onCreated={() => {
            setAdding(false);
            setSuccess("Destination added");
          }}
          onCancel={() => setAdding(false)}
        />
      </div>
    </section>
  ) : null;

  if (destinations.isPending || repos.isPending) {
    return (
      <Shell>
        {header}
        <LoadingRows rows={3} />
      </Shell>
    );
  }
  if (destinations.isError || repos.isError) {
    return (
      <Shell>
        {header}
        <ErrorLine
          error={destinations.error ?? repos.error}
          onRetry={() => {
            void destinations.refetch();
            void repos.refetch();
          }}
        />
      </Shell>
    );
  }

  if (destinations.data.length === 0) {
    return (
      <Shell>
        {header}
        {addForm ?? (
          <EmptyState
            title="No destinations yet"
            body="A destination is a Discord channel webhook. Syncro posts each repository’s activity to the destination you assign to it."
            steps={["Create a webhook in Discord", "Add it here", "Assign it to repositories"]}
            action={
              canWrite ? (
                <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
                  Add destination
                </button>
              ) : null
            }
          />
        )}
      </Shell>
    );
  }

  return (
    <Shell>
      {header}
      {addForm}
      <div className="flex flex-col gap-10">
        {destinations.data.map((d) => (
          <DestinationBlock
            key={d.destinationId}
            workspaceId={workspaceId}
            destination={d}
            usedBy={repos.data.filter((r) => r.destinationId === d.destinationId)}
            canWrite={canWrite}
            atLimit={atLimit}
            onSuccess={setSuccess}
          />
        ))}
      </div>
    </Shell>
  );
}

type Mode = "idle" | "rename" | "replace" | "deactivate";

function DestinationBlock({
  workspaceId,
  destination,
  usedBy,
  canWrite,
  atLimit,
  onSuccess,
}: {
  workspaceId: string;
  destination: DestinationDto;
  usedBy: RepoDto[];
  canWrite: boolean;
  atLimit: boolean;
  onSuccess: (message: string) => void;
}) {
  const api = useApi();
  const invalidate = useInvalidateWorkspace(workspaceId);
  const action = useAction();
  const [mode, setMode] = useState<Mode>("idle");
  const status = destinationStatus(destination.status);
  const active = destination.status === "active";
  const activeUsers = usedBy.filter((r) => r.isActive);

  async function setActive(isActive: boolean) {
    const result = await action.run(() => api.updateDestination(workspaceId, destination.destinationId, { isActive }));
    if (result.ok) {
      setMode("idle");
      await invalidate();
      onSuccess(isActive ? "Destination reactivated" : "Destination deactivated");
    }
  }

  return (
    <section className="border-t border-ink pt-4" aria-labelledby={`dest-${destination.destinationId}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id={`dest-${destination.destinationId}`} className="font-serif text-[22px] lg:text-[24px]">
          {destination.displayName}
        </h2>
        <StatusMark {...status} />
      </div>
      <p className="mt-2 break-all font-mono text-[11px] text-mu sm:text-[12px]">{destination.webhookUrlMasked}</p>
      <p className="mt-3 text-[13px]">
        <span className="label mr-2">Used by</span>
        {usedBy.length === 0 ? (
          <span className="text-mu">No repositories</span>
        ) : (
          usedBy.map((r, i) => (
            <span key={r.repoId}>
              {i > 0 ? ", " : ""}
              <span className="font-mono text-[12px]">{r.fullName}</span>
              {!r.isActive ? <span className="text-mu"> (paused)</span> : null}
            </span>
          ))
        )}
      </p>
      {destination.status === "pending_secret" ? (
        <p className="mt-2 text-[13px] text-mu">
          Saving the webhook URL didn’t finish, so this destination never sends. Add the destination again.
        </p>
      ) : null}

      {canWrite && destination.status !== "pending_secret" ? (
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[13px]">
          {active ? (
            <>
              <button type="button" className="text-action" onClick={() => setMode("rename")} disabled={action.pending}>
                Rename
              </button>
              <button type="button" className="text-action" onClick={() => setMode("replace")} disabled={action.pending}>
                Replace URL
              </button>
              <button
                type="button"
                className="text-action text-er"
                onClick={() => setMode("deactivate")}
                disabled={action.pending}
              >
                Deactivate
              </button>
            </>
          ) : (
            <button
              type="button"
              className="text-action"
              onClick={() => void setActive(true)}
              disabled={action.pending || atLimit}
            >
              {action.pending ? "Reactivating…" : "Reactivate"}
            </button>
          )}
        </div>
      ) : null}
      {!active && atLimit && canWrite && destination.status === "inactive" ? (
        <DisabledNote>Deactivate another destination before reactivating this one.</DisabledNote>
      ) : null}
      {mode === "idle" && action.error ? (
        <div className="mt-3">
          <ErrorLine error={action.error} />
        </div>
      ) : null}

      {mode === "rename" ? (
        <RenameForm
          workspaceId={workspaceId}
          destination={destination}
          onClose={() => setMode("idle")}
          onSaved={() => {
            setMode("idle");
            onSuccess("Saved");
          }}
        />
      ) : null}
      {mode === "replace" ? (
        <ReplaceUrlForm
          workspaceId={workspaceId}
          destination={destination}
          onClose={() => setMode("idle")}
          onSaved={() => {
            setMode("idle");
            onSuccess("Webhook URL replaced");
          }}
        />
      ) : null}
      {mode === "deactivate" ? (
        <ConfirmDialog
          title={`Deactivate ${destination.displayName}?`}
          confirmLabel="Deactivate"
          destructive
          busy={action.pending}
          onCancel={() => {
            action.reset();
            setMode("idle");
          }}
          onConfirm={() => void setActive(false)}
        >
          {activeUsers.length > 0 ? (
            <>
              <p>These repositories will stop sending notifications until you assign another destination:</p>
              <ul className="mt-2">
                {activeUsers.map((r) => (
                  <li key={r.repoId} className="border-b border-ru py-1.5 font-mono text-[12px]">
                    {r.fullName}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>No active repository uses this destination.</p>
          )}
          {action.error ? <p className="mt-3 text-[13px] text-er">{describeError(action.error)}</p> : null}
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

function RenameForm({
  workspaceId,
  destination,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  destination: DestinationDto;
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useApi();
  const invalidate = useInvalidateWorkspace(workspaceId);
  const action = useAction();
  const id = useId();
  const [name, setName] = useState(destination.displayName);
  const trimmed = name.trim();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await action.run(() =>
      api.updateDestination(workspaceId, destination.destinationId, { displayName: trimmed }),
    );
    if (result.ok) {
      await invalidate();
      onSaved();
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 flex max-w-[620px] flex-col gap-4 border-l-[3px] border-l-ac bg-sf p-4">
      <Field label="Name" htmlFor={id}>
        <input
          id={id}
          className="input"
          value={name}
          maxLength={REQUEST_LIMITS.displayNameMax}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </Field>
      {action.error ? <ErrorLine error={action.error} /> : null}
      <div className="flex gap-4">
        <button
          type="submit"
          className="btn-primary"
          disabled={action.pending || trimmed.length === 0 || trimmed === destination.displayName}
        >
          {action.pending ? "Saving…" : "Save name"}
        </button>
        <button type="button" className="text-action" onClick={onClose} disabled={action.pending}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ReplaceUrlForm({
  workspaceId,
  destination,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  destination: DestinationDto;
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useApi();
  const invalidate = useInvalidateWorkspace(workspaceId);
  const action = useAction();
  const id = useId();
  const [url, setUrl] = useState("");
  const urlError =
    action.error instanceof ApiError && action.error.code === "invalid_webhook_url" ? describeError(action.error) : undefined;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const webhookUrl = url.trim();
    // Clear the secret from component state before the request settles.
    setUrl("");
    const result = await action.run(() => api.replaceWebhook(workspaceId, destination.destinationId, { webhookUrl }));
    if (result.ok) {
      await invalidate();
      onSaved();
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 flex max-w-[620px] flex-col gap-4 border-l-[3px] border-l-ac bg-sf p-4" autoComplete="off">
      <div>
        <p className="label">Current URL</p>
        <p className="break-all font-mono text-[12px]">{destination.webhookUrlMasked}</p>
        <p className="text-[12px] text-mu">Stored URLs are never revealed.</p>
      </div>
      <ol className="text-[13px]">
        {[
          "In Discord, open the channel’s Integrations settings.",
          "Create a new webhook, or open the existing one and copy its URL.",
          "Paste it below. The old URL stops being used as soon as you save.",
        ].map((step, i) => (
          <li key={step} className="flex gap-3 border-b border-ru py-1.5">
            <span className="font-mono text-[12px] text-mu">{String(i + 1).padStart(2, "0")}</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      <WebhookUrlInput id={id} label="New webhook URL" value={url} onChange={setUrl} error={urlError} />
      {action.error && !urlError ? <ErrorLine error={action.error} /> : null}
      <div className="flex gap-4">
        <button type="submit" className="btn-primary" disabled={action.pending || url.trim().length === 0}>
          {action.pending ? "Saving…" : "Save new URL"}
        </button>
        <button type="button" className="text-action" onClick={onClose} disabled={action.pending}>
          Cancel
        </button>
      </div>
    </form>
  );
}
