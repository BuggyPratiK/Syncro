import {
  createNotificationRecord,
  markNotificationSent,
  markNotificationFailed,
  getNotificationRecord,
} from "../../src/db/operations/notification.ops";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
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

  it("createNotificationRecord puts a deterministic pending notification item with condition attribute_not_exists", async () => {
    (ddb.send as jest.Mock).mockResolvedValueOnce({});

    const notifId = await createNotificationRecord("repo-1", "deliv-1", "discord", "webhook-42");

    expect(notifId).toBe("deliv-1#discord#webhook-42");
    expect(ddb.send).toHaveBeenCalledTimes(1);
    const callArgs = (ddb.send as jest.Mock).mock.calls[0][0];
    expect(callArgs.input.Item.PK).toBe("REPO#repo-1");
    expect(callArgs.input.Item.SK).toBe("NOTIF#deliv-1#discord#webhook-42");
    expect(callArgs.input.Item.status).toBe("pending");
    expect(callArgs.input.Item.channel).toBe("discord");
    expect(callArgs.input.Item.destination_id).toBe("webhook-42");
    expect(callArgs.input.Item.retry_count).toBe(0);
    expect(callArgs.input.Item.created_at).toBeDefined();
    expect(callArgs.input.ConditionExpression).toBe("attribute_not_exists(PK)");
  });

  it("handles repeated creation attempts during retries via conditional update", async () => {
    // 1st call throws ConditionalCheckFailedException (record already exists)
    const condError = new ConditionalCheckFailedException({
      $metadata: {},
      message: "Item already exists",
    });
    (ddb.send as jest.Mock)
      .mockRejectedValueOnce(condError) // PutCommand fails
      .mockResolvedValueOnce({}); // UpdateCommand succeeds

    const notifId = await createNotificationRecord("repo-1", "deliv-1", "discord", "webhook-42");

    expect(notifId).toBe("deliv-1#discord#webhook-42");
    expect(ddb.send).toHaveBeenCalledTimes(2);

    const updateCall = (ddb.send as jest.Mock).mock.calls[1][0];
    expect(updateCall.input.Key.SK).toBe("NOTIF#deliv-1#discord#webhook-42");
    expect(updateCall.input.UpdateExpression).toContain("SET #status = :pending");
    expect(updateCall.input.UpdateExpression).toContain("ADD retry_count :inc");
    expect(updateCall.input.ConditionExpression).toBe("attribute_not_exists(PK) OR #status <> :sent");
    expect(updateCall.input.ExpressionAttributeValues[":inc"]).toBe(1);
  });

  it("idempotently ignores update when notification is already sent", async () => {
    const condError = new ConditionalCheckFailedException({
      $metadata: {},
      message: "Condition failed",
    });
    (ddb.send as jest.Mock)
      .mockRejectedValueOnce(condError) // PutCommand fails
      .mockRejectedValueOnce(condError); // UpdateCommand fails because already sent

    const notifId = await createNotificationRecord("repo-1", "deliv-1", "discord");

    expect(notifId).toBe("deliv-1#discord");
    expect(ddb.send).toHaveBeenCalledTimes(2);
  });

  it("markNotificationSent updates record to sent with timestamps", async () => {
    (ddb.send as jest.Mock).mockResolvedValueOnce({});

    await markNotificationSent("repo-1", "deliv-1#discord", "msg-123");

    expect(ddb.send).toHaveBeenCalledTimes(1);
    const callArgs = (ddb.send as jest.Mock).mock.calls[0][0];
    expect(callArgs.input.Key.SK).toBe("NOTIF#deliv-1#discord");
    expect(callArgs.input.ExpressionAttributeValues[":status"]).toBe("sent");
    expect(callArgs.input.ExpressionAttributeValues[":messageId"]).toBe("msg-123");
    expect(callArgs.input.ExpressionAttributeValues[":sentAt"]).toBeDefined();
    expect(callArgs.input.ExpressionAttributeValues[":updatedAt"]).toBeDefined();
  });

  it("markNotificationFailed updates record to failed with error message and retry count", async () => {
    (ddb.send as jest.Mock).mockResolvedValueOnce({});

    await markNotificationFailed("repo-1", "deliv-1#discord", "Rate limit exceeded", 2);

    expect(ddb.send).toHaveBeenCalledTimes(1);
    const callArgs = (ddb.send as jest.Mock).mock.calls[0][0];
    expect(callArgs.input.Key.SK).toBe("NOTIF#deliv-1#discord");
    expect(callArgs.input.ExpressionAttributeValues[":status"]).toBe("failed");
    expect(callArgs.input.ExpressionAttributeValues[":error"]).toBe("Rate limit exceeded");
    expect(callArgs.input.ExpressionAttributeValues[":retries"]).toBe(2);
    expect(callArgs.input.ExpressionAttributeValues[":failedAt"]).toBeDefined();
  });

  it("getNotificationRecord retrieves record by repoId and notificationId", async () => {
    const mockItem = {
      PK: "REPO#repo-1",
      SK: "NOTIF#deliv-1#discord",
      status: "sent",
    };
    (ddb.send as jest.Mock).mockResolvedValueOnce({ Item: mockItem });

    const item = await getNotificationRecord("repo-1", "deliv-1#discord");

    expect(item).toEqual(mockItem);
    expect(ddb.send).toHaveBeenCalledTimes(1);
    const callArgs = (ddb.send as jest.Mock).mock.calls[0][0];
    expect(callArgs.input.Key).toEqual({
      PK: "REPO#repo-1",
      SK: "NOTIF#deliv-1#discord",
    });
  });
});