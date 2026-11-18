/**
 * Dashboard OAuth client secret loader: exact parameter, latest version,
 * per-container cache, failures never cached, fail closed, value never logged.
 */

import { resetEnvCacheForTests } from "../../src/config/env";
import {
  getGitHubOAuthClientSecret,
  SecretUnavailableError,
  setOAuthSecretReaderForTests,
  type OAuthSecretReader,
} from "../../src/dashboard/secrets";

const PARAM = "/syncro/prod/dashboard/github-oauth-client-secret";
const SECRET_VALUE = "oauth-client-secret-value-0123456789";

const DASHBOARD_ENV = {
  LOGTO_ISSUER: "https://tenant.logto.app/oidc",
  LOGTO_JWKS_URI: "https://tenant.logto.app/oidc/jwks",
  API_AUDIENCE: "https://api.syncro.test",
  LOGTO_SPA_CLIENT_ID: "spaclientid01",
  CORS_ORIGIN: "https://syncro.vercel.app",
  GITHUB_APP_CLIENT_ID: "Iv23liTestClient01",
  GITHUB_APP_SLUG: "syncro-test",
  GITHUB_OAUTH_CLIENT_SECRET_PARAM: PARAM,
};

function awsError(name: string): Error {
  const e = new Error("aws failure");
  e.name = name;
  return e;
}

describe("dashboard OAuth client secret", () => {
  const saved = { ...process.env };
  let logs: string[];

  beforeEach(() => {
    Object.assign(process.env, DASHBOARD_ENV);
    resetEnvCacheForTests();
    logs = [];
    jest.spyOn(console, "log").mockImplementation((line: string) => void logs.push(String(line)));
  });

  afterEach(() => {
    setOAuthSecretReaderForTests(undefined);
    process.env = { ...saved };
    resetEnvCacheForTests();
    jest.restoreAllMocks();
  });

  it("reads exactly its own parameter once per container and caches the value", async () => {
    const reader = jest.fn<ReturnType<OAuthSecretReader>, Parameters<OAuthSecretReader>>().mockResolvedValue({
      value: SECRET_VALUE,
      version: 3,
    });
    setOAuthSecretReaderForTests(reader);

    const [a, b] = await Promise.all([getGitHubOAuthClientSecret(), getGitHubOAuthClientSecret()]);
    const c = await getGitHubOAuthClientSecret();

    expect([a, b, c]).toEqual([SECRET_VALUE, SECRET_VALUE, SECRET_VALUE]);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledWith(PARAM);
  });

  it("asks for the latest version (no selector) and logs the version read, never the value", async () => {
    const reader = jest.fn().mockResolvedValue({ value: SECRET_VALUE, version: 7 });
    setOAuthSecretReaderForTests(reader);
    await getGitHubOAuthClientSecret();

    expect(reader.mock.calls[0][0]).not.toContain(":");
    const loaded = logs.map((l) => JSON.parse(l)).find((l) => l.message === "OAuth client secret loaded");
    expect(loaded).toMatchObject({ parameterName: PARAM, version: 7 });
    expect(logs.join("\n")).not.toContain(SECRET_VALUE);
  });

  it.each([
    ["missing", awsError("ParameterNotFound")],
    ["access_denied", awsError("AccessDeniedException")],
    ["throttled", awsError("ThrottlingException")],
    ["error", awsError("InternalServerError")],
  ])("fails closed when SSM reports %s", async (reason, error) => {
    setOAuthSecretReaderForTests(jest.fn().mockRejectedValue(error));
    await expect(getGitHubOAuthClientSecret()).rejects.toMatchObject({ name: "SecretUnavailableError", reason });
  });

  it.each([
    ["absent", undefined],
    ["empty", { value: "", version: 1 }],
    ["blank", { value: "   ", version: 1 }],
  ])("fails closed when the value is %s", async (_label, result) => {
    setOAuthSecretReaderForTests(jest.fn().mockResolvedValue(result));
    await expect(getGitHubOAuthClientSecret()).rejects.toBeInstanceOf(SecretUnavailableError);
  });

  it("does not cache a failure: the next call reads again and can succeed", async () => {
    const reader = jest
      .fn()
      .mockRejectedValueOnce(awsError("ThrottlingException"))
      .mockResolvedValueOnce({ value: SECRET_VALUE, version: 2 });
    setOAuthSecretReaderForTests(reader);

    await expect(getGitHubOAuthClientSecret()).rejects.toBeInstanceOf(SecretUnavailableError);
    await expect(getGitHubOAuthClientSecret()).resolves.toBe(SECRET_VALUE);
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it("fails closed without reading SSM when the configured name is not the dashboard's own", async () => {
    const reader = jest.fn().mockResolvedValue({ value: SECRET_VALUE, version: 1 });
    setOAuthSecretReaderForTests(reader);
    process.env.GITHUB_OAUTH_CLIENT_SECRET_PARAM = "/syncro/prod/sender/github-app-private-key";
    resetEnvCacheForTests();

    await expect(getGitHubOAuthClientSecret()).rejects.toThrow();
    expect(reader).not.toHaveBeenCalled();
  });

  it("refuses a version or label selector in the parameter name", async () => {
    const reader = jest.fn().mockResolvedValue({ value: SECRET_VALUE, version: 1 });
    setOAuthSecretReaderForTests(reader);
    process.env.GITHUB_OAUTH_CLIENT_SECRET_PARAM = `${PARAM}:1`;
    resetEnvCacheForTests();

    await expect(getGitHubOAuthClientSecret()).rejects.toThrow();
    expect(reader).not.toHaveBeenCalled();
  });

  it("never puts the value in an error or a log line", async () => {
    setOAuthSecretReaderForTests(jest.fn().mockRejectedValue(Object.assign(awsError("InternalServerError"), { message: SECRET_VALUE })));
    const error = await getGitHubOAuthClientSecret().catch((e: Error) => e);
    expect(String((error as Error).message)).not.toContain(SECRET_VALUE);
    expect(logs.join("\n")).not.toContain(SECRET_VALUE);
  });
});
