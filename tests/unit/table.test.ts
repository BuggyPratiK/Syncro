import {
  keys,
  gsiKeys,
  tableName,
  buildNotificationId,
  extractDestinationId,
} from "../../src/db/table";

describe("DynamoDB Table Key Builders", () => {
  const originalEnv = process.env;

  beforeEach(() => {
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

  it("tableName returns configured DYNAMODB_TABLE_NAME", () => {
    expect(tableName()).toBe("test-syncro-table");
  });

  it("builds repoConfig keys correctly", () => {
    expect(keys.repoConfig("987654")).toEqual({
      PK: "REPO#987654",
      SK: "CONFIG",
    });
    expect(keys.repoConfig(12345)).toEqual({
      PK: "REPO#12345",
      SK: "CONFIG",
    });
  });

  it("builds delivery deduplication keys correctly", () => {
    expect(keys.delivery("deliv-uuid-1234")).toEqual({
      PK: "DELIVERY#deliv-uuid-1234",
      SK: "DELIVERY#deliv-uuid-1234",
    });
  });

  it("builds commit record keys correctly", () => {
    expect(keys.commit("987654", "a81f23c9b42e")).toEqual({
      PK: "REPO#987654",
      SK: "COMMIT#a81f23c9b42e",
    });
  });

  it("builds notification log keys correctly", () => {
    expect(keys.notification("987654", "deliv-1#discord#webhook-id")).toEqual({
      PK: "REPO#987654",
      SK: "NOTIF#deliv-1#discord#webhook-id",
    });
  });

  it("buildNotificationId builds deterministic key with and without destinationId", () => {
    expect(buildNotificationId("deliv-1", "discord")).toBe("deliv-1#discord");
    expect(buildNotificationId("deliv-1", "Discord", "123456789")).toBe("deliv-1#discord#123456789");
  });

  it("extractDestinationId safely extracts Discord webhook ID without secret token", () => {
    const url = "https://discord.com/api/webhooks/9876543210/secret_token_value_xyz";
    expect(extractDestinationId(url)).toBe("9876543210");
  });

  it("extractDestinationId hashes non-discord URLs to avoid secret leakage", () => {
    const url = "https://custom.hook/receiver?token=super_secret";
    const destId = extractDestinationId(url);
    expect(destId).toBeDefined();
    expect(destId).toHaveLength(10);
    expect(destId).not.toContain("super_secret");
  });

  it("extractDestinationId returns undefined when no URL provided", () => {
    expect(extractDestinationId(undefined)).toBeUndefined();
  });

  it("builds destination keys correctly", () => {
    expect(keys.destination("dest-uuid-5678")).toEqual({
      PK: "DESTINATION#dest-uuid-5678",
      SK: "CONFIG",
    });
  });

  it("builds GSI keys correctly", () => {
    expect(gsiKeys.allRepos()).toBe("TYPE#REPO");
    expect(gsiKeys.allDestinations()).toBe("TYPE#DESTINATION");
  });
});