import { keys, gsiKeys, tableName } from "../../src/db/table";

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
    const ts = "2026-10-15T00:00:00.000Z";
    expect(keys.notification("987654", ts)).toEqual({
      PK: "REPO#987654",
      SK: `NOTIF#${ts}`,
    });
  });

  it("builds GSI keys correctly", () => {
    expect(gsiKeys.allRepos()).toBe("TYPE#REPO");
  });
});