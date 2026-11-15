/**
 * DynamoDB key builders and SSM parameter names: exact formats, and refusal of
 * any identifier that could inject key structure.
 */

import { DEST_SK_PREFIX, tenantGsiKeys, tenantKeys, utcDayOf } from "../../src/db/table";
import { InvalidIdentifierError } from "../../src/contracts";
import {
  dashboardParamNames,
  deriveDestinationParamName,
  senderParamNames,
} from "../../src/secrets/param-names";

const WS = "ws_3f1c2a9e-7b4d-4c1e-9a2b-1d2e3f4a5b6c";
const WS2 = "ws_9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";
const DEST = "8c0e6f1a-2b3c-4d5e-8f90-a1b2c3d4e5f6";
const LISTING = "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";
const UID = "logto:abcdef123456";
const NONCE = "abcDEF0123456789_-abcDEF0123456789_-abcDEF0";

describe("tenantKeys", () => {
  it("builds every tenant item key", () => {
    expect(tenantKeys.userProfile(UID)).toEqual({ PK: `USER#${UID}`, SK: "PROFILE" });
    expect(tenantKeys.userMembership(UID, WS)).toEqual({ PK: `USER#${UID}`, SK: `MEMBERSHIP#${WS}` });
    expect(tenantKeys.workspace(WS)).toEqual({ PK: `WS#${WS}`, SK: "META" });
    expect(tenantKeys.workspaceMember(WS, UID)).toEqual({ PK: `WS#${WS}`, SK: `MEMBER#${UID}` });
    expect(tenantKeys.destination(WS, DEST)).toEqual({ PK: `WS#${WS}`, SK: `DEST#${DEST}` });
    expect(DEST_SK_PREFIX).toBe("DEST#");
    expect(tenantKeys.githubUserLink(583231)).toEqual({ PK: "GHUSER#583231", SK: "LINK" });
    expect(tenantKeys.installation("12345678")).toEqual({ PK: "INSTALLATION#12345678", SK: "META" });
    expect(tenantKeys.repo(987654321)).toEqual({ PK: "REPO#987654321", SK: "CONFIG" });
    expect(tenantKeys.githubState(NONCE)).toEqual({ PK: `GHSTATE#${NONCE}`, SK: "META" });
    expect(tenantKeys.githubListing(LISTING)).toEqual({ PK: `GHLISTING#${LISTING}`, SK: "META" });
    expect(tenantKeys.ssmDestParamCounter()).toEqual({ PK: "SYSTEM#COUNTERS", SK: "SSM_DEST_PARAMS" });
    expect(tenantKeys.signupConfig()).toEqual({ PK: "SYSTEM#CONFIG", SK: "SIGNUP" });
    expect(tenantKeys.signupDay("2026-11-15")).toEqual({ PK: "SYSTEM#SIGNUPS", SK: "DAY#2026-11-15" });
    expect(tenantKeys.rateLimit(UID, "write", 29_000_000)).toEqual({ PK: `RATE#${UID}`, SK: "write#29000000" });
  });

  it("builds workspace-scoped type-index partitions", () => {
    expect(tenantGsiKeys.repos(WS)).toBe(`WS#${WS}#REPO`);
    expect(tenantGsiKeys.installations(WS)).toBe(`WS#${WS}#INSTALLATION`);
    expect(tenantGsiKeys.deliveries(WS)).toBe(`WS#${WS}#DELIVERY`);
  });

  it.each([
    ["workspace with key suffix", () => tenantKeys.workspace(`${WS}#MEMBER#x`)],
    ["destination under another prefix", () => tenantKeys.destination(WS, `${DEST}#x`)],
    ["uppercase uuid", () => tenantKeys.destination(WS, DEST.toUpperCase())],
    ["user id with #", () => tenantKeys.userProfile("logto:abcdef123456#x")],
    ["non-logto user", () => tenantKeys.userProfile("user_123")],
    ["github id with leading zero", () => tenantKeys.installation("0123")],
    ["github id non-numeric", () => tenantKeys.githubUserLink("12a")],
    ["negative github id", () => tenantKeys.repo(-1)],
    ["state with #", () => tenantKeys.githubState(`${NONCE.slice(1)}#`)],
    ["bad listing id", () => tenantKeys.githubListing("x")],
    ["bad day", () => tenantKeys.signupDay("2026-13-01")],
    ["gsi workspace", () => tenantGsiKeys.repos("ws_x")],
  ])("refuses %s", (_label, build) => {
    expect(build).toThrow(InvalidIdentifierError);
  });

  it("refuses unknown rate buckets and invalid windows", () => {
    expect(() => tenantKeys.rateLimit(UID, "read" as never, 1)).toThrow();
    expect(() => tenantKeys.rateLimit(UID, "write", -1)).toThrow();
    expect(() => tenantKeys.rateLimit(UID, "write", 1.5)).toThrow();
  });

  it("never echoes the rejected value", () => {
    try {
      tenantKeys.workspace("ws_<secret>");
      fail("expected throw");
    } catch (e) {
      expect((e as Error).message).not.toContain("<secret>");
    }
  });

  it("utcDayOf uses the UTC day boundary", () => {
    expect(utcDayOf(new Date("2026-11-15T23:59:59.999Z"))).toBe("2026-11-15");
    expect(utcDayOf(new Date("2026-11-16T00:00:00.000+05:30"))).toBe("2026-11-15");
  });
});

describe("SSM parameter names", () => {
  it("derives the destination parameter name from validated IDs", () => {
    expect(deriveDestinationParamName(WS, DEST, "/syncro/prod")).toBe(
      `/syncro/prod/ws/${WS}/dest/${DEST}/discord-webhook-url`,
    );
  });

  it("binds the name to the workspace: different workspaces never share a name", () => {
    expect(deriveDestinationParamName(WS, DEST, "/syncro/prod")).not.toBe(
      deriveDestinationParamName(WS2, DEST, "/syncro/prod"),
    );
  });

  it.each([
    ["path traversal in workspace", () => deriveDestinationParamName(`${WS}/../x`, DEST, "/syncro/prod")],
    ["sender path via destination", () => deriveDestinationParamName(WS, "../../sender/github-app-private-key", "/syncro/prod")],
    ["prefix outside /syncro", () => deriveDestinationParamName(WS, DEST, "/other/prod")],
    ["prefix with trailing slash", () => deriveDestinationParamName(WS, DEST, "/syncro/prod/")],
    ["nested prefix", () => deriveDestinationParamName(WS, DEST, "/syncro/prod/ws")],
  ])("refuses %s", (_label, build) => {
    expect(build).toThrow();
  });

  it("names the operator-created application secrets exactly", () => {
    expect(senderParamNames("/syncro/prod")).toEqual({
      githubAppPrivateKey: "/syncro/prod/sender/github-app-private-key",
      githubWebhookSecret: "/syncro/prod/sender/github-webhook-secret",
    });
    expect(dashboardParamNames("/syncro/prod")).toEqual({
      githubOAuthClientSecret: "/syncro/prod/dashboard/github-oauth-client-secret",
    });
  });
});
