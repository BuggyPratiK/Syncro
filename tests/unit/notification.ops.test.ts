import {
  createNotificationRecord,
  markNotificationSent,
  markNotificationFailed,
} from "../../src/db/operations/notification.ops";
import { ddb } from "../../src/db/client";

jest.mock("../../src/db/client", () => ({
  ddb: {
    send: jest.fn(),
  },
}));

describe("notification.ops", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("createNotificationRecord puts a pending notification item", async () => {
    (ddb.send as jest.Mock).mockResolvedValueOnce({});

    const timestamp = await createNotificationRecord("repo-1", "deliv-1", "discord");

    expect(typeof timestamp).toBe("string");
    expect(ddb.send).toHaveBeenCalledTimes(1);
    const callArgs = (ddb.send as jest.Mock).mock.calls[0][0];
    expect(callArgs.input.Item.PK).toBe("REPO#repo-1");
    expect(callArgs.input.Item.status).toBe("pending");
    expect(callArgs.input.Item.channel).toBe("discord");
  });

  it("markNotificationSent updates record to sent", async () => {
    (ddb.send as jest.Mock).mockResolvedValueOnce({});

    await markNotificationSent("repo-1", "2026-10-15T00:00:00Z", "msg-123");

    expect(ddb.send).toHaveBeenCalledTimes(1);
    const callArgs = (ddb.send as jest.Mock).mock.calls[0][0];
    expect(callArgs.input.ExpressionAttributeValues[":status"]).toBe("sent");
    expect(callArgs.input.ExpressionAttributeValues[":messageId"]).toBe("msg-123");
  });

  it("markNotificationFailed updates record to failed with error message", async () => {
    (ddb.send as jest.Mock).mockResolvedValueOnce({});

    await markNotificationFailed("repo-1", "2026-10-15T00:00:00Z", "Rate limit exceeded", 1);

    expect(ddb.send).toHaveBeenCalledTimes(1);
    const callArgs = (ddb.send as jest.Mock).mock.calls[0][0];
    expect(callArgs.input.ExpressionAttributeValues[":status"]).toBe("failed");
    expect(callArgs.input.ExpressionAttributeValues[":error"]).toBe("Rate limit exceeded");
    expect(callArgs.input.ExpressionAttributeValues[":retries"]).toBe(1);
  });
});