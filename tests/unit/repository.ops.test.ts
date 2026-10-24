import { getRepoConfig } from "../../src/db/operations/repository.ops";
import { ddb } from "../../src/db/client";

jest.mock("../../src/db/client", () => ({
  ddb: {
    send: jest.fn(),
  },
}));

describe("repository.ops", () => {
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
        repo_full_name: "acme/syncro",
        discord_webhook_url: "https://discord.com/api/webhooks/custom",
        is_active: true,
        created_at: "2026-10-15T00:00:00Z",
      };
      (ddb.send as jest.Mock).mockResolvedValueOnce({ Item: mockItem });
      const result = await getRepoConfig("12345");
      expect(result).toEqual(mockItem);
    });
  });
});