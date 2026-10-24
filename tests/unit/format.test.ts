import { shortSha, truncateMessage, branchFromRef, formatDiff } from "../../src/utils/format";

describe("shortSha", () => {
  it("returns first 7 characters", () => {
    expect(shortSha("a81f23c9b42e1f6c3d82")).toBe("a81f23c");
  });
});

describe("truncateMessage", () => {
  it("returns short messages unchanged", () => {
    expect(truncateMessage("Fix bug")).toBe("Fix bug");
  });
  it("truncates long messages", () => {
    const long = "A".repeat(100);
    const result = truncateMessage(long, 72);
    expect(result.length).toBe(72);
    expect(result.endsWith("...")).toBe(true);
  });
  it("uses only the first line of multi-line messages", () => {
    expect(truncateMessage("First line\nSecond line")).toBe("First line");
  });
});

describe("branchFromRef", () => {
  it("strips refs/heads/ prefix", () => {
    expect(branchFromRef("refs/heads/main")).toBe("main");
  });
  it("strips refs/tags/ prefix", () => {
    expect(branchFromRef("refs/tags/v1.0.0")).toBe("v1.0.0");
  });
  it("returns feature branch names correctly", () => {
    expect(branchFromRef("refs/heads/feature/my-feature")).toBe("feature/my-feature");
  });
});

describe("formatDiff", () => {
  it("formats addition and deletion counts", () => {
    expect(formatDiff(142, 37)).toBe("+142 / -37");
  });
});
