/**
 * Discord webhook URLs in SSM Parameter Store.
 *
 * Each destination's URL is one SecureString parameter (standard tier,
 * encrypted with the AWS-managed `aws/ssm` key: no `KeyId` is ever passed) at
 *   <prefix>/ws/<workspace_id>/dest/<destination_id>/discord-webhook-url
 * DynamoDB stores only `secret_ref {name, version}`.
 *
 * Two deliberately separate halves:
 * - the WRITER (dashboard) can only `PutParameter`; it never reads;
 * - the READER (webhook sender) can only `GetParameter` with decryption, and
 *   only for a name it derived itself and checked against the stored
 *   reference, pinned to the stored version.
 * SSM binds each ciphertext to its parameter ARN, so a stored URL is tied to
 * exactly one workspace and destination path.
 *
 * PROVISIONAL: the writer/reader interfaces may still change once the IAM
 * permission tests for both roles are in place.
 */

import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { getBaseEnv } from "../config/env";
import { SECRETS } from "../contracts/constants";
import { ContractError } from "../contracts/errors";
import { ID_PATTERNS } from "../contracts/ids";
import type { DestinationSecretReader, DestinationSecretWriter, SecretRef } from "../contracts/data-ops";
import type { SenderSecretFailure } from "../contracts/errors";
import { logger } from "../utils/logger";

/** Minimal SSM surface used here; tests pass a fake. */
export interface SsmSender {
  send(command: PutParameterCommand | GetParameterCommand): Promise<{ Version?: number; Parameter?: { Value?: string; Version?: number } }>;
}

const UUID = ID_PATTERNS.destinationId.source.slice(1, -1);
const WS = ID_PATTERNS.workspaceId.source.slice(1, -1);
/** The only parameter names either half may touch. */
const DESTINATION_PARAM = new RegExp(`^/syncro/[a-z][a-z0-9-]{0,31}/ws/${WS}/dest/${UUID}/discord-webhook-url$`);

export function isDestinationParamName(name: string): boolean {
  return DESTINATION_PARAM.test(name);
}

let defaultClient: SSMClient | undefined;
function realClient(): SsmSender {
  if (!defaultClient) defaultClient = new SSMClient({ region: getBaseEnv().AWS_REGION, maxAttempts: 2 });
  return defaultClient as unknown as SsmSender;
}

const nameOf = (error: unknown) => (error as { name?: string } | null)?.name ?? "";

// ─── Writer (dashboard) ──────────────────────────────────────────────────────

export function createDestinationSecretWriter(client: SsmSender = realClient()): DestinationSecretWriter {
  return {
    async put(name, value, { overwrite }) {
      if (!isDestinationParamName(name)) throw new Error("Refusing to write a non-destination parameter");
      try {
        const out = await client.send(
          new PutParameterCommand({ Name: name, Value: value, Type: "SecureString", Tier: "Standard", Overwrite: overwrite }),
        );
        if (!Number.isSafeInteger(out.Version) || (out.Version as number) < 1) throw new Error("No version returned");
        return { version: out.Version as number };
      } catch (error) {
        const busy = nameOf(error) === "ThrottlingException";
        logger.warn("Destination secret write failed", { parameterName: name, reason: nameOf(error) || "error" });
        throw new ContractError(busy ? "secret_store_busy" : "secret_unavailable");
      }
    },
  };
}

// ─── Reader (webhook sender) ─────────────────────────────────────────────────

/** The sender could not obtain the URL; nothing must be sent. */
export class DestinationSecretError extends Error {
  readonly code: SenderSecretFailure;
  constructor(code: SenderSecretFailure) {
    super(code);
    this.name = "DestinationSecretError";
    this.code = code;
  }
}

/**
 * Creates a reader with a per-container cache keyed by name AND version: a
 * replaced URL (new version) is always a cache miss, and an entry lives at
 * most `SECRETS.destinationUrlCacheTtlSeconds`.
 */
export function createDestinationSecretReader(
  client: SsmSender = realClient(),
  now: () => number = Date.now,
): DestinationSecretReader {
  const cache = new Map<string, { value: string; expiresAt: number }>();

  return {
    async read(ref: SecretRef, expectedName: string): Promise<string> {
      // Never trust a stored reference: it must equal the name derived from the repository's workspace.
      if (
        !ref ||
        ref.name !== expectedName ||
        !isDestinationParamName(expectedName) ||
        !Number.isSafeInteger(ref.version) ||
        ref.version < 1
      ) {
        logger.error("Destination secret reference rejected", { reason: "name_or_version_mismatch" });
        throw new DestinationSecretError("secret_unavailable");
      }

      const cacheKey = `${ref.name}:${ref.version}`;
      const hit = cache.get(cacheKey);
      if (hit && hit.expiresAt > now()) return hit.value;

      try {
        const out = await client.send(new GetParameterCommand({ Name: cacheKey, WithDecryption: true }));
        const value = out.Parameter?.Value;
        if (!value || out.Parameter?.Version !== ref.version) throw new Error("Unexpected parameter version");
        cache.set(cacheKey, { value, expiresAt: now() + SECRETS.destinationUrlCacheTtlSeconds * 1000 });
        return value;
      } catch (error) {
        const code: SenderSecretFailure = nameOf(error) === "ThrottlingException" ? "secret_store_busy" : "secret_unavailable";
        logger.error("Destination secret read failed", { parameterName: ref.name, reason: nameOf(error) || "error" });
        throw new DestinationSecretError(code);
      }
    },
  };
}
