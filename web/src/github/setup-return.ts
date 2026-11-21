/**
 * Classifies a return to `/github/setup`.
 *
 * Both GitHub flows return to the App's single callback URL, and the API does
 * not say which flow a `state` belongs to, so the page tells them apart by the
 * parameters GitHub sends:
 * - App installation (with user authorization during install): `code`,
 *   `installation_id`, `setup_action=install` and `state`;
 * - user authorization for "add repositories": `code` and `state` only.
 * An installation change made on GitHub (no Syncro `state`) is not a flow the
 * page can complete. None of these values is proof of anything: the server
 * verifies everything with a fresh GitHub user token.
 */

import { fieldSchemas } from "@contracts";

export type SetupReturn =
  | { kind: "install"; code: string; state: string; installationId: string }
  | { kind: "authorize"; code: string; state: string }
  | { kind: "installation_changed" }
  | { kind: "denied" }
  | { kind: "invalid" };

export function parseSetupReturn(search: string): SetupReturn {
  const params = new URLSearchParams(search);
  if (params.has("error")) return { kind: "denied" };

  const code = params.get("code");
  const state = params.get("state");
  const installationId = params.get("installation_id");

  const validCode = code !== null && fieldSchemas.githubCode.safeParse(code).success;
  const validState = state !== null && fieldSchemas.state.safeParse(state).success;

  if (installationId !== null) {
    if (!fieldSchemas.githubId.safeParse(installationId).success) return { kind: "invalid" };
    if (state === null) return { kind: "installation_changed" };
    return validCode && validState ? { kind: "install", code: code!, state: state!, installationId } : { kind: "invalid" };
  }

  return validCode && validState ? { kind: "authorize", code: code!, state: state! } : { kind: "invalid" };
}
