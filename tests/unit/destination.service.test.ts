import {
  toSafeDestinationDto,
  createDestinationService,
  getDestinationService,
  listDestinationsService,
  updateDestinationService,
  deactivateDestinationService,
} from "../../src/services/destination.service";
import * as destOps from "../../src/db/operations/destination.ops";
import { DiscordDestinationItem } from "../../src/types/dynamodb.types";

jest.mock("../../src/db/operations/destination.ops");

describe("destination.service", () => {
  const mockItem: DiscordDestinationItem = {
    PK: "DESTINATION#dest-101",
    SK: "CONFIG",
    destination_id: "dest-101",
    provider: "discord",
    display_name: "Engineering Team",
    discord_webhook_url: "https://discord.com/api/webhooks/987654321/secret_token_12345",
    is_active: true,
    GSI1PK: "TYPE#DESTINATION",
    created_at: "2026-10-15T00:00:00Z",
    updated_at: "2026-10-15T00:00:00Z",
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("toSafeDestinationDto", () => {
    it("strips raw webhook token and provides masked URL", () => {
      const dto = toSafeDestinationDto(mockItem);

      expect(dto.destination_id).toBe("dest-101");
      expect(dto.provider).toBe("discord");
      expect(dto.display_name).toBe("Engineering Team");
      expect(dto.is_active).toBe(true);
      expect((dto as any).discord_webhook_url).toBeUndefined();
      expect(dto.webhook_url_masked).toContain("https://discord.com/api/webhooks/987654321/");
      expect(dto.webhook_url_masked).not.toContain("secret_token_12345");
      expect(dto.webhook_url_masked).toContain("[REDACTED]");
    });
  });

  describe("createDestinationService", () => {
    it("creates destination and returns safe DTO", async () => {
      jest.spyOn(destOps, "createDiscordDestination").mockResolvedValueOnce(mockItem);

      const result = await createDestinationService({
        display_name: "Engineering Team",
        discord_webhook_url: mockItem.discord_webhook_url,
      });

      expect(result.destination_id).toBe("dest-101");
      expect(result.webhook_url_masked).toBeDefined();
      expect((result as any).discord_webhook_url).toBeUndefined();
    });
  });

  describe("getDestinationService", () => {
    it("returns null when not found", async () => {
      jest.spyOn(destOps, "getDiscordDestination").mockResolvedValueOnce(null);
      const result = await getDestinationService("nonexistent");
      expect(result).toBeNull();
    });

    it("returns safe DTO when found", async () => {
      jest.spyOn(destOps, "getDiscordDestination").mockResolvedValueOnce(mockItem);
      const result = await getDestinationService("dest-101");
      expect(result?.destination_id).toBe("dest-101");
      expect((result as any)?.discord_webhook_url).toBeUndefined();
    });
  });

  describe("listDestinationsService", () => {
    it("returns array of safe DTOs with masked URLs", async () => {
      jest.spyOn(destOps, "listDiscordDestinations").mockResolvedValueOnce({
        items: [mockItem],
        nextToken: "token-abc",
      });

      const result = await listDestinationsService();
      expect(result.items).toHaveLength(1);
      expect(result.items[0].destination_id).toBe("dest-101");
      expect((result.items[0] as any).discord_webhook_url).toBeUndefined();
      expect(result.items[0].webhook_url_masked).toContain("[REDACTED]");
      expect(result.nextToken).toBe("token-abc");
    });
  });

  describe("updateDestinationService", () => {
    it("updates destination and returns safe DTO", async () => {
      const updated = { ...mockItem, display_name: "New Name" };
      jest.spyOn(destOps, "updateDiscordDestination").mockResolvedValueOnce(updated);

      const result = await updateDestinationService("dest-101", { display_name: "New Name" });
      expect(result.display_name).toBe("New Name");
      expect((result as any).discord_webhook_url).toBeUndefined();
    });
  });

  describe("deactivateDestinationService", () => {
    it("deactivates destination and returns safe DTO", async () => {
      const deactivated = { ...mockItem, is_active: false };
      jest.spyOn(destOps, "deactivateDiscordDestination").mockResolvedValueOnce(deactivated);

      const result = await deactivateDestinationService("dest-101");
      expect(result.is_active).toBe(false);
      expect((result as any).discord_webhook_url).toBeUndefined();
    });
  });
});
