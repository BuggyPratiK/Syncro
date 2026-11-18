/**
 * The most recent verified repository listing, kept in memory only. It holds
 * repository names and IDs (no token) and is valid on the server for a short
 * time; after a reload the user loads it again from GitHub.
 */

import { useSyncExternalStore } from "react";
import type { RepoListingDto } from "@contracts";

let current: RepoListingDto | null = null;
const listeners = new Set<() => void>();

export function setListing(listing: RepoListingDto | null): void {
  current = listing;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Returns the stored listing while it has not expired. */
export function useListing(now: () => number = Date.now): RepoListingDto | null {
  const listing = useSyncExternalStore(subscribe, () => current);
  if (!listing) return null;
  return Date.parse(listing.expiresAt) > now() ? listing : null;
}
