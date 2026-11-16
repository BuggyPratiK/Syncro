/**
 * Operator signup tool against DynamoDB Local.
 */

import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { parseArgs, run } from "../../scripts/set-signup-mode";
import { itemsWith, tableName, testDocClient, useTestTable } from "./harness";

useTestTable();

const UID = "logto:operatoruse1";

describe("set-signup-mode", () => {
  const doc = testDocClient();
  afterAll(() => doc.destroy());
  const args = (argv: string[]) => ({ ...parseArgs(argv, {}), table: tableName() });

  it("a dry run writes nothing", async () => {
    const result = await run(doc, args(["--mode", "open"]));
    expect(result.applied).toBe(false);
    expect(await itemsWith("SYSTEM#CONFIG")).toHaveLength(0);
  });

  it("--yes writes the config, and --show reads it back without user IDs", async () => {
    await run(doc, args(["--mode", "prelaunch", "--daily-cap", "7", "--allow-add", UID, "--yes"]));
    expect(await itemsWith("SYSTEM#CONFIG", "SIGNUP")).toEqual([
      expect.objectContaining({ mode: "prelaunch", daily_cap: 7, prelaunch_allow: [UID] }),
    ]);

    const shown = await run(doc, args(["--show"]));
    expect(shown.lines.join("\n")).toContain("mode=prelaunch daily_cap=7 prelaunch_allowlist_count=1");
    expect(shown.lines.join("\n")).not.toContain(UID);
  });

  it("refuses to overwrite a change made after it read the config", async () => {
    const stale = doc.send.bind(doc);
    let raced = false;
    const racingDoc = {
      send: async (cmd: Parameters<typeof doc.send>[0]) => {
        if (!raced && cmd instanceof PutCommand) {
          raced = true;
          // Another operator writes first.
          await stale(new PutCommand({ TableName: tableName(), Item: { PK: "SYSTEM#CONFIG", SK: "SIGNUP", mode: "paused", prelaunch_allow: [], daily_cap: 1, updated_at: "someone-else" } }));
        }
        return stale(cmd);
      },
    } as unknown as typeof doc;

    await expect(run(racingDoc, args(["--mode", "open", "--yes"]))).rejects.toMatchObject({
      name: "ConditionalCheckFailedException",
    });
    expect((await itemsWith("SYSTEM#CONFIG", "SIGNUP"))[0]).toMatchObject({ mode: "paused", updated_at: "someone-else" });
  });
});
