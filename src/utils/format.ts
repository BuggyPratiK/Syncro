/**
 * Formatting utilities for notification messages and display values.
 */

export function shortSha(sha: string): string {
  return sha.substring(0, 7);
}

export function truncateMessage(message: string, maxLength = 72): string {
  const firstLine = message.split("\n")[0] ?? message;
  if (firstLine.length <= maxLength) return firstLine;
  return firstLine.substring(0, maxLength - 3) + "...";
}

export function branchFromRef(ref: string): string {
  return ref.replace("refs/heads/", "").replace("refs/tags/", "");
}

export function formatDiff(additions: number, deletions: number): string {
  return `+${additions} / -${deletions}`;
}

export function formatTimestamp(isoString: string): string {
  return new Date(isoString).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * Generates a 30-day TTL Unix timestamp for DynamoDB item expiry.
 */
export function ttlInDays(days = 30): number {
  return Math.floor(Date.now() / 1000) + days * 24 * 60 * 60;
}
