/**
 * Delivery history, pagination and per-user rate limits through the real API
 * on DynamoDB Local: workspace-scoped listings, workspace-bound cursors,
 * page-size bounds, and the fixed-window limiter with `Retry-After`.
 */

import { randomUUID } from "crypto";
import { claimDelivery, markDeliveryIgnored, markDeliveryProcessed } from "../../../src/db/operations/delivery.ops";
import { RATE_LIMITS } from "../../../src/contracts";
import { windowOf } from "../../../src/ratelimit/rate-limit";
import { VALID_WEBHOOK, newUserId, openSignups } from "../fixtures";
import { itemsWith, useTestTable } from "../harness";
import { call, captureLogsAndBlockNetwork, dashboardApp, onboard, type DashboardApp, type Onboarded } from "./app";

useTestTable();
beforeAll(openSignups);
captureLogsAndBlockNetwork();

/** A processed delivery stamped into `w`'s history. */
async function processedDelivery(w: Onboarded): Promise<string> {
  const id = randomUUID();
  await claimDelivery(id, String(w.repoIds[0]), "push");
  await markDeliveryProcessed(id, { workspaceId: w.workspaceId, summary: { repo_full_name: `user${w.githubUserId}/repo-${w.repoIds[0]}`, event_type: "push" } });
  await new Promise((r) => setTimeout(r, 15)); // distinct received_at
  return id;
}

let app: DashboardApp;
beforeEach(async () => {
  app = await dashboardApp();
});

describe("delivery history", () => {
  it("lists only the workspace's own deliveries, newest first, without ignored ones", async () => {
    const a = await onboard(app, newUserId());
    const b = await onboard(app, newUserId());
    const aIds = [await processedDelivery(a), await processedDelivery(a), await processedDelivery(a)];
    const bId = await processedDelivery(b);
    const ignored = randomUUID();
    await claimDelivery(ignored, String(a.repoIds[0]), "push");
    await markDeliveryIgnored(ignored, "branch_not_watched");

    const listA = await call(app, a.uid, "GET", `${a.base}/deliveries`);
    expect(listA.status).toBe(200);
    expect((listA.body.items as Array<{ deliveryId: string }>).map((i) => i.deliveryId)).toEqual([...aIds].reverse());
    expect(listA.body.items).toContainEqual({
      deliveryId: aIds[0],
      status: "processed",
      receivedAt: expect.any(String),
      processedAt: expect.any(String),
      summary: { repoFullName: `user${a.githubUserId}/repo-${a.repoIds[0]}`, eventType: "push" },
    });
    const listB = await call(app, b.uid, "GET", `${b.base}/deliveries`);
    expect((listB.body.items as Array<{ deliveryId: string }>).map((i) => i.deliveryId)).toEqual([bId]);
    expect(listA.raw + listB.raw).not.toContain(ignored);
  });

  it("pages with a cursor that only works for its own workspace", async () => {
    const a = await onboard(app, newUserId());
    const b = await onboard(app, newUserId());
    const ids = [await processedDelivery(a), await processedDelivery(a), await processedDelivery(a)];

    const p1 = await call(app, a.uid, "GET", `${a.base}/deliveries`, { query: { limit: "2" } });
    expect(p1.body.items).toHaveLength(2);
    expect(typeof p1.body.nextCursor).toBe("string");
    const p2 = await call(app, a.uid, "GET", `${a.base}/deliveries`, { query: { limit: "2", cursor: String(p1.body.nextCursor) } });
    const seen = [...(p1.body.items as Array<{ deliveryId: string }>), ...(p2.body.items as Array<{ deliveryId: string }>)].map((i) => i.deliveryId);
    expect(seen).toEqual([...ids].reverse());

    const stolen = await call(app, b.uid, "GET", `${b.base}/deliveries`, { query: { cursor: String(p1.body.nextCursor) } });
    expect(stolen.status).toBe(400);
    expect(stolen.body).toEqual({ error: "invalid_request" });
  });
});

