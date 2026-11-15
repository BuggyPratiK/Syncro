/**
 * SSM destination-secret store with a fake SSM client: the writer only ever
 * puts derived destination names (standard SecureString, default key), the
 * reader only reads a pinned version after the derived-name check, failures
 * map to the right codes, and the per-container cache is keyed by version.
 */

import { GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import {
  DestinationSecretError,
  createDestinationSecretReader,
  createDestinationSecretWriter,
  type SsmSender,
} from "../../src/secrets/destination-secrets";
import { deriveDestinationParamName } from "../../src/secrets/param-names";
import { ContractError } from "../../src/contracts";
import { isDeliverableDestination } from "../../src/db/operations/tenant-destination.ops";

const WS = "ws_11111111-1111-4111-8111-111111111111";
const DEST = "8c0e6f1a-2b3c-4d5e-8f90-a1b2c3d4e5f6";
const NAME = deriveDestinationParamName(WS, DEST, "/syncro/prod");
const URL_VALUE = "https://discord.com/api/webhooks/123456789012345678/token";

function awsError(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

function fakeClient(respond: (cmd: PutParameterCommand | GetParameterCommand) => unknown) {
  const commands: Array<PutParameterCommand | GetParameterCommand> = [];
  const client: SsmSender = {
    send: jest.fn(async (cmd) => {
      commands.push(cmd);
      return respond(cmd) as never;
    }),
  };
  return { client, commands };
}

describe("destination secret writer", () => {
  it("puts a standard SecureString with no KeyId, honouring the overwrite flag", async () => {
    const { client, commands } = fakeClient(() => ({ Version: 3 }));
    const writer = createDestinationSecretWriter(client);

    await expect(writer.put(NAME, URL_VALUE, { overwrite: false })).resolves.toEqual({ version: 3 });
    await writer.put(NAME, URL_VALUE, { overwrite: true });

    expect(commands.every((c) => c instanceof PutParameterCommand)).toBe(true); // never reads
    expect(commands[0].input).toEqual({ Name: NAME, Value: URL_VALUE, Type: "SecureString", Tier: "Standard", Overwrite: false });
    expect(commands[1].input).toMatchObject({ Overwrite: true });
    expect(commands[0].input).not.toHaveProperty("KeyId");
  });

  it.each([
    "/syncro/prod/sender/github-app-private-key",
    "/syncro/prod/dashboard/github-oauth-client-secret",
    `/syncro/prod/ws/${WS}/dest/${DEST}/other`,
    `/syncro/prod/ws/${WS}/dest/../${DEST}/discord-webhook-url`,
  ])("refuses to write a non-destination name: %s", async (name) => {
    const { client } = fakeClient(() => ({ Version: 1 }));
    await expect(createDestinationSecretWriter(client).put(name, URL_VALUE, { overwrite: true })).rejects.toThrow();
    expect(client.send).not.toHaveBeenCalled();
  });

  it.each([
    ["ThrottlingException", "secret_store_busy"],
    ["AccessDeniedException", "secret_unavailable"],
    ["ParameterAlreadyExists", "secret_unavailable"],
    ["InternalServerError", "secret_unavailable"],
  ])("maps %s to %s without echoing the value", async (aws, code) => {
    const { client } = fakeClient(() => {
      throw awsError(aws);
    });
    const error = await createDestinationSecretWriter(client).put(NAME, URL_VALUE, { overwrite: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).code).toBe(code);
    expect(String((error as Error).message)).not.toContain("token");
  });
});

describe("destination secret reader", () => {
  const ok = () => ({ Parameter: { Value: URL_VALUE, Version: 2 } });

  it("reads the pinned version with decryption after the name check", async () => {
    const { client, commands } = fakeClient(ok);
    const value = await createDestinationSecretReader(client).read({ name: NAME, version: 2 }, NAME);
    expect(value).toBe(URL_VALUE);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(GetParameterCommand);
    expect(commands[0].input).toEqual({ Name: `${NAME}:2`, WithDecryption: true });
  });

  it.each([
    ["a stored name that differs from the derived one", { name: deriveDestinationParamName(WS, "9c0e6f1a-2b3c-4d5e-8f90-a1b2c3d4e5f6", "/syncro/prod"), version: 2 }, NAME],
    ["a sender parameter", { name: "/syncro/prod/sender/github-app-private-key", version: 1 }, "/syncro/prod/sender/github-app-private-key"],
    ["a non-integer version", { name: NAME, version: 1.5 }, NAME],
    ["version zero", { name: NAME, version: 0 }, NAME],
  ])("refuses %s without calling SSM", async (_label, ref, expected) => {
    const { client } = fakeClient(ok);
    await expect(createDestinationSecretReader(client).read(ref, expected)).rejects.toMatchObject({ code: "secret_unavailable" });
    expect(client.send).not.toHaveBeenCalled();
  });

  it.each([
    ["ParameterNotFound", "secret_unavailable"],
    ["ParameterVersionNotFound", "secret_unavailable"],
    ["AccessDeniedException", "secret_unavailable"],
    ["ThrottlingException", "secret_store_busy"],
  ])("maps %s to %s", async (aws, code) => {
    const { client } = fakeClient(() => {
      throw awsError(aws);
    });
    const error = await createDestinationSecretReader(client).read({ name: NAME, version: 2 }, NAME).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DestinationSecretError);
    expect((error as DestinationSecretError).code).toBe(code);
  });

  it("rejects a response for a different version (version pinning)", async () => {
    const { client } = fakeClient(() => ({ Parameter: { Value: URL_VALUE, Version: 3 } }));
    await expect(createDestinationSecretReader(client).read({ name: NAME, version: 2 }, NAME)).rejects.toMatchObject({
      code: "secret_unavailable",
    });
  });

  it("caches by name and version for 300 s; a new version is always a miss", async () => {
    let now = 1_000_000;
    const { client, commands } = fakeClient((cmd) => ({
      Parameter: { Value: URL_VALUE, Version: Number(String(cmd.input.Name).split(":").pop()) },
    }));
    const reader = createDestinationSecretReader(client, () => now);

    await reader.read({ name: NAME, version: 2 }, NAME);
    now += 299_000;
    await reader.read({ name: NAME, version: 2 }, NAME);
    expect(commands).toHaveLength(1);

    await reader.read({ name: NAME, version: 3 }, NAME); // replaced URL → miss
    expect(commands).toHaveLength(2);

    now += 2_000; // version 2 entry is now older than 300 s
    await reader.read({ name: NAME, version: 2 }, NAME);
    expect(commands).toHaveLength(3);
  });
});

describe("isDeliverableDestination", () => {
  it("only an active destination with a secret reference can receive notifications", () => {
    expect(isDeliverableDestination({ status: "active", secret_ref: { name: NAME, version: 1 } })).toBe(true);
    expect(isDeliverableDestination({ status: "pending_secret", secret_ref: undefined })).toBe(false);
    expect(isDeliverableDestination({ status: "pending_secret", secret_ref: { name: NAME, version: 1 } })).toBe(false);
    expect(isDeliverableDestination({ status: "inactive", secret_ref: { name: NAME, version: 1 } })).toBe(false);
    expect(isDeliverableDestination({ status: "active", secret_ref: undefined })).toBe(false);
    expect(isDeliverableDestination(undefined)).toBe(false);
  });
});
