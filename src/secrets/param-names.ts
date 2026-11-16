/**
 * SSM Parameter Store names for Syncro's secrets.
 *
 * Secrets are stored as SecureString parameters, encrypted with the
 * AWS-managed `aws/ssm` key. SSM binds each ciphertext to its parameter ARN,
 * and the path includes the workspace and destination IDs, so a stored URL is
 * tied to exactly one workspace and destination.
 *
 * Destination parameter names are ALWAYS derived server-side from validated
 * IDs (writes: `WorkspaceContext` + an owned destination item; reads: the repo
 * item's `workspace_id` + destination reference). They are never taken from
 * client input, and a stored `secret_ref.name` is trusted only after an
 * equality check against the derived name.
 */

import { assertId } from "../contracts/ids";

/** `/syncro/<env>`; production uses `/syncro/prod`. No trailing slash. */
export const SSM_PARAM_PREFIX_PATTERN = /^\/syncro\/[a-z][a-z0-9-]{0,31}$/;

export class InvalidParamPrefixError extends Error {
  constructor() {
    super("Invalid SSM parameter prefix");
    this.name = "InvalidParamPrefixError";
  }
}

function assertPrefix(prefix: string): string {
  if (!SSM_PARAM_PREFIX_PATTERN.test(prefix)) throw new InvalidParamPrefixError();
  return prefix;
}

/** `<prefix>/ws/<workspace_id>/dest/<destination_id>/discord-webhook-url`. */
export function deriveDestinationParamName(
  workspaceId: string,
  destinationId: string,
  prefix: string,
): string {
  return (
    `${assertPrefix(prefix)}/ws/${assertId("workspaceId", workspaceId)}` +
    `/dest/${assertId("destinationId", destinationId)}/discord-webhook-url`
  );
}

/** Secrets read only by the webhook sender; created by the operator before deployment. */
export function senderParamNames(prefix: string): {
  githubAppPrivateKey: string;
  githubWebhookSecret: string;
} {
  const p = assertPrefix(prefix);
  return {
    githubAppPrivateKey: `${p}/sender/github-app-private-key`,
    githubWebhookSecret: `${p}/sender/github-webhook-secret`,
  };
}

/** Secret read only by the dashboard API (GitHub OAuth client secret). */
export function dashboardParamNames(prefix: string): { githubOAuthClientSecret: string } {
  return { githubOAuthClientSecret: `${assertPrefix(prefix)}/dashboard/github-oauth-client-secret` };
}
