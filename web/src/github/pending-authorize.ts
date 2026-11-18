/**
 * Which installation an "add repositories" authorization was started for.
 *
 * GitHub's authorization return carries only `code` and `state`, but the
 * repository-listing request also needs the installation the user picked. The
 * installation ID is a public numeric GitHub ID, so it is kept in
 * sessionStorage across the redirect. The OAuth `code` and `state` are never
 * written to any storage.
 */

import { GITHUB_ONBOARDING, isValidId } from "@contracts";

const KEY = "syncro.authorizeInstallation";

export function rememberAuthorizeInstallation(installationId: string, now = Date.now()): void {
  if (!isValidId("githubId", installationId)) throw new Error("Invalid installation ID");
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ installationId, at: now }));
  } catch {
    // Storage unavailable (private mode or blocked): the return page then asks
    // the user to start again, which is safe.
  }
}

/** Reads and removes the remembered installation; null if missing, invalid or older than the state lifetime. */
export function takeAuthorizeInstallation(now = Date.now()): string | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { installationId?: unknown; at?: unknown };
    const fresh = typeof value.at === "number" && now - value.at <= GITHUB_ONBOARDING.stateTtlSeconds * 1000;
    return fresh && isValidId("githubId", value.installationId) ? value.installationId : null;
  } catch {
    return null;
  }
}
