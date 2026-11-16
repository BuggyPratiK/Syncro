/**
 * Per-user fixed-window rate limiter.
 *
 * Each (user, bucket, minute) has one counter item:
 *   PK = RATE#<uid>, SK = <bucket>#<floor(epochSeconds / 60)>
 * A request is allowed by ONE conditional update that increments the counter
 * only while it is below the bucket's limit, so concurrent requests can never
 * exceed the limit. A refused request does not increment the counter.
 *
 * Counter items expire (TTL) two windows after their window starts.
 *
 * If the counter store fails, `consumeRateLimit` throws
 * `RateLimitStoreError`; callers must reject the request (503) rather than
 * skip the limit.
 */

import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { ddb } from "../db/client";
import { tableName, tenantKeys } from "../db/table";
import {
  RATE_LIMITS,
  RATE_LIMIT_WINDOW_SECONDS,
  type RateLimitBucket,
} from "../contracts/constants";
import type { RateLimitDecision } from "../contracts/data-ops";

export class RateLimitStoreError extends Error {
  constructor() {
    super("Rate-limit store unavailable");
    this.name = "RateLimitStoreError";
  }
}

/** Window number and the seconds left in it, for a point in time. */
export function windowOf(nowMs: number): { window: number; retryAfterSeconds: number } {
  const nowSeconds = Math.floor(nowMs / 1000);
  const window = Math.floor(nowSeconds / RATE_LIMIT_WINDOW_SECONDS);
  const windowEnd = (window + 1) * RATE_LIMIT_WINDOW_SECONDS;
  return { window, retryAfterSeconds: Math.max(1, windowEnd - nowSeconds) };
}

/**
 * Records one request for `userId` in `bucket` and decides whether it is
 * allowed. `retryAfterSeconds` is the time until the window ends (0 when
 * allowed). Invalid user IDs or buckets throw before any database call.
 */
export async function consumeRateLimit(
  userId: string,
  bucket: RateLimitBucket,
  nowMs: number = Date.now(),
): Promise<RateLimitDecision> {
  const { window, retryAfterSeconds } = windowOf(nowMs);
  const key = tenantKeys.rateLimit(userId, bucket, window);
  const limit = RATE_LIMITS[bucket];
  const ttl = (window + 2) * RATE_LIMIT_WINDOW_SECONDS;

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: key,
        UpdateExpression: "ADD #count :one SET #bucket = :bucket, #ttl = if_not_exists(#ttl, :ttl)",
        ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
        ExpressionAttributeNames: { "#count": "count", "#bucket": "bucket", "#ttl": "ttl" },
        ExpressionAttributeValues: { ":one": 1, ":bucket": bucket, ":ttl": ttl, ":limit": limit },
      }),
    );
    return { allowed: true, retryAfterSeconds: 0 };
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return { allowed: false, retryAfterSeconds };
    }
    throw new RateLimitStoreError();
  }
}
