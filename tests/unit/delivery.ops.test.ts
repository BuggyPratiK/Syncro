import {
  claimDelivery,
  markDeliveryProcessed,
  markDeliveryFailed,
  markDeliveryIgnored,
  getDelivery,
  DEFAULT_LEASE_DURATION_MS,
} from "../../src/db/operations/delivery.ops";
import { ddb } from "../../src/db/client";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";

jest.mock("../../src/db/client", () => ({
  ddb: {
    send: jest.fn(),
  },
}));

describe("delivery.ops", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      DYNAMODB_TABLE_NAME: "test-syncro-table",
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "dummy-key",
      GITHUB_WEBHOOK_SECRET: "dummy-secret",
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/test",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("claimDelivery", () => {
    it("exports DEFAULT_LEASE_DURATION_MS as 60000ms", () => {
      expect(DEFAULT_LEASE_DURATION_MS).toBe(60000);
    });

    it("returns true when delivery is new and item is claimed with lease", async () => {
      (ddb.send as jest.Mock).mockResolvedValueOnce({});
      const claimed = await claimDelivery("delivery-1", "repo-123", "push");
      expect(claimed).toBe(true);

      expect(ddb.send).toHaveBeenCalledTimes(1);
      const callArgs = (ddb.send as jest.Mock).mock.calls[0][0];
      expect(callArgs.input.Key.PK).toBe("DELIVERY#delivery-1");
      expect(callArgs.input.ExpressionAttributeValues[":processing"]).toBe("processing");
      expect(callArgs.input.ExpressionAttributeValues[":repoId"]).toBe("repo-123");
      expect(callArgs.input.ExpressionAttributeValues[":eventType"]).toBe("push");
      expect(callArgs.input.ExpressionAttributeValues[":inc"]).toBe(1);
      expect(callArgs.input.ConditionExpression).toBe(
        "attribute_not_exists(PK) OR #status = :failed OR (#status = :processing AND lease_expires_at < :nowEpochMs)",
      );
      expect(callArgs.input.ExpressionAttributeValues[":leaseExpires"]).toBeGreaterThan(Date.now() - 1000);
    });

    it("returns false when delivery was already processed (duplicate from GitHub)", async () => {
      const error = new ConditionalCheckFailedException({
        $metadata: {},
        message: "The conditional request failed — already processed",
      });
      (ddb.send as jest.Mock).mockRejectedValueOnce(error);
      const claimed = await claimDelivery("delivery-1", "repo-123", "push");
      expect(claimed).toBe(false);
    });

    it("recovers a previously failed delivery when retried", async () => {
      // DynamoDB condition expression passes because #status = :failed
      (ddb.send as jest.Mock).mockResolvedValueOnce({});
      const claimed = await claimDelivery("delivery-failed-1", "repo-123", "push");
      expect(claimed).toBe(true);
      expect(ddb.send).toHaveBeenCalledTimes(1);
    });

    it("recovers a stale processing delivery whose lease expired", async () => {
      // DynamoDB condition expression passes because lease_expires_at < nowEpochMs
      (ddb.send as jest.Mock).mockResolvedValueOnce({});
      const claimed = await claimDelivery("delivery-stale-1", "repo-123", "push");
      expect(claimed).toBe(true);
      expect(ddb.send).toHaveBeenCalledTimes(1);
    });

    it("returns false when a concurrent processor holds an active unexpired lease", async () => {
      // Active lease means condition fails
      const error = new ConditionalCheckFailedException({
        $metadata: {},
        message: "Active lease held by another processor",
      });
      (ddb.send as jest.Mock).mockRejectedValueOnce(error);
      const claimed = await claimDelivery("delivery-active-1", "repo-123", "push");
      expect(claimed).toBe(false);
    });

    it("rethrows unexpected DynamoDB errors", () => {
      const networkError = new Error("DynamoDB service unavailable");
      (ddb.send as jest.Mock).mockRejectedValueOnce(networkError);
      return expect(claimDelivery("delivery-1", "repo-123", "push")).rejects.toThrow(
        "DynamoDB service unavailable",
      );
    });
  });

  describe("markDeliveryProcessed", () => {
    it("updates delivery status to processed", async () => {
      (ddb.send as jest.Mock).mockResolvedValueOnce({});
      await markDeliveryProcessed("delivery-1");
      expect(ddb.send).toHaveBeenCalledTimes(1);
      const callArgs = (ddb.send as jest.Mock).mock.calls[0][0];
      expect(callArgs.input.Key.PK).toBe("DELIVERY#delivery-1");
      expect(callArgs.input.ExpressionAttributeValues[":status"]).toBe("processed");
      expect(callArgs.input.ExpressionAttributeValues[":processedAt"]).toBeDefined();
    });
  });

  describe("markDeliveryFailed", () => {
    it("updates delivery status to failed with reason", async () => {
      (ddb.send as jest.Mock).mockResolvedValueOnce({});
      await markDeliveryFailed("delivery-1", "Discord webhook timed out");
      expect(ddb.send).toHaveBeenCalledTimes(1);
      const callArgs = (ddb.send as jest.Mock).mock.calls[0][0];
      expect(callArgs.input.Key.PK).toBe("DELIVERY#delivery-1");
      expect(callArgs.input.ExpressionAttributeValues[":status"]).toBe("failed");
      expect(callArgs.input.ExpressionAttributeValues[":error"]).toBe("Discord webhook timed out");
      expect(callArgs.input.ExpressionAttributeValues[":processedAt"]).toBeDefined();
    });
  });

  describe("markDeliveryIgnored", () => {
    it("updates delivery status to ignored with reason for unsupported/filtered events", async () => {
      (ddb.send as jest.Mock).mockResolvedValueOnce({});
      await markDeliveryIgnored("delivery-1", "Branch not watched");
      expect(ddb.send).toHaveBeenCalledTimes(1);
      const callArgs = (ddb.send as jest.Mock).mock.calls[0][0];
      expect(callArgs.input.Key.PK).toBe("DELIVERY#delivery-1");
      expect(callArgs.input.ExpressionAttributeValues[":status"]).toBe("ignored");
      expect(callArgs.input.ExpressionAttributeValues[":reason"]).toBe("Branch not watched");
    });
  });

  describe("getDelivery", () => {
    it("fetches a delivery item by deliveryId", async () => {
      const mockDelivery = {
        PK: "DELIVERY#deliv-123",
        SK: "DELIVERY#deliv-123",
        status: "processed",
      };
      (ddb.send as jest.Mock).mockResolvedValueOnce({ Item: mockDelivery });
      const item = await getDelivery("deliv-123");
      expect(item).toEqual(mockDelivery);
    });
  });
});