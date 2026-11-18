import { FIXTURES_ENABLED } from "../config";

/**
 * Navigates the browser to a GitHub URL returned by the API. Only
 * `https://github.com` is accepted, so a tampered response cannot send the
 * user elsewhere.
 *
 * Fixture mode (development only) also accepts the app's own origin, where its
 * fake GitHub return lives, and navigates there client-side so the in-memory
 * fixture data survives the "redirect".
 */
export function goToGitHub(url: string): void {
  const parsed = new URL(url, window.location.origin);
  if (FIXTURES_ENABLED && parsed.origin === window.location.origin) {
    window.history.pushState(null, "", parsed.pathname + parsed.search);
    window.dispatchEvent(new PopStateEvent("popstate"));
    return;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
    throw new Error("Unexpected redirect target");
  }
  window.location.assign(parsed.toString());
}
