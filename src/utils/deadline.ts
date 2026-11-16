/**
 * Execution deadline for one Lambda invocation.
 *
 * Outbound calls (Discord, GitHub) must finish before the Lambda times out,
 * otherwise the invocation is killed mid-write. The handler creates a deadline
 * from the Lambda context and passes it down; each outbound call sizes its own
 * timeout from what is left.
 */

export interface Deadline {
  /** Milliseconds left before the invocation is terminated. */
  remainingMs(): number;
}

/**
 * Deadline backed by the Lambda context's remaining-time clock. Returns
 * `undefined` (no deadline; per-call maximums still apply) if the context has
 * no clock, e.g. when the handler is invoked outside Lambda.
 */
export function deadlineFromContext(context: {
  getRemainingTimeInMillis?: () => number;
}): Deadline | undefined {
  const clock = context.getRemainingTimeInMillis;
  if (typeof clock !== "function") return undefined;
  return { remainingMs: () => clock.call(context) };
}

/** Deadline that ends `ms` from now (local runs and tests). */
export function deadlineIn(ms: number, now: () => number = Date.now): Deadline {
  const end = now() + ms;
  return { remainingMs: () => end - now() };
}

/**
 * Timeout for the next outbound attempt: at most `maxMs`, and never past the
 * deadline minus `reserveMs`. Returns 0 when there is no time left for an
 * attempt; callers must then skip it. Without a deadline, `maxMs` applies.
 */
export function attemptTimeoutMs(
  deadline: Deadline | undefined,
  maxMs: number,
  reserveMs: number,
): number {
  if (!deadline) return maxMs;
  const available = Math.floor(deadline.remainingMs() - reserveMs);
  return Math.max(0, Math.min(maxMs, available));
}
