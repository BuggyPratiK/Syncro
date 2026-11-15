import { keys, tableName, buildNotificationId } from "../../src/db/table";

describe("DynamoDB Table Key Builders", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      DYNAMODB_TABLE_NAME: "test-syncro-table",
      GITHUB_APP_ID: "123",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("tableName returns configured DYNAMODB_TABLE_NAME", () => {
    expect(tableName()).toBe("test-syncro-table");
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





});