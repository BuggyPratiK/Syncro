/**
 * With no signup configuration written at all (a fresh deployment), signups
 * stay closed: nobody can create a workspace until an operator opens them.
 * This file's table never receives a config item.
 */

import { bootstrapUser, setTenancyDepsForTests } from "../../src/db/operations/tenancy.ops";
import { itemsWith, scanAll, useTestTable } from "./harness";

useTestTable();
beforeEach(() => setTenancyDepsForTests(undefined));

describe("missing signup configuration", () => {
  it("refuses every new user with signup_not_open and writes nothing", async () => {
    expect(await itemsWith("SYSTEM#CONFIG")).toHaveLength(0);
    const users = Array.from({ length: 5 }, (_, i) => `logto:fresh${String(i).padStart(7, "0")}`);
    const results = await Promise.allSettled(users.map((u) => bootstrapUser(u, "https://tenant.logto.app/oidc")));
    expect(results.every((r) => r.status === "rejected" && (r.reason as { code?: string }).code === "signup_not_open")).toBe(true);
    expect(await scanAll()).toHaveLength(0);
  });
});
