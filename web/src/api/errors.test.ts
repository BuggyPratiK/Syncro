import { API_ERROR_CODES, API_ERROR_STATUS } from "@contracts";
import { describe, expect, it } from "vitest";
import { ApiError, codeForStatus, describeError, ERROR_MESSAGES, parseRetryAfter } from "./errors";

describe("error wording", () => {
  it.each(API_ERROR_CODES)("has plain wording for contract code %s", (code) => {
    const text = describeError(new ApiError(code, API_ERROR_STATUS[code]));
    expect(text).toBe(ERROR_MESSAGES[code]);
    expect(text.length).toBeGreaterThan(10);
    expect(text).not.toMatch(/[_{}]/); // no raw codes or template leftovers
  });

  it("covers exactly the contract codes plus the client-only ones", () => {
    expect(Object.keys(ERROR_MESSAGES).sort()).toEqual(
      [...API_ERROR_CODES, "network_error", "unexpected_response"].sort(),
    );
  });

  it("states the wait time for 429 when Retry-After is present", () => {
    expect(describeError(new ApiError("rate_limited", 429, { retryAfterSeconds: 17 }))).toBe(
      "Too many requests. Try again in 17 seconds.",
    );
    expect(describeError(new ApiError("rate_limited", 429, { retryAfterSeconds: 1 }))).toBe(
      "Too many requests. Try again in 1 second.",
    );
    expect(describeError(new ApiError("rate_limited", 429))).toBe(ERROR_MESSAGES.rate_limited);
  });

  it("uses the organization message required for org_not_supported", () => {
    expect(describeError(new ApiError("org_not_supported", 403))).toBe(
      "Organization installations are not supported yet.",
    );
  });

  it("never describes unknown values with their content", () => {
    expect(describeError(new Error("https://secret.example/token"))).toBe(ERROR_MESSAGES.internal_error);
  });
});

describe("status fallback", () => {
  it.each([
    [400, "invalid_request"],
    [401, "unauthenticated"],
    [403, "forbidden"],
    [404, "not_found"],
    [413, "payload_too_large"],
    [429, "rate_limited"],
    [500, "internal_error"],
    [502, "internal_error"],
    [418, "unexpected_response"],
  ] as const)("maps %i to %s", (status, code) => {
    expect(codeForStatus(status)).toBe(code);
  });
});

describe("parseRetryAfter", () => {
  it("accepts positive whole seconds only", () => {
    expect(parseRetryAfter("30")).toBe(30);
    expect(parseRetryAfter(" 5 ")).toBe(5);
    expect(parseRetryAfter("0")).toBeUndefined();
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
