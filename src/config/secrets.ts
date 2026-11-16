/**
 * Webhook-sender secrets, read from SSM Parameter Store.
 *
 * The GitHub App private key and the webhook secret are SecureString
 * parameters; only their NAMES are in the Lambda environment. Both are read
 * (with decryption) on first use in a container and cached for the container's
 * lifetime, so a warm invocation makes no SSM call.
 *
 * Fail closed: if either parameter is missing, unreadable or empty, the loader
 * throws and the caller must not process the request. A failure is NOT cached,
 * so the next invocation tries again. To pick up a rotated secret, deploy a new
 * `SECRETS_EPOCH` value, which replaces the running containers.
 */

import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { getBaseEnv, getWebhookEnv } from "./env";
import { logger } from "../utils/logger";

export interface SenderSecrets {
  githubAppPrivateKey: string;
  githubWebhookSecret: string;
}

export type SecretFailureReason = "missing" | "access_denied" | "throttled" | "empty" | "error";

export class SecretUnavailableError extends Error {
  /** Parameter names are not secret; values are never included. */
  readonly parameterName: string;
  readonly reason: SecretFailureReason;

  constructor(parameterName: string, reason: SecretFailureReason) {
    super(`Secret unavailable: ${parameterName} (${reason})`);
    this.name = "SecretUnavailableError";
    this.parameterName = parameterName;
    this.reason = reason;
  }
}

/** Reads one SecureString value with decryption. Injectable for tests. */
export type ParameterReader = (name: string) => Promise<string | undefined>;

let _ssm: SSMClient | undefined;

const defaultReader: ParameterReader = async (name) => {
  if (!_ssm) _ssm = new SSMClient({ region: getBaseEnv().AWS_REGION, maxAttempts: 2 });
  const out = await _ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  return out.Parameter?.Value;
};

let reader: ParameterReader = defaultReader;
let cached: Promise<SenderSecrets> | undefined;

function classify(error: unknown): SecretFailureReason {
  const name = (error as { name?: string } | null)?.name ?? "";
  if (name === "ParameterNotFound" || name === "ParameterVersionNotFound") return "missing";
  if (name === "AccessDeniedException") return "access_denied";
  if (name === "ThrottlingException") return "throttled";
  return "error";
}

async function readRequired(name: string): Promise<string> {
  let value: string | undefined;
  try {
    value = await reader(name);
  } catch (error) {
    const reason = classify(error);
    logger.error("Failed to read secret parameter", { parameterName: name, reason });
    throw new SecretUnavailableError(name, reason);
  }
  if (!value || value.trim() === "") {
    logger.error("Secret parameter is empty", { parameterName: name, reason: "empty" });
    throw new SecretUnavailableError(name, "empty");
  }
  return value;
}

async function loadSenderSecrets(): Promise<SenderSecrets> {
  const env = getWebhookEnv();
  const [privateKey, webhookSecret] = await Promise.all([
    readRequired(env.GITHUB_APP_PRIVATE_KEY_PARAM),
    readRequired(env.GITHUB_WEBHOOK_SECRET_PARAM),
  ]);
  return {
    // Keys stored with escaped newlines ("\n") are normalised to real PEM line breaks.
    githubAppPrivateKey: privateKey.replace(/\\n/g, "\n"),
    githubWebhookSecret: webhookSecret,
  };
}

/** Returns the sender secrets, loading them once per container. Throws `SecretUnavailableError`. */
export function getSenderSecrets(): Promise<SenderSecrets> {
  if (!cached) {
    cached = loadSenderSecrets().catch((error) => {
      cached = undefined; // never cache a failure
      throw error;
    });
  }
  return cached;
}

/** Test hook: replace the SSM reader and clear the cache. */
export function setParameterReaderForTests(testReader: ParameterReader | undefined): void {
  reader = testReader ?? defaultReader;
  cached = undefined;
}
