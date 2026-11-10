import {
  getRepoConfig,
  createRepo,
  updateRepo,
  deactivateRepo,
  listRepos,
  isValidRepoFullName,
} from "../../src/db/operations/repository.ops";
import * as destOps from "../../src/db/operations/destination.ops";
import { ddb } from "../../src/db/client";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";

jest.mock("../../src/db/client", () => ({
  ddb: {
    send: jest.fn(),
  },
}));

jest.mock("../../src/db/operations/destination.ops");

describe("repository.ops", () => {
  const originalEnv = process.env;
  const VALID_DEST_ID = "dest-uuid-111";

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      DYNAMODB_TABLE_NAME: "test-syncro-table",
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "dummy-key",
      GITHUB_WEBHOOK_SECRET: "dummy-secret",
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123456789/dummy_token",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("isValidRepoFullName", () => {
    it("validates owner/repo format correctly", () => {
      expect(isValidRepoFullName("acme/syncro")).toBe(true);
      expect(isValidRepoFullName("BuggyPratiK/Syncro")).toBe(true);
      expect(isValidRepoFullName("org-name/repo.js")).toBe(true);
      expect(isValidRepoFullName("invalid-no-slash")).toBe(false);
      expect(isValidRepoFullName("/invalid-leading-slash")).toBe(false);
      expect(isValidRepoFullName("invalid-trailing-slash/")).toBe(false);
      expect(isValidRepoFullName("")).toBe(false);
    });
  });

  describe("getRepoConfig", () => {
    it("returns null when repository is not found in DynamoDB", async () => {
      (ddb.send as jest.Mock).mockResolvedValueOnce({});
      const result = await getRepoConfig("nonexistent-repo");
      expect(result).toBeNull();
    });

    it("returns RepoConfigItem when repository exists", async () => {
      const mockItem = {
        PK: "REPO#12345",
        SK: "CONFIG",
        github_repo_id: "12345",
        github_full_name: "acme/syncro",
        discord_destination_id: VALID_DEST_ID,
        is_active: true,
        created_at: "2026-10-15T00:00:00Z",
      };
      (ddb.send as jest.Mock).mockResolvedValueOnce({ Item: mockItem });
      const result = await getRepoConfig("12345");
      expect(result).toEqual(mockItem);
    });

    it("returns null for falsy repo id", async () => {
      expect(await getRepoConfig("")).toBeNull();
    });
  });

  describe("createRepo", () => {
    it("creates repository successfully when destination exists and is active", async () => {
      jest.spyOn(destOps, "getDiscordDestination").mockResolvedValueOnce({
        PK: `DESTINATION#${VALID_DEST_ID}`,
        SK: "CONFIG",
        destination_id: VALID_DEST_ID,
        provider: "discord",
        display_name: "Alerts",
        discord_webhook_url: "https://discord.com/api/webhooks/123/token",
        is_active: true,
        GSI1PK: "TYPE#DESTINATION",
        created_at: "2026-10-15T00:00:00Z",
        updated_at: "2026-10-15T00:00:00Z",
      });
      (ddb.send as jest.Mock).mockResolvedValueOnce({});

      const result = await createRepo({
        github_repo_id: "998877",
        github_full_name: "acme/new-repo",
        github_url: "https://github.com/acme/new-repo",
        discord_destination_id: VALID_DEST_ID,
        watched_branch: "develop",
      });

      expect(result.github_repo_id).toBe("998877");
      expect(result.PK).toBe("REPO#998877");
      expect(result.SK).toBe("CONFIG");
      expect(result.GSI1PK).toBe("TYPE#REPO");
      expect(result.watched_branch).toBe("develop");
      expect(result.is_active).toBe(true);

      const callArgs = (ddb.send as jest.Mock).mock.calls[0][0];
      expect(callArgs.input.ConditionExpression).toBe("attribute_not_exists(PK)");
    });

    it("rejects repository creation if referenced destination does not exist", async () => {
      jest.spyOn(destOps, "getDiscordDestination").mockResolvedValueOnce(null);

      await expect(
        createRepo({
          github_repo_id: "998877",
          github_full_name: "acme/new-repo",
          github_url: "https://github.com/acme/new-repo",
          discord_destination_id: "missing-dest",
        }),
      ).rejects.toThrow("Referenced Discord destination 'missing-dest' does not exist");

      expect(ddb.send).not.toHaveBeenCalled();
    });

    it("rejects repository creation if referenced destination is inactive", async () => {
      jest.spyOn(destOps, "getDiscordDestination").mockResolvedValueOnce({
        PK: `DESTINATION#${VALID_DEST_ID}`,
        SK: "CONFIG",
        destination_id: VALID_DEST_ID,
        provider: "discord",
        display_name: "Alerts",
        discord_webhook_url: "https://discord.com/api/webhooks/123/token",
        is_active: false,
        GSI1PK: "TYPE#DESTINATION",
        created_at: "2026-10-15T00:00:00Z",
        updated_at: "2026-10-15T00:00:00Z",
      });

      await expect(
        createRepo({
          github_repo_id: "998877",
          github_full_name: "acme/new-repo",
          github_url: "https://github.com/acme/new-repo",
          discord_destination_id: VALID_DEST_ID,
        }),
      ).rejects.toThrow(`Referenced Discord destination '${VALID_DEST_ID}' is inactive`);

      expect(ddb.send).not.toHaveBeenCalled();
    });

    it("rejects invalid repository full name", async () => {
      await expect(
        createRepo({
          github_repo_id: "998877",
          github_full_name: "invalid-name",
          github_url: "https://github.com/acme/new-repo",
        }),
      ).rejects.toThrow("Expected 'owner/repo'");
    });

    it("throws when repository is already registered", async () => {
      (ddb.send as jest.Mock).mockRejectedValueOnce(
        new ConditionalCheckFailedException({
          $metadata: {},
          message: "The conditional request failed",
        }),
      );

      await expect(
        createRepo({
          github_repo_id: "998877",
          github_full_name: "acme/new-repo",
          github_url: "https://github.com/acme/new-repo",
        }),
      ).rejects.toThrow("Repository with ID '998877' is already registered");
    });
  });

  describe("updateRepo", () => {
    it("updates allowlisted mutable fields with condition expression", async () => {
      jest.spyOn(destOps, "getDiscordDestination").mockResolvedValueOnce({
        PK: `DESTINATION#${VALID_DEST_ID}`,
        SK: "CONFIG",
        destination_id: VALID_DEST_ID,
        provider: "discord",
        display_name: "Alerts",
        discord_webhook_url: "https://discord.com/api/webhooks/123/token",
        is_active: true,
        GSI1PK: "TYPE#DESTINATION",
        created_at: "2026-10-15T00:00:00Z",
        updated_at: "2026-10-15T00:00:00Z",
      });

      const updated = {
        github_repo_id: "123",
        watched_branch: "release",
        discord_destination_id: VALID_DEST_ID,
      };
      (ddb.send as jest.Mock).mockResolvedValueOnce({ Attributes: updated });

      const result = await updateRepo("123", {
        watched_branch: "release",
        discord_destination_id: VALID_DEST_ID,
      });

      expect(result).toEqual(updated);
      const callArgs = (ddb.send as jest.Mock).mock.calls[0][0];
      expect(callArgs.input.ConditionExpression).toBe("attribute_exists(PK)");
      expect(callArgs.input.UpdateExpression).toContain("#branch = :branch");
      expect(callArgs.input.UpdateExpression).toContain("#destId = :destId");
      expect(callArgs.input.UpdateExpression).toContain("#updatedAt = :now");
    });

    it("throws when repository does not exist", async () => {
      (ddb.send as jest.Mock).mockRejectedValueOnce(
        new ConditionalCheckFailedException({
          $metadata: {},
          message: "The conditional request failed",
        }),
      );

      await expect(
        updateRepo("nonexistent", { watched_branch: "main" }),
      ).rejects.toThrow("Repository with ID 'nonexistent' not found");
    });
  });

  describe("deactivateRepo", () => {
    it("soft-deactivates by setting is_active to false", async () => {
      const deactivated = { github_repo_id: "123", is_active: false };
      (ddb.send as jest.Mock).mockResolvedValueOnce({ Attributes: deactivated });

      const result = await deactivateRepo("123");
      expect(result.is_active).toBe(false);
      const callArgs = (ddb.send as jest.Mock).mock.calls[0][0];
      expect(callArgs.input.ExpressionAttributeValues[":active"]).toBe(false);
    });
  });

  describe("listRepos", () => {
    it("queries type-index GSI for all repositories", async () => {
      const mockItems = [{ github_repo_id: "1" }, { github_repo_id: "2" }];
      (ddb.send as jest.Mock).mockResolvedValueOnce({ Items: mockItems });

      const result = await listRepos();
      expect(result.items).toEqual(mockItems);
      const callArgs = (ddb.send as jest.Mock).mock.calls[0][0];
      expect(callArgs.input.IndexName).toBe("type-index");
      expect(callArgs.input.ExpressionAttributeValues[":gsi1pk"]).toBe("TYPE#REPO");
    });

    it("handles pagination with nextToken", async () => {
      const lastKey = { PK: "REPO#1", SK: "CONFIG", GSI1PK: "TYPE#REPO" };
      (ddb.send as jest.Mock).mockResolvedValueOnce({
        Items: [{ github_repo_id: "1" }],
        LastEvaluatedKey: lastKey,
      });

      const result = await listRepos({ limit: 1 });
      expect(result.nextToken).toBeDefined();

      (ddb.send as jest.Mock).mockResolvedValueOnce({
        Items: [{ github_repo_id: "2" }],
      });
      await listRepos({ nextToken: result.nextToken });
      const secondCallArgs = (ddb.send as jest.Mock).mock.calls[1][0];
      expect(secondCallArgs.input.ExclusiveStartKey).toEqual(lastKey);
    });
  });
});
