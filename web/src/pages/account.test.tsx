import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureApi } from "../dev/fixture-api";
import { renderApp } from "../test/render";

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("appearance", () => {
  it("forces Ink or Paper and returns to following the system", async () => {
    const user = userEvent.setup();
    renderApp({ path: "/account" });

    expect(await screen.findByRole("radio", { name: /System/ })).toBeChecked();
    expect(document.documentElement).not.toHaveAttribute("data-theme");

    await user.click(screen.getByRole("radio", { name: /Ink/ }));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(window.localStorage.getItem("syncro.theme")).toBe("dark");

    await user.click(screen.getByRole("radio", { name: /Paper/ }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");

    await user.click(screen.getByRole("radio", { name: /System/ }));
    expect(document.documentElement).not.toHaveAttribute("data-theme");
    expect(window.localStorage.getItem("syncro.theme")).toBeNull();
  });
});

describe("installations for repository listing", () => {
  it("lists the newest installation first and shows ID and date", async () => {
    const api = createFixtureApi({ seeded: true });
    vi.spyOn(api, "listInstallations").mockResolvedValue({
      items: [
        { installationId: "1001", accountLogin: "octo-dev", accountType: "User", status: "active", claimedAt: "2026-11-20T10:00:00.000Z" },
        { installationId: "2002", accountLogin: "octo-dev", accountType: "User", status: "active", claimedAt: "2026-11-21T10:00:00.000Z" },
      ],
    });
    renderApp({ path: "/repositories/add", api });

    const radios = await screen.findAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(radios[0]).toBeChecked();
    expect(radios[0].closest("label")).toHaveTextContent("ID 2002");
    expect(radios[1].closest("label")).toHaveTextContent("ID 1001");
    expect(screen.getByText(/Seeing the same account twice/)).toBeVisible();
  });
});
