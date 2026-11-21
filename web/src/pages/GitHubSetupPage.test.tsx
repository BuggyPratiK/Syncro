import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/errors";
import { createFixtureApi } from "../dev/fixture-api";
import { rememberAuthorizeInstallation } from "../github/pending-authorize";
import { renderApp } from "../test/render";

const CODE = "c0de-SECRET_value123";
const STATE = "fixture-state-0123456789abcdefghijklmnopqrs";

function storageContents(): string {
  const dump: string[] = [];
  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)!;
      dump.push(key, storage.getItem(key) ?? "");
    }
  }
  return dump.join("\n");
}

describe("/github/setup", () => {
  it("claims an installation once, clears the URL and stores nothing", async () => {
    const api = createFixtureApi({ seeded: true });
    const claim = vi.spyOn(api, "claimInstallation");
    window.history.replaceState(null, "", `/github/setup?code=${CODE}&installation_id=1001&setup_action=install&state=${STATE}`);

    renderApp({ path: "/github/setup", api, strict: true });

    // The URL is cleaned straight away, before the request completes.
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(window.location.href).not.toContain(CODE);

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/repositories/add"));
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim.mock.calls[0][1]).toEqual({ code: CODE, state: STATE, installationId: "1001" });
    expect(storageContents()).not.toContain(CODE);
    expect(storageContents()).not.toContain(STATE);
  });

  it("continues onboarding after the first installation", async () => {
    const api = createFixtureApi({ seeded: false });
    await api.bootstrap();
    window.history.replaceState(null, "", `/github/setup?code=${CODE}&installation_id=1001&setup_action=install&state=${STATE}`);

    renderApp({ path: "/github/setup", api });

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/onboarding"));
    expect(await screen.findByRole("heading", { name: "Choose repositories" })).toBeVisible();
  });

  it("lists repositories for the remembered installation on the authorize return", async () => {
    const api = createFixtureApi({ seeded: true });
    const listing = vi.spyOn(api, "repoListing");
    rememberAuthorizeInstallation("1001");
    window.history.replaceState(null, "", `/github/setup?code=${CODE}&iss=https%3A%2F%2Fgithub.com&state=${STATE}`);

    renderApp({ path: "/github/setup", api, strict: true });

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/repositories/add"));
    expect(listing).toHaveBeenCalledTimes(1);
    expect(listing.mock.calls[0][1]).toEqual({ code: CODE, state: STATE, installationId: "1001" });
    expect(window.location.search).toBe("");
    // The remembered installation is consumed, and the code was never stored.
    expect(storageContents()).toBe("");
  });

  it("does not post when the authorize return has no remembered installation", async () => {
    const api = createFixtureApi({ seeded: true });
    const listing = vi.spyOn(api, "repoListing");
    window.history.replaceState(null, "", `/github/setup?code=${CODE}&state=${STATE}`);

    renderApp({ path: "/github/setup", api });

    expect(await screen.findByText(/couldn’t tell which installation/)).toBeVisible();
    expect(listing).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  it("shows the organization message for org_not_supported", async () => {
    const api = createFixtureApi({ seeded: true });
    vi.spyOn(api, "claimInstallation").mockRejectedValue(new ApiError("org_not_supported", 403));
    window.history.replaceState(null, "", `/github/setup?code=${CODE}&installation_id=2002&setup_action=install&state=${STATE}`);

    renderApp({ path: "/github/setup", api });

    expect(await screen.findByText("Organization installations are not supported yet.")).toBeVisible();
    expect(window.location.search).toBe("");
  });

  it("does nothing for an installation change made on GitHub", async () => {
    const api = createFixtureApi({ seeded: true });
    const claim = vi.spyOn(api, "claimInstallation");
    window.history.replaceState(null, "", "/github/setup?installation_id=1001&setup_action=update");

    renderApp({ path: "/github/setup", api });

    expect(await screen.findByText(/installation was updated/)).toBeVisible();
    expect(claim).not.toHaveBeenCalled();
  });
});
