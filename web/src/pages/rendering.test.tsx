import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createFixtureApi } from "../dev/fixture-api";
import { fakeAuth, renderApp } from "../test/render";

const MARKUP = '<img src=x onerror="window.__xss=1"><b>bold</b>';

describe("stored strings", () => {
  it("render markup from the API as text in Activity", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi({ seeded: true });
    vi.spyOn(api, "listDeliveries").mockResolvedValue({
      items: [
        {
          deliveryId: "11111111-2222-4333-8444-555555555555",
          status: "failed",
          receivedAt: "2026-11-18T10:00:00.000Z",
          summary: { repoFullName: `octo/${MARKUP}`, eventType: "push", branch: MARKUP },
          errorMessage: `Commit message: ${MARKUP}`,
        },
      ],
    });
    const { container } = renderApp({ path: "/activity", api });

    const row = await screen.findByRole("button", { expanded: false });
    await user.click(row);

    expect(screen.getByText(`Commit message: ${MARKUP}`)).toBeVisible();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  it("render destination names and repository names as text", async () => {
    const api = createFixtureApi({ seeded: true });
    const real = await api.listDestinations("ws_6f1c2d3e-4a5b-4c6d-8e7f-901234567890");
    vi.spyOn(api, "listDestinations").mockResolvedValue({
      items: [{ ...real.items[0], displayName: MARKUP }],
    });
    const { container } = renderApp({ path: "/destinations", api });
    expect(await screen.findByRole("heading", { name: MARKUP })).toBeVisible();
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("route guard", () => {
  it.each(["/", "/repositories", "/activity", "/destinations", "/account", "/onboarding", "/github/setup"])(
    "shows sign-in and calls no API for %s when signed out",
    async (path) => {
      const api = createFixtureApi({ seeded: true });
      const signIn = vi.fn();
      renderApp({ path, api, auth: fakeAuth({ isAuthenticated: false, signIn }) });

      const button = await screen.findByRole("button", { name: "Sign in" });
      expect(api.calls).toEqual([]);
      await userEvent.setup().click(button);
      expect(signIn).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps the legal pages public", async () => {
    renderApp({ path: "/privacy", auth: fakeAuth({ isAuthenticated: false }) });
    expect(await screen.findByRole("heading", { name: "Privacy notice" })).toBeVisible();
    expect(screen.getAllByText("FOUNDER TEXT REQUIRED").length).toBe(4);
  });

  it("sends a user without a workspace to onboarding, which creates it", async () => {
    const api = createFixtureApi({ seeded: false });
    renderApp({ path: "/repositories", api });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/onboarding"));
    expect(await screen.findByRole("heading", { name: "Connect GitHub" })).toBeVisible();
    expect(api.calls.filter((c) => c.method === "bootstrap")).toHaveLength(1);
  });
});
