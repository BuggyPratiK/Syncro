/**
 * Utility functions for serializing and deserializing DynamoDB LastEvaluatedKey pagination tokens.
 */

export function encodeNextToken(lastEvaluatedKey?: Record<string, unknown>): string | undefined {
  if (!lastEvaluatedKey || Object.keys(lastEvaluatedKey).length === 0) {
    return undefined;
  }
  return Buffer.from(JSON.stringify(lastEvaluatedKey), "utf8").toString("base64url");
}

export function decodeNextToken(token?: string): Record<string, unknown> | undefined {
  if (!token || typeof token !== "string") {
    return undefined;
  }
  try {
    const jsonStr = Buffer.from(token, "base64url").toString("utf8");
    const parsed = JSON.parse(jsonStr);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    // If invalid token, return undefined
  }
  return undefined;
}
