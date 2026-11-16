/**
 * Dashboard request schemas. Zod, `.strict()` everywhere:
 * - unknown keys are rejected, which includes any `workspace_id`/`workspaceId`
 *   in a body (the workspace comes only from the path + membership);
 * - booleans must be JSON booleans (string booleans are rejected);
 * - every string is bounded; IDs are format-checked.
 *
 * The 16 KB body cap is enforced by the dashboard API before JSON parsing.
 */

import { z } from "zod";
import { REQUEST_LIMITS } from "./constants";
import { ID_PATTERNS } from "./ids";

// ─── Field schemas ───────────────────────────────────────────────────────────

const githubId = z.string().regex(ID_PATTERNS.githubId);
const destinationId = z.string().regex(ID_PATTERNS.destinationId);
const listingId = z.string().regex(ID_PATTERNS.listingId);

export const fieldSchemas = {
  workspaceId: z.string().regex(ID_PATTERNS.workspaceId),
  githubId,
  destinationId,
  listingId,
  displayName: z
    .string()
    .trim()
    .min(REQUEST_LIMITS.displayNameMin)
    .max(REQUEST_LIMITS.displayNameMax),
  /**
   * Bounded here; the full Discord check (`validateDiscordWebhookUrl`) runs in
   * the destination op so the value is never echoed in a schema error.
   */
  webhookUrl: z.string().min(1).max(REQUEST_LIMITS.webhookUrlMax),
  branch: z
    .string()
    .min(REQUEST_LIMITS.branchMin)
    .max(REQUEST_LIMITS.branchMax)
    .refine((b) => b.trim() === b && !/[\u0000-\u001f\u007f]/.test(b), "invalid branch"),
  githubCode: z
    .string()
    .min(1)
    .max(REQUEST_LIMITS.githubCodeMaxLength)
    .regex(/^[A-Za-z0-9_-]+$/),
  state: z.string().regex(ID_PATTERNS.stateNonce),
  cursor: z
    .string()
    .min(1)
    .max(REQUEST_LIMITS.cursorMaxLength)
    .regex(/^[A-Za-z0-9_-]+$/),
} as const;

// ─── Path parameters ─────────────────────────────────────────────────────────

export const workspacePathSchema = z.object({ workspaceId: fieldSchemas.workspaceId }).strict();

export const repoPathSchema = z
  .object({ workspaceId: fieldSchemas.workspaceId, repoId: githubId })
  .strict();

export const destinationPathSchema = z
  .object({ workspaceId: fieldSchemas.workspaceId, destinationId })
  .strict();

// ─── Query (list routes) ─────────────────────────────────────────────────────

/** Query-string values arrive as strings; `limit` is digits only, 1–50. */
export const listQuerySchema = z
  .object({
    cursor: fieldSchemas.cursor.optional(),
    limit: z
      .string()
      .regex(/^[1-9][0-9]?$/)
      .transform(Number)
      .refine((n) => n >= REQUEST_LIMITS.pageSizeMin && n <= REQUEST_LIMITS.pageSizeMax)
      .optional(),
  })
  .strict();

// ─── Bodies ──────────────────────────────────────────────────────────────────

/** `POST /api/me/bootstrap`, `POST …/github/install-url`, `POST …/github/authorize-url`. */
export const emptyBodySchema = z.object({}).strict();

/** `POST …/github/claim` (install-flow callback values; none of them is proof). */
export const claimInstallationBodySchema = z
  .object({
    code: fieldSchemas.githubCode,
    installationId: githubId,
    state: fieldSchemas.state,
  })
  .strict();

/** `POST …/github/repo-listing` (authorize-flow callback; `installationId` chosen by the UI). */
export const repoListingBodySchema = z
  .object({
    code: fieldSchemas.githubCode,
    state: fieldSchemas.state,
    installationId: githubId,
  })
  .strict();

/** `POST …/repos`. */
export const registerRepoBodySchema = z
  .object({
    listingId,
    repoId: githubId,
    watchedBranch: fieldSchemas.branch.optional(),
    destinationId: destinationId.optional(),
  })
  .strict();

/** `PATCH …/repos/{repoId}`. `destinationId: null` clears (REMOVE, never null). */
export const updateRepoBodySchema = z
  .object({
    watchedBranch: fieldSchemas.branch.optional(),
    isActive: z.boolean().optional(),
    destinationId: destinationId.nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, "empty patch");

/** `POST …/destinations`. */
export const createDestinationBodySchema = z
  .object({
    displayName: fieldSchemas.displayName,
    webhookUrl: fieldSchemas.webhookUrl,
  })
  .strict();

/** `PATCH …/destinations/{destinationId}`. */
export const updateDestinationBodySchema = z
  .object({
    displayName: fieldSchemas.displayName.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, "empty patch");

/** `PUT …/destinations/{destinationId}/webhook` (replace URL; write-only). */
export const replaceWebhookBodySchema = z
  .object({ webhookUrl: fieldSchemas.webhookUrl })
  .strict();

export type ClaimInstallationBody = z.infer<typeof claimInstallationBodySchema>;
export type RepoListingBody = z.infer<typeof repoListingBodySchema>;
export type RegisterRepoBody = z.infer<typeof registerRepoBodySchema>;
export type UpdateRepoBody = z.infer<typeof updateRepoBodySchema>;
export type CreateDestinationBody = z.infer<typeof createDestinationBodySchema>;
export type UpdateDestinationBody = z.infer<typeof updateDestinationBodySchema>;
export type ReplaceWebhookBody = z.infer<typeof replaceWebhookBodySchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;
