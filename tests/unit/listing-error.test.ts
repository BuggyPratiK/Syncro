/**
 * Public mapping of an oversized repository listing: the contract error code
 * `listing_too_large` with HTTP 422, in the standard `{ "error": code }`
 * envelope, without exposing the repository count.
 */

import { ListingTooLargeError, MAX_LISTING_REPOS } from "../../src/db/operations/listing.ops";
import { API_ERROR_STATUS, ContractError, type ApiErrorBody } from "../../src/contracts";

/** The contract's documented mapping from a ContractError to an HTTP response. */
function toHttp(error: ContractError): { status: number; body: ApiErrorBody } {
  return { status: API_ERROR_STATUS[error.code], body: { error: error.code } };
}

describe("ListingTooLargeError", () => {
  const error = new ListingTooLargeError(MAX_LISTING_REPOS + 1);

  it("is a contract error with the public code listing_too_large and status 422", () => {
    expect(error).toBeInstanceOf(ContractError);
    expect(error.code).toBe("listing_too_large");
    expect(error.status).toBe(422);
    expect(toHttp(error)).toEqual({ status: 422, body: { error: "listing_too_large" } });
  });

  it("keeps the repository count internal", () => {
    expect(error.repoCount).toBe(1001);
    expect(error.message).toBe("listing_too_large");
    expect(JSON.stringify(toHttp(error))).not.toContain("1001");
    expect(JSON.stringify(toHttp(error))).not.toContain("repoCount");
  });
});
