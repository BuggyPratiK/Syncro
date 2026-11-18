/**
 * Request body handling and schema validation.
 *
 * The body size is checked on the decoded bytes before anything is parsed:
 * a base64-encoded body is measured after decoding, and an encoded body that
 * cannot fit the limit is refused without decoding it at all.
 */

import type { z } from "zod";
import { REQUEST_LIMITS } from "../contracts/constants";

export type BodyCheck =
  | { ok: true; text: string | undefined }
  | { ok: false; code: "payload_too_large" | "invalid_request" };

/** Largest base64 string that can decode to `maxBodyBytes` (with padding). */
const MAX_BASE64_LENGTH = Math.ceil(REQUEST_LIMITS.maxBodyBytes / 3) * 4;

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Decodes the body and enforces the size cap. `text` is undefined for an absent or empty body. */
export function readBody(body: string | undefined, isBase64Encoded: boolean | undefined): BodyCheck {
  if (body === undefined || body === "") return { ok: true, text: undefined };

  if (!isBase64Encoded) {
    if (Buffer.byteLength(body, "utf8") > REQUEST_LIMITS.maxBodyBytes) return { ok: false, code: "payload_too_large" };
    return { ok: true, text: body };
  }

  if (body.length > MAX_BASE64_LENGTH) return { ok: false, code: "payload_too_large" };
  const bytes = Buffer.from(body, "base64");
  if (bytes.length > REQUEST_LIMITS.maxBodyBytes) return { ok: false, code: "payload_too_large" };
  try {
    return { ok: true, text: utf8.decode(bytes) };
  } catch {
    return { ok: false, code: "invalid_request" };
  }
}

export type Validation<T> = { ok: true; data: T } | { ok: false; fields: string[] };

/**
 * Validates `input` and reports only the paths of invalid fields, never their
 * values. Unknown keys are reported as `(root)` rather than by name, so
 * caller-chosen key names are not reflected back.
 */
export function validate<S extends z.ZodTypeAny>(schema: S, input: unknown): Validation<z.infer<S>> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  const fields = new Set<string>();
  for (const issue of result.error.issues) {
    if (issue.code === "unrecognized_keys" || issue.path.length === 0) fields.add("(root)");
    else fields.add(issue.path.map(String).join("."));
  }
  return { ok: false, fields: [...fields].sort() };
}

/** Parses JSON text; `ok: false` when it is not valid JSON. */
export function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}
