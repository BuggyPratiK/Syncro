/**
 * Workspace roles. Currently every workspace has a single `owner`; `admin` and
 * `member` exist so permission checks and tests are ready for team support.
 */

export const ROLES = ["owner", "admin", "member"] as const;
export type Role = (typeof ROLES)[number];

const ROLE_RANK: Readonly<Record<Role, number>> = {
  member: 1,
  admin: 2,
  owner: 3,
};

/** True when `actual` meets or exceeds `minimum`. Unknown roles never pass. */
export function roleSatisfies(actual: unknown, minimum: Role): boolean {
  if (typeof actual !== "string" || !(actual in ROLE_RANK)) return false;
  return ROLE_RANK[actual as Role] >= ROLE_RANK[minimum];
}

/** Minimum access level for a route: `token` = any authenticated user. */
export type RouteAccess = "token" | Role;
