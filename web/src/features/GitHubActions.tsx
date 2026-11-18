/**
 * Buttons that leave Syncro for GitHub. The redirect URLs come from the API
 * and carry a single-use `state`; GitHub returns to the App's configured
 * callback (`/github/setup`).
 */

import { WORKSPACE_LIMITS, type InstallationDto } from "@contracts";
import { useId, useState } from "react";
import { useApi } from "../api/api-context";
import { ErrorLine } from "../components/ui";
import { rememberAuthorizeInstallation } from "../github/pending-authorize";
import { goToGitHub } from "../github/redirect";
import { useAction } from "../lib/use-action";

export function ConnectGitHubButton({
  workspaceId,
  installationCount,
  label = "Connect GitHub",
  secondary = false,
}: {
  workspaceId: string;
  installationCount: number;
  label?: string;
  secondary?: boolean;
}) {
  const api = useApi();
  const action = useAction();
  const atLimit = installationCount >= WORKSPACE_LIMITS.installations;

  async function connect() {
    await action.run(async () => goToGitHub((await api.installUrl(workspaceId)).url));
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <button
          type="button"
          className={secondary ? "btn-secondary" : "btn-primary"}
          onClick={() => void connect()}
          disabled={action.pending || atLimit}
        >
          {action.pending ? "Opening GitHub…" : label}
        </button>
      </div>
      {atLimit ? (
        <p className="text-[12px] text-mu">
          This workspace has {WORKSPACE_LIMITS.installations} GitHub installations, the maximum.
        </p>
      ) : null}
      {action.error ? <ErrorLine error={action.error} /> : null}
    </div>
  );
}

/** Starts the authorization that lists an installation's repositories again. */
export function LoadRepositoriesButton({
  workspaceId,
  installations,
}: {
  workspaceId: string;
  installations: InstallationDto[];
}) {
  const api = useApi();
  const action = useAction();
  const groupId = useId();
  const active = installations.filter((i) => i.status === "active");
  const [chosen, setChosen] = useState<string | undefined>(active[0]?.installationId);
  const selected = active.find((i) => i.installationId === chosen) ?? active[0];

  async function load() {
    if (!selected) return;
    await action.run(async () => {
      rememberAuthorizeInstallation(selected.installationId);
      goToGitHub((await api.authorizeUrl(workspaceId)).url);
    });
  }

  if (active.length === 0) return null;

  return (
    <div className="flex flex-col gap-4">
      {active.length > 1 ? (
        <fieldset>
          <legend id={groupId} className="label mb-2">
            GitHub account or organization
          </legend>
          {active.map((i) => (
            <label key={i.installationId} className="flex items-center gap-3 border-b border-ru py-2.5">
              <input
                type="radio"
                name={groupId}
                value={i.installationId}
                checked={selected?.installationId === i.installationId}
                onChange={() => setChosen(i.installationId)}
              />
              <span className="font-mono text-[12px]">{i.accountLogin}</span>
              <span className="text-[12px] text-mu">{i.accountType === "User" ? "Personal" : "Organization"}</span>
            </label>
          ))}
        </fieldset>
      ) : (
        <p className="text-[13px]">
          From <span className="font-mono text-[12px]">{active[0].accountLogin}</span>
        </p>
      )}
      <div>
        <button type="button" className="btn-primary" onClick={() => void load()} disabled={action.pending}>
          {action.pending ? "Opening GitHub…" : "Load repositories from GitHub"}
        </button>
      </div>
      {action.error ? <ErrorLine error={action.error} /> : null}
    </div>
  );
}
