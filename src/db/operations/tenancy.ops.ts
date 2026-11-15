/**
 * Signup and workspace bootstrap.
 *
 * `bootstrapUser` creates a user's profile and their first workspace (public
 * self-service signup). It is safe under concurrency and retries:
 *
 * 1. Read the profile with a consistent read. If it exists, return its
 *    workspace (whatever the signup mode); a suspended profile is refused.
 * 2. Check the operator's signup mode: `paused` refuses, `prelaunch` admits
 *    only allowlisted users.
 * 3. Write everything in ONE transaction, each item conditional on not
 *    existing yet:
 *      [0] USER#<uid>/PROFILE          (the per-user lock)
 *      [1] WS#<ws>/META
 *      [2] WS#<ws>/MEMBER#<uid>        (owner)
 *      [3] USER#<uid>/MEMBERSHIP#<ws>  (owner)
 *      [4] SYSTEM#SIGNUPS/DAY#<utc day> += 1, only while below the daily cap
 *    Either all five are written or none is.
 * 4. Classify a cancelled transaction by the failing item:
 *      [0] failed  → another request created the profile: re-read and return it
 *                    (if it is somehow missing, that is an inconsistency: error);
 *      [1–3] failed → workspace ID collision: new ID, retry;
 *      [4] failed  → daily cap reached: refuse with `signup_paused`, no retry;
 *      conflicts / throttling → transient: retry from step 1 with backoff.
 *    At most 3 attempts in total, then `bootstrap_contention`.
 *
 * Workspace IDs are generated here (`ws_` + random UUID); no request can
 * choose one or create a second workspace.
 */

