/** The production key set is the tenant's remote JWKS with a 3-second fetch timeout. */

jest.mock("jose", () => {
  const actual = jest.requireActual("jose");
  return { ...actual, createRemoteJWKSet: jest.fn(() => jest.fn()) };
});

import { createRemoteJWKSet } from "jose";
import { createAuthenticator } from "../../src/dashboard/auth";

it("fetches the configured JWKS URI with a 3-second timeout", () => {
  createAuthenticator({
    issuer: "https://tenant.logto.app/oidc",
    audience: "https://api.syncro.test",
    clientId: "spaclientid01",
    jwksUri: "https://tenant.logto.app/oidc/jwks",
  });
  const mocked = createRemoteJWKSet as unknown as jest.Mock;
  expect(mocked).toHaveBeenCalledTimes(1);
  const [url, options] = mocked.mock.calls[0];
  expect(String(url)).toBe("https://tenant.logto.app/oidc/jwks");
  expect(options).toEqual({ timeoutDuration: 3000 });
});
