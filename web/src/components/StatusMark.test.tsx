import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { deliveryStatus, destinationStatus, ignoredStatus, notificationStatus, repoStatus } from "../lib/status";
import { StatusMark, type StatusKind } from "./StatusMark";

describe("StatusMark", () => {
  it.each<[StatusKind, string]>([
    ["ok", "Delivered"],
    ["failed", "Failed"],
    ["pending", "Pending · retry 2"],
    ["planned", "Planned"],
    ["ignored", "Ignored · Branch dev not watched"],
  ])("renders the %s glyph with the label %s", (kind, label) => {
    const { container } = render(<StatusMark kind={kind} label={label} />);
    expect(screen.getByText(label)).toBeVisible();
    const glyph = container.querySelector("svg");
    expect(glyph).not.toBeNull();
    expect(glyph).toHaveAttribute("data-glyph", kind);
    expect(glyph).toHaveAttribute("aria-hidden", "true");
  });

  it("uses a distinct shape per status, not only color", () => {
    const shapes = (["ok", "failed", "pending", "planned", "ignored"] as const).map((kind) => {
      const { container, unmount } = render(<StatusMark kind={kind} label={kind} />);
      const markup = container.querySelector("svg")!.innerHTML;
      unmount();
      return markup;
    });
    expect(new Set(shapes).size).toBe(5);
  });
});

describe("status vocabulary", () => {
  it("follows the handoff vocabulary for notifications", () => {
    expect(notificationStatus("sent")).toEqual({ kind: "ok", label: "Delivered" });
    expect(notificationStatus("failed")).toEqual({ kind: "failed", label: "Failed" });
    expect(notificationStatus("pending")).toEqual({ kind: "pending", label: "Pending" });
    expect(notificationStatus("pending", 2)).toEqual({ kind: "pending", label: "Pending · retry 2" });
    expect(ignoredStatus("Branch dev not watched")).toEqual({ kind: "ignored", label: "Ignored · Branch dev not watched" });
  });

  it("labels processed deliveries as Processed, never Delivered", () => {
    expect(deliveryStatus("processed")).toEqual({ kind: "ok", label: "Processed" });
    expect(deliveryStatus("failed")).toEqual({ kind: "failed", label: "Failed" });
  });

  it("covers repository and destination states", () => {
    expect(repoStatus(true).label).toBe("Active");
    expect(repoStatus(false).label).toBe("Paused");
    expect(destinationStatus("active").label).toBe("Active");
    expect(destinationStatus("inactive").label).toBe("Inactive");
    expect(destinationStatus("pending_secret").label).toBe("Setup incomplete");
  });
});
