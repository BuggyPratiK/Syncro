import type { DeliveryDto } from "@contracts";

const dateTime = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** Local, compact timestamp; falls back to the raw value if it does not parse. */
export function formatTime(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTime.format(date);
}

/** One-line event description built only from stored summary fields. */
export function describeEvent(summary: DeliveryDto["summary"]): string {
  if (summary.eventType === "push") {
    const parts = ["push"];
    if (summary.branch) parts.push(summary.branch);
    if (summary.headShortSha) parts.push(summary.headShortSha);
    if (summary.commitCount !== undefined) {
      parts.push(`${summary.commitCount} commit${summary.commitCount === 1 ? "" : "s"}`);
    }
    return parts.join(" ");
  }
  if (summary.eventType === "pull_request") {
    const parts = ["pull_request"];
    if (summary.prNumber !== undefined) parts.push(`#${summary.prNumber}`);
    if (summary.action) parts.push(summary.action);
    return parts.join(" ");
  }
  return summary.eventType;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
