import { describe, expect, it } from "vitest";
import { rememberAuthorizeInstallation, takeAuthorizeInstallation } from "./pending-authorize";
import { parseSetupReturn } from "./setup-return";

const STATE = "a".repeat(43);

describe("parseSetupReturn", () => {
  it("recognises the install return", () => {
    expect(parseSetupReturn(`?code=abc&installation_id=12&setup_action=install&state=${STATE}`)).toEqual({
      kind: "install",
      code: "abc",
      state: STATE,
      installationId: "12",
    });
  });

  it("recognises the authorize return (no installation_id)", () => {
    expect(parseSetupReturn(`?code=abc&iss=https%3A%2F%2Fgithub.com&state=${STATE}`)).toEqual({
      kind: "authorize",
      code: "abc",
      state: STATE,
    });
  });

  it("treats an installation change without a Syncro state as not completable", () => {
    expect(parseSetupReturn("?installation_id=12&setup_action=update")).toEqual({ kind: "installation_changed" });
  });

  it("recognises a cancelled authorization", () => {
    expect(parseSetupReturn("?error=access_denied&state=x")).toEqual({ kind: "denied" });
  });

  it.each([
    "",
    "?code=abc",
    `?code=bad code&state=${STATE}`,
    "?code=abc&state=short",
    `?code=abc&installation_id=0&state=${STATE}`,
    `?code=abc&installation_id=12x&state=${STATE}`,
  ])("rejects malformed input %s", (search) => {
    expect(parseSetupReturn(search)).toEqual({ kind: "invalid" });
  });
});

describe("pending authorize installation", () => {
  it("is read once", () => {
    rememberAuthorizeInstallation("77", 1_000);
    expect(takeAuthorizeInstallation(2_000)).toBe("77");
    expect(takeAuthorizeInstallation(2_000)).toBeNull();
  });

  it("expires with the state lifetime", () => {
    rememberAuthorizeInstallation("77", 0);
    expect(takeAuthorizeInstallation(11 * 60 * 1000)).toBeNull();
  });

  it("refuses an invalid ID and ignores tampered storage", () => {
    expect(() => rememberAuthorizeInstallation("1/2")).toThrow();
    sessionStorage.setItem("syncro.authorizeInstallation", JSON.stringify({ installationId: "../x", at: Date.now() }));
    expect(takeAuthorizeInstallation()).toBeNull();
  });
});
