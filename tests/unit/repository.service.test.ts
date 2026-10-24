import { findActiveRepo } from "../../src/services/repository.service";
import * as repoOps from "../../src/db/operations/repository.ops";
import { RepoConfigItem } from "../../src/types/dynamodb.types";

jest.mock("../../src/db/operations/repository.ops");

describe("repository.service", () => {
  const mockRepoConfig: RepoConfigItem = {
    PK: "REPO#123",
    SK: "CONFIG",
    github_repo_id: "123",
    github_full_name: "acme/syncro",
    github_url: "https://github.com/acme/syncro",
    discord_webhook_url: "https://discord.com/api/webhooks/123",
    watched_branch: "main",
    is_active: true,
    GSI1PK: "TYPE#REPO",
    created_at: "2026-10-15T00:00:00Z",
    updated_at: "2026-10-15T00:00:00Z",
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns null when repository is not found in database", async () => {
    jest.spyOn(repoOps, "getRepoConfig").mockResolvedValueOnce(null);
    const result = await findActiveRepo("999");
    expect(result).toBeNull();
  });

  it("returns null when repository exists but is_active is false", async () => {
    jest.spyOn(repoOps, "getRepoConfig").mockResolvedValueOnce({
      ...mockRepoConfig,
      is_active: false,
    });
    const result = await findActiveRepo("123");
    expect(result).toBeNull();
  });

  it("returns RepoConfigItem when repository exists and is active", async () => {
    jest.spyOn(repoOps, "getRepoConfig").mockResolvedValueOnce(mockRepoConfig);
    const result = await findActiveRepo("123");
    expect(result).toEqual(mockRepoConfig);
  });
});