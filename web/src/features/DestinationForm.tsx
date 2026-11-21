import { REQUEST_LIMITS, WORKSPACE_LIMITS, type DestinationDto } from "@contracts";
import { useId, useState, type FormEvent } from "react";
import { useApi } from "../api/api-context";
import { ApiError, describeError } from "../api/errors";
import { useInvalidateWorkspace } from "../api/queries";
import { WebhookUrlInput } from "../components/WebhookUrlInput";
import { ErrorLine, Field } from "../components/ui";
import { useAction } from "../lib/use-action";

/** Creates a Discord destination. The webhook URL is cleared after every attempt. */
export function DestinationForm({
  workspaceId,
  activeCount,
  onCreated,
  onCancel,
}: {
  workspaceId: string;
  activeCount: number;
  onCreated: (destination: DestinationDto) => void;
  onCancel?: () => void;
}) {
  const api = useApi();
  const invalidate = useInvalidateWorkspace(workspaceId);
  const action = useAction();
  const nameId = useId();
  const urlId = useId();
  const [displayName, setDisplayName] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");

  const atLimit = activeCount >= WORKSPACE_LIMITS.activeDestinations;
  const error = action.error;
  const urlError = error instanceof ApiError && error.code === "invalid_webhook_url" ? describeError(error) : undefined;
  const nameError =
    error instanceof ApiError && error.code === "invalid_request" && error.fields?.some((f) => f.startsWith("displayName"))
      ? `Use 1 to ${REQUEST_LIMITS.displayNameMax} characters.`
      : undefined;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const body = { displayName: displayName.trim(), webhookUrl: webhookUrl.trim() };
    // Clear the secret from component state before the request settles.
    setWebhookUrl("");
    const result = await action.run(() => api.createDestination(workspaceId, body));
    if (result.ok) {
      setDisplayName("");
      void invalidate();
      onCreated(result.value);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5" autoComplete="off">
      <Field label="Name" htmlFor={nameId} hint="Shown only in Syncro, for example the channel name." error={nameError}>
        <input
          id={nameId}
          className="input"
          value={displayName}
          maxLength={REQUEST_LIMITS.displayNameMax}
          onChange={(e) => setDisplayName(e.target.value)}
          required
        />
      </Field>
      <WebhookUrlInput id={urlId} value={webhookUrl} onChange={setWebhookUrl} error={urlError} />
      {error && !urlError && !nameError ? <ErrorLine error={error} /> : null}
      {atLimit ? (
        <p className="text-[13px] text-mu">
          This workspace has {WORKSPACE_LIMITS.activeDestinations} active destinations, the maximum. Deactivate one to add
          another.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="submit"
          className="btn-primary"
          disabled={action.pending || atLimit || !displayName.trim() || !webhookUrl.trim()}
        >
          {action.pending ? "Saving…" : "Save destination"}
        </button>
        {onCancel ? (
          <button type="button" className="text-action tap-target" onClick={onCancel} disabled={action.pending}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