describe("pagination bounds", () => {
  it("accepts page sizes 1–50 and rejects anything else before reading", async () => {
    const w = await onboard(app, newUserId());
    for (const limit of ["1", "50"]) {
      expect((await call(app, w.uid, "GET", `${w.base}/repos`, { query: { limit } })).status).toBe(200);
    }
    for (const limit of ["0", "51", "-1", "1.5", "abc", "100"]) {
      const res = await call(app, w.uid, "GET", `${w.base}/repos`, { query: { limit } });
      expect([limit, res.status, res.body.fields]).toEqual([limit, 400, ["query.limit"]]);
    }
  });

  it("rejects tampered, foreign-shaped and oversized cursors", async () => {
    const w = await onboard(app, newUserId());
    const forged = Buffer.from(JSON.stringify({ w: w.workspaceId, k: { PK: "WS#other", SK: "DEST#x" } })).toString("base64url");
    for (const cursor of ["not_a_real_cursor", forged, "a".repeat(1025)]) {
      const res = await call(app, w.uid, "GET", `${w.base}/destinations`, { query: { cursor } });
      expect(res.status).toBe(400);
    }
  });

  it("pages destinations and repositories without gaps or repeats", async () => {
    const w = await onboard(app, newUserId(), 5);
    for (let i = 0; i < 5; i++) {
      await call(app, w.uid, "POST", `${w.base}/destinations`, { body: { displayName: `D${i}`, webhookUrl: VALID_WEBHOOK } });
      await call(app, w.uid, "POST", `${w.base}/repos`, { body: { listingId: w.listingId, repoId: String(w.repoIds[i]) } });
    }
    for (const path of ["destinations", "repos"]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const res = await call(app, w.uid, "GET", `${w.base}/${path}`, { query: { limit: "2", ...(cursor ? { cursor } : {}) } });
        expect(res.status).toBe(200);
        const items = res.body.items as Array<Record<string, string>>;
        expect(items.length).toBeLessThanOrEqual(2);
        seen.push(...items.map((i) => i.destinationId ?? i.repoId));
        cursor = res.body.nextCursor as string | undefined;
        pages += 1;
      } while (cursor && pages < 10);
      expect([path, seen.length, new Set(seen).size]).toEqual([path, 5, 5]);
    }
  });
});

describe("per-user rate limits", () => {
  /** Waits for a fresh window if the current one is about to end, so the test cannot straddle two windows. */
  async function freshWindow(): Promise<void> {
    const { retryAfterSeconds } = windowOf(Date.now());
    if (retryAfterSeconds < 25) await new Promise((r) => setTimeout(r, retryAfterSeconds * 1000 + 200));
  }

  it(`allows ${RATE_LIMITS.bootstrap} bootstrap calls per minute, then answers 429 with Retry-After`, async () => {
    await freshWindow();
    const uid = newUserId();
    for (let i = 0; i < RATE_LIMITS.bootstrap; i++) {
      expect((await call(app, uid, "POST", "/api/me/bootstrap")).status).toBe(200);
    }
    const limited = await call(app, uid, "POST", "/api/me/bootstrap");
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: "rate_limited" });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers["retry-after"])).toBeLessThanOrEqual(60);
    expect(await itemsWith(`RATE#${uid}`)).toHaveLength(1);

    // Another user is unaffected, and reads have no per-user limit.
    expect((await call(app, newUserId(), "POST", "/api/me/bootstrap")).status).toBe(200);
    expect((await call(app, uid, "GET", "/api/me")).status).toBe(200);
  }, 90_000);

  it("malformed write requests from an authenticated owner count against the write bucket", async () => {
    await freshWindow();
    const w = await onboard(app, newUserId());
    for (let i = 0; i < RATE_LIMITS.write; i++) {
      expect((await call(app, w.uid, "POST", `${w.base}/destinations`, { body: { bogus: true } })).status).toBe(400);
    }
    const limited = await call(app, w.uid, "POST", `${w.base}/destinations`, { body: { displayName: "ok", webhookUrl: VALID_WEBHOOK } });
    expect(limited.status).toBe(429);
    expect(await itemsWith(`WS#${w.workspaceId}`, "DEST#")).toEqual([]);
  }, 90_000);
});
