/**
 * Webhook-sender secrets loader: exact SSM names, decryption, per-container
 * cache, and fail-closed behaviour (failures are never cached and never leak
 * values).
 */

import { SSMClient } from "@aws-sdk/client-ssm";
import {
  SecretUnavailableError,
  getSenderSecrets,
  setParameterReaderForTests,
} from "../../src/config/secrets";

const KEY_PARAM = "/syncro/prod/sender/github-app-private-key";
const SECRET_PARAM = "/syncro/prod/sender/github-webhook-secret";

function awsError(name: string): Error {
  const e = new Error(`${name} from AWS`);
  e.name = name;
  return e;
}

describe("getSenderSecrets", () => {
  afterEach(() => setParameterReaderForTests(undefined));

  it("reads exactly the two sender parameters and normalises escaped PEM newlines", async () => {
    const reader = jest.fn(async (name: string) =>
      name === KEY_PARAM ? "-----BEGIN KEY-----\\nabc\\n-----END KEY-----" : "hook-secret",
    );
    setParameterReaderForTests(reader);

    const secrets = await getSenderSecrets();

    expect(reader.mock.calls.map((c) => c[0]).sort()).toEqual([KEY_PARAM, SECRET_PARAM].sort());
    expect(secrets.githubWebhookSecret).toBe("hook-secret");
    expect(secrets.githubAppPrivateKey).toBe("-----BEGIN KEY-----\nabc\n-----END KEY-----");
  });

  it("caches per container: repeated calls do not read SSM again", async () => {
    const reader = jest.fn(async () => "value");
    setParameterReaderForTests(reader);

    await getSenderSecrets();
    await getSenderSecrets();
    await getSenderSecrets();

    expect(reader).toHaveBeenCalledTimes(2); // one read per parameter
  });

  it("does not cache a failure: the next call retries", async () => {
    let fail = true;
    const reader = jest.fn(async () => {
      if (fail) throw awsError("ThrottlingException");
      return "value";
    });
    setParameterReaderForTests(reader);

    await expect(getSenderSecrets()).rejects.toBeInstanceOf(SecretUnavailableError);
    fail = false;
    await expect(getSenderSecrets()).resolves.toEqual({
      githubAppPrivateKey: "value",
      githubWebhookSecret: "value",
    });
  });

  it.each([
    ["ParameterNotFound", "missing"],
    ["AccessDeniedException", "access_denied"],
    ["ThrottlingException", "throttled"],
    ["InternalServerError", "error"],
  ])("fails closed on %s (%s)", async (awsName, reason) => {
    setParameterReaderForTests(async (name) => {
      if (name === SECRET_PARAM) throw awsError(awsName);
      return "value";
    });

    await expect(getSenderSecrets()).rejects.toMatchObject({
      name: "SecretUnavailableError",
      parameterName: SECRET_PARAM,
      reason,
    });
  });

  it.each([undefined, "", "   "])("fails closed on an empty value (%p)", async (value) => {
    setParameterReaderForTests(async (name) => (name === KEY_PARAM ? value : "value"));
    await expect(getSenderSecrets()).rejects.toMatchObject({ parameterName: KEY_PARAM, reason: "empty" });
  });

  it("never puts a secret value in the error", async () => {
    setParameterReaderForTests(async (name) => {
      if (name === KEY_PARAM) throw awsError("AccessDeniedException");
      return "super-secret-webhook-value";
    });
    const error = (await getSenderSecrets().catch((e: unknown) => e)) as Error;
    expect(String(error.message)).not.toContain("super-secret-webhook-value");
  });

  it("the default reader requests decryption of the exact parameter names", async () => {
    setParameterReaderForTests(undefined);
    const send = jest
      .spyOn(SSMClient.prototype, "send")
      .mockImplementation(async (command: unknown) => ({
        Parameter: { Value: `value-of-${(command as { input: { Name: string } }).input.Name}` },
      }) as never);

    const secrets = await getSenderSecrets();

    const inputs = send.mock.calls.map((c) => (c[0] as { input: unknown }).input);
    expect(inputs).toEqual(
      expect.arrayContaining([
        { Name: KEY_PARAM, WithDecryption: true },
        { Name: SECRET_PARAM, WithDecryption: true },
      ]),
    );
    expect(inputs).toHaveLength(2);
    expect(secrets.githubWebhookSecret).toBe(`value-of-${SECRET_PARAM}`);
    send.mockRestore();
  });
});
