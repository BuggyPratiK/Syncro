/**
 * Single-use OAuth `state` for the GitHub install and authorize flows.
 *
 * Before redirecting a user to GitHub, the dashboard stores a random nonce
 * (`GHSTATE#<nonce>`) bound to the user, the workspace and the purpose, valid
 * for 10 minutes. When GitHub redirects back, the state is consumed BEFORE the
 * OAuth code is exchanged.
 *
 * Consumption is one conditional delete that succeeds only if the item exists,
 * has not expired, and matches the caller and purpose. So:
 * - a state can be used at most once, even by concurrent requests;
 * - a used state is gone, which makes "replayed" and "unknown" the same
 *   outcome (no extra attribute records consumption);
 * - expiry is checked against `ttl` explicitly, because DynamoDB deletes
 *   expired items only eventually;
 * - a caller whose binding does not match cannot consume (or destroy) the
 *   owner's state.
 * Every rejection maps to the single API error `state_invalid`.
 */

import { randomBytes } from "crypto";
import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../client";
import { tableName, tenantKeys } from "../table";
import { GITHUB_ONBOARDING } from "../../contracts/constants";
import { isValidId } from "../../contracts/ids";
import type {
  ConsumeGitHubStateResult,
  CreatedGitHubState,
  GitHubStatePurpose,
  WorkspaceContext,
} from "../../contracts/data-ops";
import type { GitHubStateItem } from "../../types/tenant.types";
import { isConditionalCheckFailed, oldItem } from "../dynamo-errors";
import { logger } from "../../utils/logger";

const PURPOSES: readonly GitHubStatePurpose[] = ["install", "authorize"];

export async function createGitHubState(
  ctx: WorkspaceContext,
  purpose: GitHubStatePurpose,
  nowMs: number = Date.now(),
): Promise<CreatedGitHubState> {
  if (!PURPOSES.includes(purpose)) throw new Error("Invalid state purpose");
  const state = randomBytes(GITHUB_ONBOARDING.stateNonceBytes).toString("base64url");
  const ttl = Math.floor(nowMs / 1000) + GITHUB_ONBOARDING.stateTtlSeconds;
  const item: GitHubStateItem = {
    ...tenantKeys.githubState(state),
    user_id: ctx.userId,
    workspace_id: ctx.workspaceId,
    purpose,
    ttl,
  };
  await ddb.send(
    new PutCommand({ TableName: tableName(), Item: item, ConditionExpression: "attribute_not_exists(PK)" }),
  );
  return { state, expiresAt: new Date(ttl * 1000).toISOString() };
}

export async function consumeGitHubState(
  ctx: WorkspaceContext,
  state: string | undefined,
  expectedPurpose: GitHubStatePurpose,
  nowMs: number = Date.now(),
): Promise<ConsumeGitHubStateResult> {
  const reject = (reason: Extract<ConsumeGitHubStateResult, { ok: false }>["reason"]): ConsumeGitHubStateResult => {
    logger.warn("OAuth state rejected", { reason, purpose: expectedPurpose });
    return { ok: false, reason };
  };

  if (state === undefined || state === "") return reject("missing");
  if (!isValidId("stateNonce", state)) return reject("malformed");

  const nowSeconds = Math.floor(nowMs / 1000);
  try {
    await ddb.send(
      new DeleteCommand({
        TableName: tableName(),
        Key: tenantKeys.githubState(state),
        ConditionExpression:
          "attribute_exists(PK) AND #ttl > :now AND user_id = :uid AND workspace_id = :ws AND purpose = :purpose",
        ExpressionAttributeNames: { "#ttl": "ttl" },
        ExpressionAttributeValues: {
          ":now": nowSeconds,
          ":uid": ctx.userId,
          ":ws": ctx.workspaceId,
          ":purpose": expectedPurpose,
        },
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      }),
    );
    return { ok: true, purpose: expectedPurpose };
  } catch (error) {
    if (!isConditionalCheckFailed(error)) throw error;
    // Classify for the log only; the caller answers `state_invalid` in every case.
    const old = oldItem((error as { Item?: unknown }).Item);
    if (!old) return reject("not_found");
    if (typeof old.ttl !== "number" || old.ttl <= nowSeconds) return reject("expired");
    if (old.purpose !== expectedPurpose) return reject("purpose_mismatch");
    return reject("binding_mismatch");
  }
}
