/**
 * Helpers for classifying DynamoDB failures.
 *
 * With `ReturnValuesOnConditionCheckFailure: "ALL_OLD"`, a failed condition
 * carries the item as it was. The SDK returns it in DynamoDB's wire format
 * (`{ attr: { S: "..." } }`); `oldItem` converts the few attribute types used
 * here into plain values.
 */

type Wire = { S?: string; N?: string; BOOL?: boolean; NULL?: boolean };

function plain(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const w = value as Wire;
    if (typeof w.S === "string") return w.S;
    if (typeof w.N === "string") return Number(w.N);
    if (typeof w.BOOL === "boolean") return w.BOOL;
    if (w.NULL) return null;
  }
  return value;
}

/** Plain view of an item returned with a failed condition (absent → undefined). */
export function oldItem(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = plain(v);
  return Object.keys(out).length > 0 ? out : undefined;
}

export function errorName(error: unknown): string {
  return (error as { name?: string } | null)?.name ?? "";
}

export function isConditionalCheckFailed(error: unknown): boolean {
  return errorName(error) === "ConditionalCheckFailedException";
}

/** Per-item outcome of a cancelled transaction, in request order. */
export function cancellationReasons(error: unknown): Array<{ code: string; item?: Record<string, unknown> }> {
  const reasons = (error as { CancellationReasons?: Array<{ Code?: string; Item?: unknown }> }).CancellationReasons ?? [];
  return reasons.map((r) => ({ code: r?.Code ?? "None", item: oldItem(r?.Item) }));
}

const TRANSIENT_ERRORS = new Set([
  "TransactionConflictException",
  "TransactionInProgressException",
  "ProvisionedThroughputExceededException",
  "ThrottlingException",
  "RequestLimitExceeded",
  "InternalServerError",
]);

/** True for failures worth retrying: conflicts and throttling, whole-call or per-item. */
export function isTransient(error: unknown): boolean {
  if (TRANSIENT_ERRORS.has(errorName(error))) return true;
  if (errorName(error) !== "TransactionCanceledException") return false;
  const codes = cancellationReasons(error).map((r) => r.code);
  return codes.some((c) => c === "TransactionConflict" || c === "ThrottlingError" || c === "ProvisionedThroughputExceeded") &&
    !codes.includes("ConditionalCheckFailed");
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 50/100/200 ms with jitter, by attempt number (1-based). */
export function backoffMs(attempt: number): number {
  const base = [50, 100, 200][Math.min(attempt, 3) - 1];
  return base / 2 + Math.random() * base;
}
