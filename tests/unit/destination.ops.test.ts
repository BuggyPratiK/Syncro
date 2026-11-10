import {
  createDiscordDestination,
  getDiscordDestination,
  listDiscordDestinations,
  updateDiscordDestination,
  deactivateDiscordDestination,
} from "../../src/db/operations/destination.ops";
import { ddb } from "../../src/db/client";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";

jest.mock("../../src/db/client", () => ({
  ddb: {
    send: jest.fn(),
  },
}));

describe("destination.ops", () => {
  const originalEnv = process.env;
  const VALID_WEBHOOK = "https://discord.com/api/webhooks/123456789012345678/token-abc-123_xyz";

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      DYNAMODB_TABLE_NAME: "test-syncro-table",
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "dummy-key",
      GITHUB_WEBHOOK_SECRET: "dummy-secret",
      DISCORD_WEBHOOK_URL: VALID_WEBHOOK,
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("createDiscordDestination", () => {
    it("creates a new Discord destination with valid URL and sets GSI1PK", async () => {
      (ddb.send as jest.Mock).mockResolvedValueOnce({});

      const result = await createDiscordDestination({
        destination_id: "dest-123",
        display_name: "General Alerts",
        discord_webhook_url: VALID_WEBHOOK,
      });

      expect(result.destination_id).toBe("dest-123");
      expect(result.PK).toBe("DESTINATION#dest-123");
      expect(result.SK).toBe("CONFIG");
      expect(result.GSI1PK).toBe("TYPE#DESTINATION");
      expect(result.is_active).toBe(true);
      expect(result.display_name).toBe("General Alerts");
      expect(result.discord_webhook_url).toBe(VALID_WEBHOOK);
      expect(result.created_at).toBeDefined();
      expect(result.updated_at).toBeDefined();

      expect(ddb.send).toHaveBeenCalledTimes(1);
      const callArgs = (ddb.send as jest.Mock).mock.calls[0][0];
      expect(callArgs.input.ConditionExpression).toBe("attribute_not_exists(PK)");
    });

    it("auto-generates UUID when destination_id is omitted", async () => {
      (ddb.send as jest.Mock).mockResolvedValueOnce({});

      const result = await createDiscordDestination({
        display_name: "Auto ID Channel",
        discord_webhook_url: VALID_WEBHOOK,
      });

      expect(result.destination_id).toBeDefined();
      expect(result.destination_id.length).toBeGreaterThan(10);
      expect(result.PK).toBe(`DESTINATION#${result.destination_id}`);
    });

    it("rejects invalid webhook URL before touching DynamoDB", async () => {
      await expect(
        createDiscordDestination({
          display_name: "Invalid Channel",
          discord_webhook_url: "http://not-discord.com/hook",
        }),
      ).rejects.toThrow(/Discord webhook URL must use HTTPS|Invalid webhook domain/);

      expect(ddb.send).not.toHaveBeenCalled();
    });

    it("throws error when destination already exists", async () => {
      (ddb.send as jest.Mock).mockRejectedValueOnce(
        new ConditionalCheckFailedException({
          $metadata: {},
          message: "The conditional request failed",
        }),
      );

      await expect(
        createDiscordDestination({
          destination_id: "existing-dest",
          display_name: "Duplicate",
          discord_webhook_url: VALID_WEBHOOK,
        }),
      ).rejects.toThrow("Discord destination with ID 'existing-dest' already exists");
    });
  });

  describe("getDiscordDestination", () => {
    it("returns null when destination is not found", async () => {
      (ddb.send as jest.Mock).mockResolvedValueOnce({});
      const result = await getDiscordDestination("nonexistent");
      expect(result).toBeNull();
    });

    it("returns DiscordDestinationItem when destination exists", async () => {
      const mockItem = {
        PK: "DESTINATION#dest-1",
        SK: "CONFIG",
        destination_id: "dest-1",
        provider: "discord",
        display_name: "Dev Channel",
        discord_webhook_url: VALID_WEBHOOK,
        is_active: true,
        GSI1PK: "TYPE#DESTINATION",
        created_at: "2026-10-15T00:00:00Z",
        updated_at: "2026-10-15T00:00:00Z",
      };
      (ddb.send as jest.Mock).mockResolvedValueOnce({ Item: mockItem });

      const result = await getDiscordDestination("dest-1");
      expect(result).toEqual(mockItem);
    });

    it("returns null for empty or invalid destinationId", async () => {
      expect(await getDiscordDestination("")).toBeNull();
      expect(await getDiscordDestination(null as any)).toBeNull();
    });
  });

  describe("listDiscordDestinations", () => {
    it("queries type-index GSI for all destinations", async () => {
      const mockItems = [
        { destination_id: "d1", display_name: "Channel 1", is_active: true },
        { destination_id: "d2", display_name: "Channel 2", is_active: true },
      ];
      (ddb.send as jest.Mock).mockResolvedValueOnce({ Items: mockItems });

      const result = await listDiscordDestinations();
      expect(result.items).toEqual(mockItems);
      expect(result.nextToken).toBeUndefined();

      const callArgs = (ddb.send as jest.Mock).mock.calls[0][0];
      expect(callArgs.input.IndexName).toBe("type-index");
      expect(callArgs.input.ExpressionAttributeValues[":gsi1pk"]).toBe("TYPE#DESTINATION");
    });

    it("handles pagination with Limit and LastEvaluatedKey", async () => {
      const mockItems = [{ destination_id: "d1" }];
      const lastKey = { PK: "DESTINATION#d1", SK: "CONFIG", GSI1PK: "TYPE#DESTINATION" };
      (ddb.send as jest.Mock).mockResolvedValueOnce({
        Items: mockItems,
        LastEvaluatedKey: lastKey,
      });

      const result = await listDiscordDestinations({ limit: 1 });
      expect(result.items).toHaveLength(1);
      expect(result.nextToken).toBeDefined();

      // Test next request with nextToken
      (ddb.send as jest.Mock).mockResolvedValueOnce({
        Items: [{ destination_id: "d2" }],
      });
      const secondResult = await listDiscordDestinations({ nextToken: result.nextToken });
      expect(secondResult.items).toHaveLength(1);
      const secondCallArgs = (ddb.send as jest.Mock).mock.calls[1][0];
      expect(secondCallArgs.input.ExclusiveStartKey).toEqual(lastKey);
    });

    it("applies activeOnly filter when requested", async () => {
      (ddb.send as jest.Mock).mockResolvedValueOnce({ Items: [] });

      await listDiscordDestinations({ activeOnly: true });
      const callArgs = (ddb.send as jest.Mock).mock.calls[0][0];
      expect(callArgs.input.FilterExpression).toBe("#active = :isActive");
      expect(callArgs.input.ExpressionAttributeValues[":isActive"]).toBe(true);
    });
  });

  describe("updateDiscordDestination", () => {
    it("updates display_name and is_active with condition check", async () => {
      const updatedItem = {
        PK: "DESTINATION#d1",
        SK: "CONFIG",
        destination_id: "d1",
        display_name: "Renamed Channel",
        is_active: false,
      };
      (ddb.send as jest.Mock).mockResolvedValueOnce({ Attributes: updatedItem });

      const result = await updateDiscordDestination("d1", {
        display_name: "Renamed Channel",
        is_active: false,
      });

      expect(result).toEqual(updatedItem);
      const callArgs = (ddb.send as jest.Mock).mock.calls[0][0];
      expect(callArgs.input.ConditionExpression).toBe("attribute_exists(PK)");
      expect(callArgs.input.UpdateExpression).toContain("#name = :name");
      expect(callArgs.input.UpdateExpression).toContain("#active = :active");
      expect(callArgs.input.UpdateExpression).toContain("#updatedAt = :now");
    });

    it("validates webhook URL when updated", async () => {
      await expect(
        updateDiscordDestination("d1", {
          discord_webhook_url: "https://malicious.com/webhook",
        }),
      ).rejects.toThrow("Invalid webhook domain");

      expect(ddb.send).not.toHaveBeenCalled();
    });

    it("throws when destination does not exist", async () => {
      (ddb.send as jest.Mock).mockRejectedValueOnce(
        new ConditionalCheckFailedException({
          $metadata: {},
          message: "The conditional request failed",
        }),
      );

      await expect(
        updateDiscordDestination("nonexistent", { display_name: "Test" }),
      ).rejects.toThrow("Discord destination 'nonexistent' not found");
    });
  });

  describe("deactivateDiscordDestination", () => {
    it("soft-deactivates by setting is_active to false", async () => {
      const deactivatedItem = {
        destination_id: "d1",
        is_active: false,
      };
      (ddb.send as jest.Mock).mockResolvedValueOnce({ Attributes: deactivatedItem });

      const result = await deactivateDiscordDestination("d1");
      expect(result.is_active).toBe(false);
      const callArgs = (ddb.send as jest.Mock).mock.calls[0][0];
      expect(callArgs.input.ExpressionAttributeValues[":active"]).toBe(false);
    });
  });
});

