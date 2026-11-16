/**
 * Rate-limit primitive (fake DynamoDB): request shape, decisions,
 * Retry-After, and fail-closed store errors.
 */

import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../src/db/client";
import { RateLimitStoreError, consumeRateLimit, windowOf } from "../../src/ratelimit/rate-limit";
import { RATE_LIMITS } from "../../src/contracts";

jest.mock("../../src/db/client", () => ({ ddb: { send: jest.fn() } }));

const UID = "logto:abcdef123456";
const send = ddb.send as jest.Mock;
// 2026-11-15T10:00:15Z → window 29,906,160 (epoch minutes), 45 s left.
const NOW = Date.UTC(2026, 10, 15, 10, 0, 15);

describe("windowOf", () => {
  it("returns the minute window and the seconds left in it", () => {
    expect(windowOf(NOW)).toEqual({ window: Math.floor(NOW / 60_000), retryAfterSeconds: 45 });
  });

  it("never returns less than 1 second", () => {
    expect(windowOf(Date.UTC(2026, 10, 15, 10, 0, 59, 999)).retryAfterSeconds).toBe(1);
  });
});

describe("consumeRateLimit", () => {
  beforeEach(() => send.mockReset());

  it.each(Object.entries(RATE_LIMITS))("bucket %s: one conditional increment against limit %i", async (bucket, limit) => {
    send.mockResolvedValueOnce({});
    await expect(consumeRateLimit(UID, bucket as never, NOW)).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 });

    const cmd = send.mock.calls[0][0] as UpdateCommand;
    const window = Math.floor(NOW / 60_000);
    expect(cmd.input.Key).toEqual({ PK: `RATE#${UID}`, SK: `${bucket}#${window}` });
    expect(cmd.input.ConditionExpression).toBe("attribute_not_exists(#count) OR #count < :limit");
    expect(cmd.input.ExpressionAttributeValues).toMatchObject({ ":limit": limit, ":one": 1, ":ttl": (window + 2) * 60 });
  });

  it("refuses with Retry-After when the window is full", async () => {
    send.mockRejectedValueOnce(new ConditionalCheckFailedException({ message: "full", $metadata: {} }));
    await expect(consumeRateLimit(UID, "write", NOW)).resolves.toEqual({ allowed: false, retryAfterSeconds: 45 });
  });

  it.each(["ThrottlingException", "InternalServerError", "ResourceNotFoundException"])(
    "fails closed on %s",
    async (name) => {
      const e = new Error(name);
      e.name = name;
      send.mockRejectedValueOnce(e);
      await expect(consumeRateLimit(UID, "github", NOW)).rejects.toBeInstanceOf(RateLimitStoreError);
    },
  );

  it("rejects an invalid user id or bucket before any database call", async () => {
    await expect(consumeRateLimit("user_1", "write", NOW)).rejects.toThrow();
    await expect(consumeRateLimit(UID, "read" as never, NOW)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
