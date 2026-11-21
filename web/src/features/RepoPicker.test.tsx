import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createFixtureApi, FIXTURE_WORKSPACE_ID } from "../dev/fixture-api";
import { setListing } from "../github/listing-store";
import { renderApp } from "../test/render";

function listing(repos: Array<{ repoId: string; fullName: string; admin: boolean }>) {
  return {
    listingId: "00000000-0000-4000-8000-0000000000aa",
    installationId: "1001",
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    repos,
  };
}

describe("repository chooser", () => {
  it("pre-selects every repository that can be added and skips the rest", async () => {
    const api = createFixtureApi({ seeded: true }); // octo-dev/api is already active
    setListing(
      listing([
        { repoId: "501", fullName: "octo-dev/api", admin: true },
        { repoId: "502", fullName: "octo-dev/web", admin: true },
        { repoId: "503", fullName: "octo-dev/docs", admin: false },
      ]),
    );
    renderApp({ path: "/repositories/add", api });

    const web = await screen.findByRole("checkbox", { name: "octo-dev/web" });
    expect(web).toBeChecked();
    const docs = screen.getByRole("checkbox", { name: /octo-dev\/docs/ });
    expect(docs).not.toBeChecked();
    expect(docs).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /octo-dev\/api/ })).toBeDisabled();
    expect(screen.getByText(/GitHub decided which repositories Syncro may read/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Add repository" })).toBeEnabled();
  });

  it("lets the user untick a pre-selected repository before adding", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi({ seeded: true });
    const register = vi.spyOn(api, "registerRepo");
    setListing(listing([{ repoId: "502", fullName: "octo-dev/web", admin: true }]));
    renderApp({ path: "/repositories/add", api });

    const web = await screen.findByRole("checkbox", { name: "octo-dev/web" });
    await user.click(web);
    expect(web).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Add repository" })).toBeDisabled();
    expect(register).not.toHaveBeenCalled();

    await user.click(web);
    await user.click(screen.getByRole("button", { name: "Add repository" }));
    await waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(register.mock.calls[0][0]).toBe(FIXTURE_WORKSPACE_ID);
  });
});
