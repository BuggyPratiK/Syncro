import {
  findActiveRepo,
  toSafeRepoDto,
  createRepoService,
  getRepoConfigService,
  listReposService,
  updateRepoService,
  deactivateRepoService,
  getRepositoriesForDestination,
} from "../../src/services/repository.service";
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
    discord_destination_id: "dest-uuid-abc",
    discord_webhook_url: "https://discord.com/api/webhooks/123/secret",
    watched_branch: "main",
    is_active: true,
    GSI1PK: "TYPE#REPO",
    created_at: "2026-10-15T00:00:00Z",
    updated_at: "2026-10-15T00:00:00Z",
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("toSafeRepoDto", () => {
    it("omits discord_webhook_url from repository DTO", () => {
      const dto = toSafeRepoDto(mockRepoConfig);
      expect(dto.github_repo_id).toBe("123");
      expect(dto.github_full_name).toBe("acme/syncro");
      expect(dto.discord_destination_id).toBe("dest-uuid-abc");
      expect((dto as any).discord_webhook_url).toBeUndefined();
    });
  });

  describe("findActiveRepo", () => {
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

  describe("createRepoService", () => {
    it("creates repo and returns safe DTO", async () => {
      jest.spyOn(repoOps, "createRepo").mockResolvedValueOnce(mockRepoConfig);

      const result = await createRepoService({
        github_repo_id: "123",
        github_full_name: "acme/syncro",
        github_url: "https://github.com/acme/syncro",
        discord_destination_id: "dest-uuid-abc",
      });

      expect(result.github_repo_id).toBe("123");
      expect((result as any).discord_webhook_url).toBeUndefined();
    });
  });

  describe("getRepoConfigService", () => {
    it("returns null when not found", async () => {
      jest.spyOn(repoOps, "getRepoConfig").mockResolvedValueOnce(null);
      expect(await getRepoConfigService("999")).toBeNull();
    });

    it("returns safe DTO when found", async () => {
      jest.spyOn(repoOps, "getRepoConfig").mockResolvedValueOnce(mockRepoConfig);
      const result = await getRepoConfigService("123");
      expect(result?.github_repo_id).toBe("123");
      expect((result as any)?.discord_webhook_url).toBeUndefined();
    });
  });

  describe("listReposService", () => {
    it("returns safe DTO items with pagination", async () => {
      jest.spyOn(repoOps, "listRepos").mockResolvedValueOnce({
        items: [mockRepoConfig],
        nextToken: "tok",
      });

      const result = await listReposService();
      expect(result.items).toHaveLength(1);
      expect((result.items[0] as any).discord_webhook_url).toBeUndefined();
      expect(result.nextToken).toBe("tok");
    });
  });

  describe("updateRepoService & deactivateRepoService", () => {
    it("updates repo and returns safe DTO", async () => {
      jest.spyOn(repoOps, "updateRepo").mockResolvedValueOnce(mockRepoConfig);
      const result = await updateRepoService("123", { watched_branch: "staging" });
      expect(result.github_repo_id).toBe("123");
      expect((result as any).discord_webhook_url).toBeUndefined();
    });

    it("deactivates repo and returns safe DTO", async () => {
      jest.spyOn(repoOps, "deactivateRepo").mockResolvedValueOnce({
        ...mockRepoConfig,
        is_active: false,
      });
      const result = await deactivateRepoService("123");
      expect(result.is_active).toBe(false);
      expect((result as any).discord_webhook_url).toBeUndefined();
    });
  });

  describe("getRepositoriesForDestination", () => {
    it("filters repositories matching destination ID", async () => {
      const otherRepo: RepoConfigItem = {
        ...mockRepoConfig,
        github_repo_id: "456",
        discord_destination_id: "different-dest",
      };
      jest.spyOn(repoOps, "listRepos").mockResolvedValueOnce({
        items: [mockRepoConfig, otherRepo],
      });

      const matched = await getRepositoriesForDestination("dest-uuid-abc");
      expect(matched).toHaveLength(1);
      expect(matched[0].github_repo_id).toBe("123");
    });
  });
});
