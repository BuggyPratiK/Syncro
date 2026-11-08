import { buildPrEmbed } from "../../src/notifications/templates/pr.template";
import { NotificationPayload } from "../../src/types/notification.types";

describe("buildPrEmbed", () => {
  const basePayload: NotificationPayload = {
    type: "pull_request",
    repoFullName: "acme/syncro",
    repoUrl: "https://github.com/acme/syncro",
    branch: "main",
    pusherName: "pratik",
    commits: [],
    totalAdditions: 120,
    totalDeletions: 15,
    totalFilesChanged: 3,
    changedFiles: [],
    compareUrl: "https://github.com/acme/syncro/pull/42",
    timestamp: "2026-11-08T10:00:00Z",
    pullRequest: {
      action: "opened",
      number: 42,
      title: "feat: add user authentication",
      body: "Adds JWT auth middleware and login endpoint.",
      url: "https://github.com/acme/syncro/pull/42",
      authorName: "pratik",
      authorAvatarUrl: "https://github.com/avatar.png",
      baseBranch: "main",
      headBranch: "feature/auth",
      merged: false,
      draft: false,
    },
  };

  it("generates embed for PR opened with green color and review guidance", () => {
    const embed = buildPrEmbed(basePayload);

    expect(embed.title).toContain("PR #42 opened - acme/syncro");
    expect(embed.description).toContain("**feat: add user authentication**");
    expect(embed.description).toContain("Opened by **pratik**");
    expect(embed.color).toBe(0x2ea043);
    expect(embed.url).toBe(basePayload.pullRequest?.url);
    expect(embed.timestamp).toBe(basePayload.timestamp);
    expect(embed.footer.text).toContain("Syncro");

    const branchField = embed.fields.find((f) => f.name === "🎯 Branches");
    expect(branchField?.value).toContain("`feature/auth` ➔ `main`");

    const changesField = embed.fields.find((f) => f.name === "📊 Changes");
    expect(changesField?.value).toContain("+120 / -15 • 3 files changed");

    const descField = embed.fields.find((f) => f.name === "📝 Description");
    expect(descField?.value).toBe("Adds JWT auth middleware and login endpoint.");

    const actionField = embed.fields.find((f) => f.name === "👀 Review Required");
    expect(actionField?.value).toContain("Review the proposed changes");
  });

  it("generates embed for PR merged with purple color and git pull command", () => {
    const mergedPayload: NotificationPayload = {
      ...basePayload,
      pullRequest: {
        ...basePayload.pullRequest!,
        action: "closed",
        merged: true,
      },
    };

    const embed = buildPrEmbed(mergedPayload);

    expect(embed.title).toContain("PR #42 merged into main - acme/syncro");
    expect(embed.color).toBe(0x8250df);

    const syncField = embed.fields.find((f) => f.name.includes("Sync your local branch"));
    expect(syncField?.name).toBe("🔄 Sync your local branch with main");
    expect(syncField?.value).toContain("git pull origin main");
  });

  it("uses custom base branch in sync instruction label for non-main branches", () => {
    const devMergedPayload: NotificationPayload = {
      ...basePayload,
      pullRequest: {
        ...basePayload.pullRequest!,
        baseBranch: "develop",
        action: "closed",
        merged: true,
      },
    };

    const embed = buildPrEmbed(devMergedPayload);
    const syncField = embed.fields.find((f) => f.name.includes("Sync your local branch"));
    expect(syncField?.name).toBe("🔄 Sync your local branch with develop");
    expect(syncField?.value).toContain("git pull origin develop");
  });

  it("generates embed for PR closed without merging with red color", () => {
    const closedPayload: NotificationPayload = {
      ...basePayload,
      pullRequest: {
        ...basePayload.pullRequest!,
        action: "closed",
        merged: false,
      },
    };

    const embed = buildPrEmbed(closedPayload);

    expect(embed.title).toContain("PR #42 closed without merging - acme/syncro");
    expect(embed.color).toBe(0xf85149);
  });

  it("generates embed for draft PR with gray color", () => {
    const draftPayload: NotificationPayload = {
      ...basePayload,
      pullRequest: {
        ...basePayload.pullRequest!,
        draft: true,
      },
    };

    const embed = buildPrEmbed(draftPayload);

    expect(embed.title).toContain("PR #42 opened as draft - acme/syncro");
    expect(embed.color).toBe(0x6e7681);
  });

  it("generates embed for reopened PR", () => {
    const reopenedPayload: NotificationPayload = {
      ...basePayload,
      pullRequest: {
        ...basePayload.pullRequest!,
        action: "reopened",
      },
    };

    const embed = buildPrEmbed(reopenedPayload);

    expect(embed.title).toContain("PR #42 reopened - acme/syncro");
    expect(embed.color).toBe(0x2ea043);
  });

  it("falls back gracefully if pullRequest metadata is missing", () => {
    const payloadWithoutPr: NotificationPayload = {
      ...basePayload,
      pullRequest: undefined,
    };

    const embed = buildPrEmbed(payloadWithoutPr);

    expect(embed.title).toBe("🔀 Pull Request - acme/syncro");
    expect(embed.color).toBe(0x2ea043);
  });
});

