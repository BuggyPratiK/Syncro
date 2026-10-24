import { buildPushEmbed } from "../../src/notifications/templates/push.template";
import { NotificationPayload } from "../../src/types/notification.types";

describe("buildPushEmbed", () => {
  const basePayload: NotificationPayload = {
    type: "push",
    repoFullName: "acme/syncro",
    repoUrl: "https://github.com/acme/syncro",
    branch: "main",
    pusherName: "pratik",
    commits: [
      {
        sha: "a81f23c9b42e1f6c3d8290456ae182736f45b2c1",
        shortSha: "a81f23c",
        message: "feat: add webhook idempotency",
        url: "https://github.com/acme/syncro/commit/a81f23c",
        authorName: "Pratik",
      },
      {
        sha: "c92bd112b33e2f7c4d930156bf2938477f56c3d2",
        shortSha: "c92bd11",
        message: "fix: resolve DynamoDB condition",
        url: "https://github.com/acme/syncro/commit/c92bd11",
        authorName: "Pratik",
      },
    ],
    totalAdditions: 60,
    totalDeletions: 13,
    totalFilesChanged: 3,
    changedFiles: [
      "src/handler.ts",
      "src/db/table.ts",
      "src/db/operations/delivery.ops.ts",
    ],
    compareUrl: "https://github.com/acme/syncro/compare/before...after",
    timestamp: "2026-10-15T00:00:00Z",
  };

  it("generates an embed with correct title, description, and color", () => {
    const embed = buildPushEmbed(basePayload);
    expect(embed.title).toContain("MAIN updated - acme/syncro");
    expect(embed.description).toContain("**2 commits** pushed by **pratik**");
    expect(embed.description).toContain("+60 / -13");
    expect(embed.color).toBe(0x2ea043);
    expect(embed.url).toBe(basePayload.compareUrl);
    expect(embed.timestamp).toBe(basePayload.timestamp);
    expect(embed.footer.text).toContain("Syncro");
  });

  it("includes commits list and files changed in fields", () => {
    const embed = buildPushEmbed(basePayload);
    const commitField = embed.fields.find((f) => f.name.includes("Commits"));
    expect(commitField).toBeDefined();
    expect(commitField?.value).toContain("`a81f23c` feat: add webhook idempotency");
    expect(commitField?.value).toContain("`c92bd11` fix: resolve DynamoDB condition");

    const filesField = embed.fields.find((f) => f.name.includes("Files Changed"));
    expect(filesField).toBeDefined();
    expect(filesField?.value).toContain("`src/handler.ts`");
    expect(filesField?.value).toContain("`src/db/table.ts`");

    const syncField = embed.fields.find((f) => f.name.includes("Sync your repo"));
    expect(syncField?.value).toContain("git pull origin main");
  });

  it("caps commits list when more than 5 commits are pushed", () => {
    const payloadWithManyCommits: NotificationPayload = {
      ...basePayload,
      commits: Array.from({ length: 8 }, (_, i) => ({
        sha: `sha${i}12345678901234567890`,
        shortSha: `sha${i}123`,
        message: `commit ${i + 1}`,
        url: `https://github.com/acme/syncro/commit/sha${i}`,
        authorName: "Pratik",
      })),
    };

    const embed = buildPushEmbed(payloadWithManyCommits);
    const commitField = embed.fields.find((f) => f.name.includes("Commits"));
    expect(commitField?.value).toContain("...and 3 more");
  });

  it("caps files list when more than 6 files are changed", () => {
    const payloadWithManyFiles: NotificationPayload = {
      ...basePayload,
      changedFiles: Array.from({ length: 10 }, (_, i) => `file${i}.ts`),
    };

    const embed = buildPushEmbed(payloadWithManyFiles);
    const filesField = embed.fields.find((f) => f.name.includes("Files Changed"));
    expect(filesField?.value).toContain("...and 4 more");
  });

  it("handles singular commit and file counts properly", () => {
    const singlePayload: NotificationPayload = {
      ...basePayload,
      commits: [basePayload.commits[0]],
      changedFiles: ["single.ts"],
      totalFilesChanged: 1,
    };

    const embed = buildPushEmbed(singlePayload);
    expect(embed.description).toContain("**1 commit** pushed by **pratik**");
    expect(embed.description).toContain("1 file changed");
  });
});