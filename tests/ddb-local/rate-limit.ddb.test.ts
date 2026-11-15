/**
 * Rate-limit primitive against DynamoDB Local: the limit holds exactly under
 * concurrency, and users, buckets and windows are independent.
 */

import { consumeRateLimit } from "../../src/ratelimit/rate-limit";
import { RATE_LIMITS } from "../../src/contracts";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../../src/db/client";
import { itemsWith, tableName, useTestTable } from "./harness";

useTestTable();

const NOW = Date.UTC(2026, 10, 15, 10, 0, 15);
const WINDOW = Math.floor(NOW / 60_000);

async function burst(uid: string, bucket: "bootstrap" | "github" | "write", count: number, nowMs = NOW) {
  return Promise.all(Array.from({ length: count }, () => consumeRateLimit(uid, bucket, nowMs)));
}

describe("consumeRateLimit under concurrency", () => {
  it.each(Object.entries(RATE_LIMITS))(
    "bucket %s: N parallel requests allow exactly the limit (%i)",
    async (bucket, limit) => {
      const uid = `logto:par${bucket.slice(0, 3)}000001`.slice(0, 18);
      const results = await burst(uid, bucket as never, limit + 15);

      const allowed = results.filter((r) => r.allowed);
      const refused = results.filter((r) => !r.allowed);
      expect(allowed).toHaveLength(limit);
      expect(refused).toHaveLength(15);
      expect(refused.every((r) => r.retryAfterSeconds === 45)).toBe(true);

      const [counter] = await itemsWith(`RATE#${uid}`, `${bucket}#${WINDOW}`);
      expect(counter).toMatchObject({ count: limit, bucket, ttl: (WINDOW + 2) * 60 });
    },
  );

  it("users are independent", async () => {
    const [a, b] = ["logto:indepuser001", "logto:indepuser002"];
    await burst(a, "github", RATE_LIMITS.github + 5);
    const forB = await burst(b, "github", RATE_LIMITS.github);
    expect(forB.every((r) => r.allowed)).toBe(true);
  });

  it("buckets are independent", async () => {
    const uid = "logto:bucketuser01";
    await burst(uid, "github", RATE_LIMITS.github + 5);
    const writes = await burst(uid, "write", 5);
    expect(writes.every((r) => r.allowed)).toBe(true);
  });

  it("enforcement does not depend on DynamoDB TTL deletion", async () => {
    // A full counter for the current window whose ttl is already in the past
    // (TTL deletion is lazy): the limit still applies, keyed by the window.
    const uid = "logto:ttluser00001";
    await ddb.send(
      new PutCommand({
        TableName: tableName(),
        Item: { PK: `RATE#${uid}`, SK: `write#${WINDOW}`, bucket: "write", count: RATE_LIMITS.write, ttl: 1 },
      }),
    );
    const [decision] = await burst(uid, "write", 1);
    expect(decision.allowed).toBe(false);
  });

  it("a new window starts from zero", async () => {
    const uid = "logto:windowuser01";
    await burst(uid, "bootstrap", RATE_LIMITS.bootstrap + 2);
    const next = await burst(uid, "bootstrap", RATE_LIMITS.bootstrap, NOW + 60_000);
    expect(next.every((r) => r.allowed)).toBe(true);
  });
});
