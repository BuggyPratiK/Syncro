/**
 * Status vocabulary. Every label is paired with a glyph by `StatusMark`.
 *
 * The delivery list returns only `processed` and `failed` deliveries.
 * `processed` means the delivery went through the pipeline, not that the
 * Discord message was delivered (a failed send is recorded on the
 * notification, which the API does not list yet), so it is labelled
 * "Processed" rather than "Delivered".
 */

import type { DestinationStatus, LedgerDeliveryStatus } from "@contracts";
import type { StatusKind } from "../components/StatusMark";

export interface StatusView {
  kind: StatusKind;
  label: string;
}

/** Outbound notification states (handoff vocabulary). */
export function notificationStatus(status: "sent" | "failed" | "pending", retryCount = 0): StatusView {
  switch (status) {
    case "sent":
      return { kind: "ok", label: "Delivered" };
    case "failed":
      return { kind: "failed", label: "Failed" };
    case "pending":
      return { kind: "pending", label: retryCount > 0 ? `Pending · retry ${retryCount}` : "Pending" };
  }
}

/** An ignored delivery always carries its reason. */
export function ignoredStatus(reason: string): StatusView {
  return { kind: "ignored", label: `Ignored · ${reason}` };
}

export function deliveryStatus(status: LedgerDeliveryStatus): StatusView {
  return status === "processed" ? { kind: "ok", label: "Processed" } : { kind: "failed", label: "Failed" };
}

export function repoStatus(isActive: boolean): StatusView {
  return isActive ? { kind: "ok", label: "Active" } : { kind: "ignored", label: "Paused" };
}

export function destinationStatus(status: DestinationStatus): StatusView {
  switch (status) {
    case "active":
      return { kind: "ok", label: "Active" };
    case "inactive":
      return { kind: "ignored", label: "Inactive" };
    case "pending_secret":
      return { kind: "pending", label: "Setup incomplete" };
  }
}
