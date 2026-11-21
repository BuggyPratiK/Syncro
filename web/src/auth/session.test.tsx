/**
 * Sign-out and session-end behaviour. The app must never start a sign-in by
 * itself: an automatic redirect raced a sign-out in progress and signed the
 * user straight back in.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useMemo, useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpApiProvider, useApi } from "../api/api-context";
import { createFixtureApi } from "../dev/fixture-api";
import { fakeAuth, renderApp } from "../test/render";
import { AuthProvider, type AuthState } from "./auth-context";
import { RequireAuth } from "./RequireAuth";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sign-out", () => {
  it("only signs out from Account: no sign-in, no refetch", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi({ seeded: true });
    const signIn = vi.fn();
    const signOut = vi.fn();
    renderApp({ path: "/account", api, auth: fakeAuth({ signIn, signOut }) });

    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signIn).not.toHaveBeenCalled();
    // Clearing the query cache used to remount the page and refetch the profile.
    expect(api.calls.filter((c) => c.method === "getMe")).toHaveLength(1);
  });

  it("hides the app while signing out", async () => {
    const api = createFixtureApi({ seeded: true });
    renderApp({ path: "/repositories", api, auth: fakeAuth({ isSigningOut: true }) });
    expect(await screen.findByText("Signing out…")).toBeVisible();
    expect(api.calls).toEqual([]);
  });
});

describe("ended session", () => {
  it("shows the sign-in page with a notice and does not redirect", async () => {
    const signIn = vi.fn();
    renderApp({ path: "/repositories", auth: fakeAuth({ isAuthenticated: false, sessionEnded: true, signIn }) });
    expect(await screen.findByText("Your session has ended. Sign in again to continue.")).toBeVisible();
    expect(signIn).not.toHaveBeenCalled();
  });

  it("lets the user sign in again from the notice", async () => {
    const user = userEvent.setup();
    const signIn = vi.fn();
    renderApp({ path: "/", auth: fakeAuth({ isAuthenticated: false, sessionEnded: true, signIn }) });
    await user.click(await screen.findByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
  });

  it("ends the session instead of redirecting when the API answers 401", async () => {
    const signIn = vi.fn();
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: "unauthenticated" }), { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter>
        <StatefulAuth signIn={signIn} />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Your session has ended. Sign in again to continue.")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signIn).not.toHaveBeenCalled();
  });
});

/** Auth with real state, so `endSession` (called by the HTTP client) takes effect. */
function StatefulAuth({ signIn }: { signIn: () => void }) {
  const [ended, setEnded] = useState(false);
  const auth = useMemo<AuthState>(
    () => ({
      ...fakeAuth({ signIn }),
      isAuthenticated: !ended,
      sessionEnded: ended,
      endSession: () => setEnded(true),
    }),
    [ended, signIn],
  );
  return (
    <AuthProvider value={auth}>
      <HttpApiProvider baseUrl="https://api.example.com">
        <RequireAuth>
          <LoadsProfile />
        </RequireAuth>
      </HttpApiProvider>
    </AuthProvider>
  );
}

/** Requests the profile once through the real HTTP client. */
function LoadsProfile() {
  const api = useApi();
  useEffect(() => {
    api.getMe().catch(() => {});
  }, [api]);
  return <p>signed in</p>;
}
