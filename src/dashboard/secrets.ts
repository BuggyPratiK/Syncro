/**
 * The dashboard's only secret: the GitHub App's OAuth client secret, read from
 * SSM Parameter Store.
 *
 * Same rules as the sender's loader, applied to a separate parameter:
 * - one `GetParameter` with decryption, by exact name, on first use in a
 *   container; the result is cached for the container's lifetime, and
 *   concurrent first calls share one request;
 * - always the latest version: the name comes from the environment and must be
 *   a plain path, so a version or label selector (`name:3`) is refused. The
 *   version that was read is logged (never the value) so a rotation can be
 *   traced. A rotated secret is picked up when `SECRETS_EPOCH` changes, which
 *   replaces running containers;
 * - fail closed: a missing, unreadable or empty parameter throws
 *   `SecretUnavailableError`, and the failure is NOT cached, so the next
 *   request tries again.
 */

import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { getBaseEnv, getDashboardEnv } from "../config/env";
import { SecretUnavailableError, type SecretFailureReason } from "../config/secrets";
import { logger } from "../utils/logger";

export { SecretUnavailableError } from "../config/secrets";

export interface StoredSecret {
  value: string;
  /** SSM parameter version that was read. */
  version: number | undefined;
}

/** Reads one SecureString value with decryption. Injectable for tests. */
export type OAuthSecretReader = (name: string) => Promise<StoredSecret | undefined>;

/** A plain hierarchical parameter name: no `:version` or `:label` selector. */
const PLAIN_PARAMETER_NAME = /^(\/[A-Za-z0-9_.-]+)+$/;

let _ssm: SSMClient | undefined;

const defaultReader: OAuthSecretReader = async (name) => {
  if (!_ssm) _ssm = new SSMClient({ region: getBaseEnv().AWS_REGION, maxAttempts: 2 });
  const out = await _ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  if (out.Parameter?.Value === undefined) return undefined;
  return { value: out.Parameter.Value, version: out.Parameter.Version };
};

let reader: OAuthSecretReader = defaultReader;
let cached: Promise<string> | undefined;

function classify(error: unknown): SecretFailureReason {
  const name = (error as { name?: string } | null)?.name ?? "";
  if (name === "ParameterNotFound" || name === "ParameterVersionNotFound") return "missing";
  if (name === "AccessDeniedException") return "access_denied";
  if (name === "ThrottlingException") return "throttled";
  return "error";
}

async function load(name: string): Promise<string> {
  if (!PLAIN_PARAMETER_NAME.test(name)) {
    logger.error("OAuth client secret parameter name is not a plain path", { reason: "error" });
    throw new SecretUnavailableError("(invalid name)", "error");
  }
  let secret: StoredSecret | undefined;
  try {
    secret = await reader(name);
  } catch (error) {
    const reason = classify(error);
    logger.error("Failed to read OAuth client secret", { parameterName: name, reason });
    throw new SecretUnavailableError(name, reason);
  }
  if (!secret || secret.value.trim() === "") {
    logger.error("OAuth client secret is empty", { parameterName: name, reason: "empty" });
    throw new SecretUnavailableError(name, "empty");
  }
  logger.info("OAuth client secret loaded", { parameterName: name, version: secret.version });
  return secret.value;
}

/** Returns the GitHub OAuth client secret, loading it once per container. Throws `SecretUnavailableError`. */
export function getGitHubOAuthClientSecret(): Promise<string> {
  if (!cached) {
    // Read inside the promise so an invalid environment also fails closed and is retried.
    cached = Promise.resolve()
      .then(() => load(getDashboardEnv().GITHUB_OAUTH_CLIENT_SECRET_PARAM))
      .catch((error) => {
        cached = undefined; // never cache a failure
        throw error;
      });
  }
  return cached;
}

/** Test hook: replace the SSM reader and clear the cache. */
export function setOAuthSecretReaderForTests(testReader: OAuthSecretReader | undefined): void {
  reader = testReader ?? defaultReader;
  cached = undefined;
}
