/**
 * `/github/setup`: the GitHub App's callback.
 *
 * The OAuth `code` and `state` are read once from the URL, the URL is cleaned
 * with `history.replaceState` straight away, and the values are kept only in
 * memory until they are posted exactly once. They are never written to any
 * storage, cache or log.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useApi } from "../api/api-context";
import { queryKeys, useMe } from "../api/queries";
import { PlainLayout } from "../components/Shell";
import { ErrorLine, LoadingRows } from "../components/ui";
import { setListing } from "../github/listing-store";
import { takeAuthorizeInstallation } from "../github/pending-authorize";
import { parseSetupReturn, type SetupReturn } from "../github/setup-return";
import { PATHS } from "../paths";

type Outcome =
  | { status: "working" }
  | { status: "failed"; error: unknown }
  | { status: "message"; text: string };

interface Captured {
  ret: SetupReturn;
  /** For the authorize flow: the installation chosen before the redirect. */
  authorizeInstallationId: string | null;
}

export function GitHubSetupPage() {
  const api = useApi();
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const captured = useRef<Captured | null>(null);
  const posted = useRef(false);
  const [outcome, setOutcome] = useState<Outcome>({ status: "working" });

  // Capture and clear the callback parameters before anything else happens.
  useEffect(() => {
    if (captured.current) return;
    const ret = parseSetupReturn(window.location.search);
    window.history.replaceState(window.history.state, "", PATHS.githubSetup);
    captured.current = {
      ret,
      authorizeInstallationId: ret.kind === "authorize" ? takeAuthorizeInstallation() : null,
    };
  }, []);

  const workspaceId = me.data?.workspaces[0]?.workspaceId;

  useEffect(() => {
    const current = captured.current;
    if (!current || posted.current || !workspaceId) return;
    posted.current = true;
    const { ret, authorizeInstallationId } = current;
    // Drop the in-memory copy as soon as it has been handed to the request.
    captured.current = { ret: { kind: "invalid" }, authorizeInstallationId: null };

    // First-time setup continues in onboarding (destination and assignment
    // steps follow); otherwise the user came from "Add repositories".
    const done = async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.workspace(workspaceId) });
      const repos = await api.listRepos(workspaceId, { limit: 1 }).catch(() => null);
      navigate(repos && repos.items.length === 0 ? PATHS.onboarding : PATHS.addRepositories, { replace: true });
    };

    switch (ret.kind) {
      case "install":
        api
          .claimInstallation(workspaceId, { code: ret.code, state: ret.state, installationId: ret.installationId })
          .then((result) => {
            setListing(result.listing);
            void done();
          })
          .catch((error: unknown) => setOutcome({ status: "failed", error }));
        return;
      case "authorize":
        if (!authorizeInstallationId) {
          setOutcome({
            status: "message",
            text: "Syncro couldn’t tell which installation to list. Start again from Repositories.",
          });
          return;
        }
        api
          .repoListing(workspaceId, { code: ret.code, state: ret.state, installationId: authorizeInstallationId })
          .then((listing) => {
            setListing(listing);
            void done();
          })
          .catch((error: unknown) => setOutcome({ status: "failed", error }));
        return;
      case "installation_changed":
        setOutcome({
          status: "message",
          text: "Your GitHub installation was updated. To add repositories, start from Repositories in Syncro.",
        });
        return;
      case "denied":
        setOutcome({ status: "message", text: "GitHub authorization was cancelled. Nothing was changed." });
        return;
      case "invalid":
        setOutcome({ status: "message", text: "This link is incomplete or has already been used." });
        return;
    }
  }, [api, navigate, queryClient, workspaceId]);

  const noWorkspace = me.isSuccess && !workspaceId;

  return (
    <PlainLayout>
      <section className="max-w-155">
        <p className="label">GitHub</p>
        <h1 className="font-serif text-[38px] leading-tight">Connecting GitHub</h1>
        <div className="mt-6">
          {me.isError ? (
            <ErrorLine error={me.error} />
          ) : noWorkspace ? (
            <ErrorLine message="Finish creating your workspace first." />
          ) : outcome.status === "working" ? (
            <LoadingRows rows={1} />
          ) : outcome.status === "failed" ? (
            <ErrorLine error={outcome.error} />
          ) : (
            <p role="status">{outcome.text}</p>
          )}
        </div>
        {outcome.status !== "working" || me.isError || noWorkspace ? (
          <p className="mt-6">
            <Link className="text-action tap-target" to={PATHS.addRepositories}>
              Back to Syncro
            </Link>
          </p>
        ) : null}
      </section>
    </PlainLayout>
  );
}
