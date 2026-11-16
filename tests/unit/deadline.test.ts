/**
 * Execution deadline helpers.
 */

import { attemptTimeoutMs, deadlineFromContext, deadlineIn } from "../../src/utils/deadline";

describe("attemptTimeoutMs", () => {
  const fixed = (ms: number) => ({ remainingMs: () => ms });

  it("uses the per-call maximum when plenty of time is left", () => {
    expect(attemptTimeoutMs(fixed(14_000), 5000, 2000)).toBe(5000);
  });

  it("shrinks to the time left before the reserve", () => {
    expect(attemptTimeoutMs(fixed(4500), 5000, 2000)).toBe(2500);
  });

  it("returns 0 when nothing is left after the reserve", () => {
    expect(attemptTimeoutMs(fixed(2000), 5000, 2000)).toBe(0);
    expect(attemptTimeoutMs(fixed(500), 5000, 2000)).toBe(0);
  });

  it("falls back to the maximum without a deadline", () => {
    expect(attemptTimeoutMs(undefined, 3000, 7000)).toBe(3000);
  });
});

describe("deadline sources", () => {
  it("reads the Lambda context clock", () => {
    const d = deadlineFromContext({ getRemainingTimeInMillis: () => 1234 });
    expect(d?.remainingMs()).toBe(1234);
  });

  it("returns no deadline when the context has no clock", () => {
    expect(deadlineFromContext({})).toBeUndefined();
  });

  it("deadlineIn counts down from now", () => {
    let now = 1000;
    const d = deadlineIn(500, () => now);
    now = 1300;
    expect(d.remainingMs()).toBe(200);
  });
});
