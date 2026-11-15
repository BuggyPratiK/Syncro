/**
 * Operator tool: show or change the signup switch (SYSTEM#CONFIG / SIGNUP).
 *
 *   npm run signup:mode -- --show
 *   npm run signup:mode -- --mode open                     (dry run: shows the change)
 *   npm run signup:mode -- --mode open --yes               (applies it)
 *   npm run signup:mode -- --mode prelaunch --allow-add logto:abcdef123456 --yes
 *   npm run signup:mode -- --daily-cap 50 --yes
 *
 * Modes: `prelaunch` (allowlisted users only), `open`, `paused` (kill switch).
 * Existing users are never affected by the mode.
 *
 * Runs with the operator's own AWS credentials (use MFA-backed credentials).
 * Prints only the mode, the daily cap and the NUMBER of allowlisted users,
 * never user IDs or any secret. Running Lambda containers pick up a change
 * within about a minute (the setting is cached briefly).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { tenantKeys } from "../src/db/table";
import { isValidId } from "../src/contracts/ids";
import { SIGNUP, SIGNUP_MODES, type SignupMode } from "../src/contracts/constants";
import type { SignupConfigItem } from "../src/types/tenant.types";

const MAX_DAILY_CAP = 100_000;

export interface SignupArgs {
  show: boolean;
  apply: boolean;
  mode?: SignupMode;
  dailyCap?: number;
  allowAdd: string[];
  allowRemove: string[];
  table: string;
  region: string;
}

export class UsageError extends Error {}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): SignupArgs {
  const args: SignupArgs = {
    show: false,
    apply: false,
    allowAdd: [],
    allowRemove: [],
    table: env.DYNAMODB_TABLE_NAME ?? "syncro",
    region: env.AWS_REGION ?? "ap-southeast-2",
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--show":
        args.show = true;
        break;
      case "--yes":
        args.apply = true;
        break;
      case "--mode": {
        const m = value();
        if (!(SIGNUP_MODES as readonly string[]).includes(m)) {
          throw new UsageError(`--mode must be one of: ${SIGNUP_MODES.join(", ")}`);
        }
        args.mode = m as SignupMode;
        break;
      }
      case "--daily-cap": {
        const v = value();
        const n = Number(v);
        if (!/^\d+$/.test(v) || n > MAX_DAILY_CAP) {
          throw new UsageError(`--daily-cap must be an integer from 0 to ${MAX_DAILY_CAP}`);
        }
        args.dailyCap = n;
        break;
      }
      case "--allow-add":
      case "--allow-remove": {
        const uid = value();
        if (!isValidId("userId", uid)) throw new UsageError(`${flag} needs a user ID like logto:abcdef123456`);
        (flag === "--allow-add" ? args.allowAdd : args.allowRemove).push(uid);
        break;
      }
      case "--table":
        args.table = value();
        break;
      case "--region":
        args.region = value();
        break;
      default:
        throw new UsageError(`Unknown option: ${flag}`);
    }
  }
  const changes = args.mode !== undefined || args.dailyCap !== undefined || args.allowAdd.length + args.allowRemove.length > 0;
  if (!args.show && !changes) throw new UsageError("Nothing to do: pass --show or a change (--mode, --daily-cap, --allow-add, --allow-remove)");
  return args;
}

/** The config that results from applying `args` to `current` (absent = not configured yet). */
export function planChange(current: SignupConfigItem | undefined, args: SignupArgs, now: Date): SignupConfigItem {
  const allow = new Set(current?.prelaunch_allow ?? []);
  args.allowAdd.forEach((u) => allow.add(u));
  args.allowRemove.forEach((u) => allow.delete(u));
  return {
    ...tenantKeys.signupConfig(),
    mode: args.mode ?? current?.mode ?? "prelaunch",
    prelaunch_allow: [...allow].sort(),
    daily_cap: args.dailyCap ?? current?.daily_cap ?? SIGNUP.defaultDailyCap,
    updated_at: now.toISOString(),
  };
}

/** One-line, ID-free description of a config. */
export function describe(item: SignupConfigItem | undefined): string {
  if (!item) return "not configured (signups closed: prelaunch with an empty allowlist)";
  return `mode=${item.mode} daily_cap=${item.daily_cap} prelaunch_allowlist_count=${item.prelaunch_allow?.length ?? 0}`;
}

export interface RunResult {
  before: SignupConfigItem | undefined;
  after?: SignupConfigItem;
  applied: boolean;
  lines: string[];
}

/**
 * Shows and/or applies a change. The write is conditional on the config not
 * having changed since it was read, so two operators cannot overwrite each
 * other silently.
 */
export async function run(doc: DynamoDBDocumentClient, args: SignupArgs, now = new Date()): Promise<RunResult> {
  const key = tenantKeys.signupConfig();
  const out = await doc.send(new GetCommand({ TableName: args.table, Key: key, ConsistentRead: true }));
  const before = out.Item as SignupConfigItem | undefined;
  const lines = [`table=${args.table} region=${args.region}`, `current: ${describe(before)}`];

  const wantsChange = args.mode !== undefined || args.dailyCap !== undefined || args.allowAdd.length + args.allowRemove.length > 0;
  if (!wantsChange) return { before, applied: false, lines };

  const after = planChange(before, args, now);
  lines.push(`new:     ${describe(after)}`);
  if (!args.apply) {
    lines.push("dry run: nothing written. Re-run with --yes to apply.");
    return { before, after, applied: false, lines };
  }

  await doc.send(
    new PutCommand({
      TableName: args.table,
      Item: after,
      ConditionExpression: before ? "updated_at = :prev" : "attribute_not_exists(PK)",
      ...(before ? { ExpressionAttributeValues: { ":prev": before.updated_at } } : {}),
    }),
  );
  lines.push("applied.");
  return { before, after, applied: true, lines };
}

async function main(): Promise<void> {
  let args: SignupArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  const client = new DynamoDBClient({
    region: args.region,
    ...(process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {}),
  });
  try {
    const result = await run(DynamoDBDocumentClient.from(client), args);
    result.lines.forEach((l) => console.log(l));
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    console.error(
      name === "ConditionalCheckFailedException"
        ? "The signup config changed while this ran; nothing written. Re-run to see the latest."
        : `Failed: ${name ?? "error"}`,
    );
    process.exitCode = 1;
  } finally {
    client.destroy();
  }
}

if (require.main === module) {
  void main();
}
