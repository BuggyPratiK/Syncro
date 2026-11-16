/**
 * Proof-of-ownership guards:
 * - a verification result is accepted for exactly 15 minutes;
 * - branded proof types cannot be built from plain objects (compile-time):
 *   each `@ts-expect-error` below fails the test build if the assignment ever
 *   starts compiling, i.e. if a brand is lost.
 */

import { assertFreshVerification } from "../../src/db/operations/installation.ops";
import type {
  VerifiedInstallation,
  VerifiedRepoAssociation,
  VerifiedRepositoryListing,
  WorkspaceContext,
} from "../../src/contracts";

describe("verification freshness", () => {
  const verifiedAt = "2026-11-16T10:00:00.000Z";
  const at = Date.parse(verifiedAt);

  it("accepts a result exactly 15 minutes old", () => {
    expect(() => assertFreshVerification(verifiedAt, at + 15 * 60_000)).not.toThrow();
  });

  it("rejects a result 15 minutes + 1 ms old", () => {
    expect(() => assertFreshVerification(verifiedAt, at + 15 * 60_000 + 1)).toThrow(
      expect.objectContaining({ code: "not_installation_owner" }),
    );
  });

  it("allows up to one minute of clock skew into the future, not more", () => {
    expect(() => assertFreshVerification(verifiedAt, at - 60_000)).not.toThrow();
    expect(() => assertFreshVerification(verifiedAt, at - 60_001)).toThrow();
  });
});

describe("branded proof types", () => {
  it("cannot be constructed from plain objects", () => {
    // @ts-expect-error — a WorkspaceContext only comes from resolveWorkspaceContext.
    const ctx: WorkspaceContext = { userId: "logto:abcdef123456", workspaceId: "ws_x", role: "owner" };

    // @ts-expect-error — a VerifiedInstallation only comes from the GitHub verification library.
    const inst: VerifiedInstallation = {
      installationId: "1",
      githubUserId: "2",
      accountId: "2",
      accountLogin: "a",
      accountType: "User",
      proof: "personal_owner",
      verifiedVia: "user_oauth",
      verifiedAt: "x",
    };

    // @ts-expect-error — a listing only comes from listUserInstallationRepositories.
    const listing: VerifiedRepositoryListing = { installationId: "1", githubUserId: "2", repos: [], verifiedAt: "x" };

    // @ts-expect-error — an association only comes from registerRepo.
    const assoc: VerifiedRepoAssociation = {
      installationId: "1",
      repoId: "3",
      fullName: "a/b",
      listingId: "l",
      verifiedVia: "user_oauth",
      verifiedAt: "x",
    };

    // The values exist only to make the type checks above meaningful.
    expect([ctx, inst, listing, assoc]).toHaveLength(4);
  });
});
