/** Client-side routes. `/callback` and `/github/setup` must match the Logto and GitHub App settings exactly. */
export const PATHS = {
  home: "/",
  callback: "/callback",
  githubSetup: "/github/setup",
  onboarding: "/onboarding",
  repositories: "/repositories",
  addRepositories: "/repositories/add",
  activity: "/activity",
  destinations: "/destinations",
  account: "/account",
  privacy: "/privacy",
  terms: "/terms",
} as const;
