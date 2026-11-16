/**
 * Operator signup tool: argument parsing, change planning and ID-free output.
 */

import { UsageError, describe as describeConfig, parseArgs, planChange } from "../../scripts/set-signup-mode";

const UID = "logto:abcdef123456";
const NOW = new Date("2026-11-15T10:00:00Z");

describe("parseArgs", () => {
  it("parses a change and defaults to the production table and region", () => {
    const a = parseArgs(["--mode", "open", "--daily-cap", "50", "--allow-add", UID], {});
    expect(a).toMatchObject({ mode: "open", dailyCap: 50, allowAdd: [UID], apply: false, table: "syncro", region: "ap-southeast-2" });
  });

  it("only writes with --yes", () => {
    expect(parseArgs(["--mode", "paused"], {}).apply).toBe(false);
    expect(parseArgs(["--mode", "paused", "--yes"], {}).apply).toBe(true);
  });

  it.each([
    [[]],
    [["--mode", "wide-open"]],
    [["--daily-cap", "-1"]],
    [["--daily-cap", "1e3"]],
    [["--daily-cap", "100001"]],
    [["--allow-add", "user_123"]],
    [["--mode"]],
    [["--unknown"]],
  ])("rejects %p", (argv) => {
    expect(() => parseArgs(argv, {})).toThrow(UsageError);
  });
});

describe("planChange", () => {
  it("starts from closed defaults when nothing is configured", () => {
    const next = planChange(undefined, parseArgs(["--allow-add", UID], {}), NOW);
    expect(next).toMatchObject({ PK: "SYSTEM#CONFIG", SK: "SIGNUP", mode: "prelaunch", daily_cap: 100, prelaunch_allow: [UID] });
  });

  it("keeps unspecified fields and applies allowlist edits", () => {
    const current = { PK: "SYSTEM#CONFIG" as const, SK: "SIGNUP" as const, mode: "prelaunch" as const, daily_cap: 20, prelaunch_allow: [UID, "logto:zzzzzzzzzzzz"], updated_at: "t" };
    const next = planChange(current, parseArgs(["--allow-remove", UID, "--mode", "open"], {}), NOW);
    expect(next).toMatchObject({ mode: "open", daily_cap: 20, prelaunch_allow: ["logto:zzzzzzzzzzzz"], updated_at: NOW.toISOString() });
  });
});

describe("describe", () => {
  it("reports counts, never user IDs", () => {
    const text = describeConfig({ PK: "SYSTEM#CONFIG", SK: "SIGNUP", mode: "prelaunch", daily_cap: 5, prelaunch_allow: [UID], updated_at: "t" });
    expect(text).toBe("mode=prelaunch daily_cap=5 prelaunch_allowlist_count=1");
    expect(text).not.toContain("logto:");
  });
});
