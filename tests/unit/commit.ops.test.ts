import { saveCommit } from "../../src/db/operations/commit.ops";
import { ddb } from "../../src/db/client";
import { EnrichedCommit } from "../../src/types/github.types";

jest.mock("../../src/db/client", () => ({
  ddb: {
    send: jest.fn(),
  },
}));

describe("commit.ops", () => {
  const mockCommit: EnrichedCommit = {
    id: "a81f23c9b42e1f6c3d8290456ae182736f45b2c1",
    tree_id: "tree123",
    distinct: true,
    message: "feat: add commit ops test",
    timestamp: "2026-10-15T00:00:00Z",
    url: "https://github.com/acme/syncro/commit/a81f23c",
    author: { name: "Pratik", email: "pratik@example.com" },
    committer: { name: "Pratik", email: "pratik@example.com" },
    added: ["file.ts"],
    removed: [],
    modified: [],
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    allChangedFiles: ["file.ts"],
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("persists commit to DynamoDB with correct keys and fields", async () => {
    (ddb.send as jest.Mock).mockResolvedValueOnce({});

    await saveCommit("12345", "deliv-10", "main", mockCommit);

    expect(ddb.send).toHaveBeenCalledTimes(1);
    const callArgs = (ddb.send as jest.Mock).mock.calls[0][0];
    expect(callArgs.input.Item.PK).toBe("REPO#12345");
    expect(callArgs.input.Item.SK).toBe("COMMIT#a81f23c9b42e1f6c3d8290456ae182736f45b2c1");
    expect(callArgs.input.Item.short_sha).toBe("a81f23c");
    expect(callArgs.input.Item.author_name).toBe("Pratik");
  });
});