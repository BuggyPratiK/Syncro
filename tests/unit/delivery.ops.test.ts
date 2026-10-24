import { claimDelivery, markDeliveryProcessed, markDeliveryFailed } from "../../src/db/operations/delivery.ops";
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
    it("returns true when delivery is new and item is saved", () => {
      (ddb.send as jest.Mock).mockResolvedValueOnce({});
      return expect(claimDelivery("delivery-1", "repo-123", "push")).resolves.toBe(true);
    });

    it("returns false when delivery was already processed (ConditionalCheckFailedException)", () => {
      const error = new ConditionalCheckFailedException({
        $metadata: {},
        message: "The conditional request failed",
      });
      (ddb.send as jest.Mock).mockRejectedValueOnce(error);
      return expect(claimDelivery("delivery-1", "repo-123", "push")).resolves.toBe(false);
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
    });
  });

  describe("markDeliveryFailed", () => {
    it("updates delivery status to failed with reason", async () => {
      (ddb.send as jest.Mock).mockResolvedValueOnce({});
      await markDeliveryFailed("delivery-1", "Discord webhook timed out");
      expect(ddb.send).toHaveBeenCalledTimes(1);
    });
  });
});