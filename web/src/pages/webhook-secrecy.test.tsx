/**
 * A Discord webhook URL is a bearer secret: the UI must never render it back,
 * prefill it, keep it in an input after submitting, or log it.
 */

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ApiError } from "../api/errors";
import { createFixtureApi } from "../dev/fixture-api";
import { renderApp } from "../test/render";

const SECRET = "https://discord.com/api/webhooks/123456789012345678/Sup3rSecretT0ken_value-abc";

let consoleSpies: MockInstance[] = [];

beforeEach(() => {
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
});

afterEach(() => {
  for (const spy of consoleSpies) {
    for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain("Sup3rSecretT0ken");
  }
});

function expectSecretNowhere(container: HTMLElement) {
  expect(container.innerHTML).not.toContain("Sup3rSecretT0ken");
  for (const input of Array.from(document.querySelectorAll("input"))) {
    expect(input.value).not.toContain("Sup3rSecretT0ken");
  }
}

describe("webhook URL input", () => {
  it("is a password field that is never prefilled", async () => {
    const user = userEvent.setup();
    const { container } = renderApp({ path: "/destinations" });
    await user.click(await screen.findByRole("button", { name: "Add destination" }));
    const field = screen.getByLabelText("Discord webhook URL");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveValue("");
    expect(field).toHaveAttribute("autocomplete", "off");
    expectSecretNowhere(container);
  });

  it("is cleared after a successful create and only the masked form is shown", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi({ seeded: true });
    const create = vi.spyOn(api, "createDestination");
    const { container } = renderApp({ path: "/destinations", api });

    await user.click(await screen.findByRole("button", { name: "Add destination" }));
    await user.type(screen.getByLabelText("Name"), "release-notes");
    await user.type(screen.getByLabelText("Discord webhook URL"), SECRET);
    await user.click(screen.getByRole("button", { name: "Save destination" }));

    await screen.findByText("Destination added");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][1]).toEqual({ displayName: "release-notes", webhookUrl: SECRET });
    expect(await screen.findByText("discord.com/api/webhooks/123456789012345678/••••")).toBeVisible();
    expectSecretNowhere(container);
  });

  it("is cleared and not echoed when the server rejects it", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi({ seeded: true });
    vi.spyOn(api, "createDestination").mockRejectedValue(new ApiError("invalid_webhook_url", 400));
    const { container } = renderApp({ path: "/destinations", api });

    await user.click(await screen.findByRole("button", { name: "Add destination" }));
    await user.type(screen.getByLabelText("Name"), "x");
    await user.type(screen.getByLabelText("Discord webhook URL"), SECRET);
    await user.click(screen.getByRole("button", { name: "Save destination" }));

    expect(await screen.findByText(/isn’t a valid Discord webhook URL/)).toBeVisible();
    expect(screen.getByLabelText("Discord webhook URL")).toHaveValue("");
    expectSecretNowhere(container);
  });

  it("replaces a URL write-only", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi({ seeded: true });
    const replace = vi.spyOn(api, "replaceWebhook");
    const { container } = renderApp({ path: "/destinations", api });

    await user.click(await screen.findByRole("button", { name: "Replace URL" }));
    const field = screen.getByLabelText("New webhook URL");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveValue("");
    expect(screen.getByText("Stored URLs are never revealed.")).toBeVisible();

    await user.type(field, SECRET);
    await user.click(screen.getByRole("button", { name: "Save new URL" }));

    await screen.findByText("Webhook URL replaced");
    expect(replace).toHaveBeenCalledTimes(1);
    await waitFor(() => expectSecretNowhere(container));
  });
});