import { createHash, randomUUID } from "crypto";
import { BatchGetCommand, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../client";
import { tableName, tenantKeys, utcDayOf } from "../table";
import { ContractError } from "../../contracts/errors";
import { assertId } from "../../contracts/ids";
import { SIGNUP, SIGNUP_MODES, type SignupMode } from "../../contracts/constants";
import type { BootstrapResult } from "../../contracts/data-ops";
import type { MeDto, WorkspaceMembershipDto } from "../../contracts/dto";
import { ROLES, type Role } from "../../contracts/roles";
import type {
  SignupConfigItem,
  UserMembershipItem,
  UserProfileItem,
  WorkspaceItem,
  WorkspaceMemberItem,
} from "../../types/tenant.types";
import { logger } from "../../utils/logger";

// ─── Signup configuration ────────────────────────────────────────────────────

export interface SignupConfig {
  mode: SignupMode;
  prelaunchAllow: ReadonlySet<string>;
  dailyCap: number;
}

/**
 * Used when no signup configuration has been written yet: closed to everyone
 * except an (empty) allowlist, so a fresh deployment never opens signups by
 * accident. The operator opens signups with `scripts/set-signup-mode.ts`.
 */
export const DEFAULT_SIGNUP_CONFIG: SignupConfig = {
  mode: "prelaunch",
  prelaunchAllow: new Set(),
  dailyCap: SIGNUP.defaultDailyCap,
};

/** Interprets a stored config item. Anything malformed fails closed (`paused`). */
export function parseSignupConfig(item: Partial<SignupConfigItem> | undefined): SignupConfig {
  if (!item) return DEFAULT_SIGNUP_CONFIG;
  const modeOk = typeof item.mode === "string" && (SIGNUP_MODES as readonly string[]).includes(item.mode);
  const capOk = Number.isSafeInteger(item.daily_cap) && (item.daily_cap as number) >= 0;
  const allowOk =
    item.prelaunch_allow === undefined ||
    (Array.isArray(item.prelaunch_allow) && item.prelaunch_allow.every((u) => typeof u === "string"));
  if (!modeOk || !capOk || !allowOk) {
    logger.error("Signup configuration is malformed; treating signups as paused");
    return { mode: "paused", prelaunchAllow: new Set(), dailyCap: 0 };
  }
  return {
    mode: item.mode as SignupMode,
    prelaunchAllow: new Set(item.prelaunch_allow ?? []),
    dailyCap: item.daily_cap as number,
  };
}

let cachedConfig: { value: SignupConfig; expiresAt: number } | undefined;

/** Signup configuration, cached per container for at most `SIGNUP.configCacheMs`. */
export async function getSignupConfig(nowMs: number = Date.now()): Promise<SignupConfig> {
  if (cachedConfig && cachedConfig.expiresAt > nowMs) return cachedConfig.value;
  const out = await deps.send(new GetCommand({ TableName: tableName(), Key: tenantKeys.signupConfig() }));
  const value = parseSignupConfig(out.Item as Partial<SignupConfigItem> | undefined);
  cachedConfig = { value, expiresAt: nowMs + SIGNUP.configCacheMs };
  return value;
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

/** A cancelled transaction said the profile exists, but it cannot be read. Never reported as success. */
export class BootstrapInconsistentError extends Error {
  constructor() {
    super("Profile reported as existing but not found");
    this.name = "BootstrapInconsistentError";
  }
}

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [50, 100, 200];
const TRANSIENT_ERRORS = new Set([
  "TransactionConflictException",
  "TransactionInProgressException",
  "ProvisionedThroughputExceededException",
  "ThrottlingException",
  "RequestLimitExceeded",
  "InternalServerError",
]);
const TRANSIENT_REASONS = new Set(["TransactionConflict", "ThrottlingError", "ProvisionedThroughputExceeded"]);

interface BootstrapDeps {
  send: (command: GetCommand | TransactWriteCommand) => Promise<{ Item?: Record<string, unknown> }>;
  newWorkspaceId: () => string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: BootstrapDeps = {
  send: (command) => ddb.send(command as GetCommand) as Promise<{ Item?: Record<string, unknown> }>,
  newWorkspaceId: () => `ws_${randomUUID()}`,
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

let deps: BootstrapDeps = defaultDeps;

/** Test hook: override collaborators (ID generator, clock, transport) and clear caches. */
export function setTenancyDepsForTests(overrides: Partial<BootstrapDeps> | undefined): void {
  deps = { ...defaultDeps, ...(overrides ?? {}) };
  cachedConfig = undefined;
}

async function readProfile(userId: string): Promise<UserProfileItem | undefined> {
  const out = await deps.send(
    new GetCommand({ TableName: tableName(), Key: tenantKeys.userProfile(userId), ConsistentRead: true }),
  );
  return out.Item as UserProfileItem | undefined;
}

function existingResult(profile: UserProfileItem): BootstrapResult {
  if (profile.status !== "active") throw new ContractError("profile_suspended");
  return { created: false, workspaceId: profile.bootstrap_workspace_id };
}

function cancellationCodes(error: unknown): string[] {
  const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
  return reasons.map((r) => r?.Code ?? "None");
}

function buildTransaction(
  userId: string,
  idpIssuer: string,
  workspaceId: string,
  dailyCap: number,
  now: Date,
): TransactWriteCommand {
  const table = tableName();
  const at = now.toISOString();
  const notExists = "attribute_not_exists(PK)";

  const profile: UserProfileItem = {
    ...tenantKeys.userProfile(userId),
    user_id: userId,
    idp_iss: idpIssuer,
    bootstrap_workspace_id: workspaceId,
    status: "active",
    created_at: at,
  };
  const workspace: WorkspaceItem = {
    ...tenantKeys.workspace(workspaceId),
    workspace_id: workspaceId,
    created_by: userId,
    status: "active",
    created_at: at,
  };
  const member: WorkspaceMemberItem = {
    ...tenantKeys.workspaceMember(workspaceId, userId),
    workspace_id: workspaceId,
    user_id: userId,
    role: "owner",
    status: "active",
    joined_at: at,
  };
  const membership: UserMembershipItem = {
    ...tenantKeys.userMembership(userId, workspaceId),
    workspace_id: workspaceId,
    user_id: userId,
    role: "owner",
    status: "active",
    joined_at: at,
  };

  return new TransactWriteCommand({
    // Same token for a retried send of THIS attempt; a new attempt uses a new workspace ID.
    ClientRequestToken: createHash("sha256").update(`${userId}:${workspaceId}`).digest("hex").slice(0, 36),
    TransactItems: [
      { Put: { TableName: table, Item: profile, ConditionExpression: notExists } },
      { Put: { TableName: table, Item: workspace, ConditionExpression: notExists } },
      { Put: { TableName: table, Item: member, ConditionExpression: notExists } },
      { Put: { TableName: table, Item: membership, ConditionExpression: notExists } },
      {
        Update: {
          TableName: table,
          Key: tenantKeys.signupDay(utcDayOf(now)),
          UpdateExpression: "ADD #count :one SET #ttl = if_not_exists(#ttl, :ttl)",
          ConditionExpression: "attribute_not_exists(#count) OR #count < :cap",
          ExpressionAttributeNames: { "#count": "count", "#ttl": "ttl" },
          ExpressionAttributeValues: {
            ":one": 1,
            ":cap": dailyCap,
            ":ttl": Math.floor(now.getTime() / 1000) + SIGNUP.dayCounterTtlSeconds,
          },
        },
      },
    ],
  });
}

/**
 * Creates the user's profile and first workspace, or returns the existing one.
 * Refusals (`ContractError`): `profile_suspended`, `signup_paused`,
 * `signup_not_open`, `bootstrap_contention`. Nothing is written on refusal.
 */
export async function bootstrapUser(userId: string, idpIssuer: string): Promise<BootstrapResult> {
  assertId("userId", userId);
  if (typeof idpIssuer !== "string" || !/^https:\/\/\S{1,248}$/.test(idpIssuer)) {
    throw new Error("Invalid identity-provider issuer");
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Step 1: an existing profile always wins, in every signup mode.
    const existing = await readProfile(userId);
    if (existing) return existingResult(existing);

    // Step 2: signup mode.
    const config = await getSignupConfig();
    if (config.mode === "paused") throw new ContractError("signup_paused");
    if (config.mode === "prelaunch" && !config.prelaunchAllow.has(userId)) {
      throw new ContractError("signup_not_open");
    }

    // Step 3: one all-or-nothing transaction.
    const workspaceId = deps.newWorkspaceId();
    try {
      await deps.send(buildTransaction(userId, idpIssuer, workspaceId, config.dailyCap, deps.now()));
      logger.info("Workspace bootstrapped", { workspaceId });
      return { created: true, workspaceId };
    } catch (error) {
      const name = (error as { name?: string } | null)?.name ?? "";

      if (name === "TransactionCanceledException") {
        const codes = cancellationCodes(error);
        if (codes[0] === "ConditionalCheckFailed") {
          // A concurrent request created the profile first.
          const winner = await readProfile(userId);
          if (!winner) throw new BootstrapInconsistentError();
          return existingResult(winner);
        }
        if (codes.slice(1, 4).includes("ConditionalCheckFailed")) {
          logger.warn("Workspace ID collision; retrying with a new ID", { attempt });
        } else if (codes[4] === "ConditionalCheckFailed") {
          logger.error("Daily new-workspace cap reached; refusing signup", { dailyCap: config.dailyCap });
          throw new ContractError("signup_paused");
        } else if (!codes.some((c) => TRANSIENT_REASONS.has(c))) {
          throw error;
        }
      } else if (!TRANSIENT_ERRORS.has(name)) {
        throw error; // ValidationException and anything unexpected: no retry.
      }

      if (attempt < MAX_ATTEMPTS) {
        const base = BACKOFF_MS[attempt - 1];
        await deps.sleep(base / 2 + Math.random() * base);
      }
    }
  }

  throw new ContractError("bootstrap_contention");
}

// ─── Current user ────────────────────────────────────────────────────────────

/**
 * The signed-in user's profile and workspaces (read-only; never creates
 * anything). A workspace is listed only when both the workspace and the
 * authoritative membership (`WS#<ws>/MEMBER#<uid>`) are active; the user-side
 * membership copy is used only to find candidate workspaces.
 */
export async function getMe(userId: string): Promise<MeDto> {
  assertId("userId", userId);
  const table = tableName();

  const [profileOut, membershipsOut] = await Promise.all([
    ddb.send(new GetCommand({ TableName: table, Key: tenantKeys.userProfile(userId), ConsistentRead: true })),
    ddb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :m)",
        ExpressionAttributeValues: { ":pk": tenantKeys.userProfile(userId).PK, ":m": "MEMBERSHIP#" },
        ConsistentRead: true,
      }),
    ),
  ]);
  const profile = profileOut.Item as UserProfileItem | undefined;
  const candidates = ((membershipsOut.Items ?? []) as UserMembershipItem[])
    .filter((m) => m.status === "active")
    .map((m) => m.workspace_id);

  const workspaces: WorkspaceMembershipDto[] = [];
  // BatchGet takes up to 100 keys: two per workspace.
  for (let i = 0; i < candidates.length; i += 50) {
    const chunk = candidates.slice(i, i + 50);
    let pending = chunk.flatMap((ws) => [tenantKeys.workspace(ws), tenantKeys.workspaceMember(ws, userId)]);
    const found: Array<Record<string, unknown>> = [];
    for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
      const out = await ddb.send(new BatchGetCommand({ RequestItems: { [table]: { Keys: pending, ConsistentRead: true } } }));
      found.push(...((out.Responses?.[table] ?? []) as Array<Record<string, unknown>>));
      pending = (out.UnprocessedKeys?.[table]?.Keys ?? []) as typeof pending;
    }
    for (const ws of chunk) {
      const meta = found.find((x) => x.PK === `WS#${ws}` && x.SK === "META") as WorkspaceItem | undefined;
      const member = found.find((x) => x.PK === `WS#${ws}` && x.SK === `MEMBER#${userId}`) as WorkspaceMemberItem | undefined;
      if (meta?.status === "active" && member?.status === "active" && (ROLES as readonly string[]).includes(member.role)) {
        workspaces.push({ workspaceId: ws, role: member.role as Role });
      }
    }
  }

  return {
    ...(profile ? { profile: { status: profile.status, createdAt: profile.created_at } } : {}),
    workspaces,
  };
}
