import {
  REQUEST_LIMITS,
  type DeliveryDto,
  type DestinationDto,
  type InstallationDto,
  type MeDto,
  type Page,
  type RepoDto,
} from "@contracts";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useApi } from "./api-context";
import type { PageParams } from "./types";

export const queryKeys = {
  me: ["me"] as const,
  workspace: (ws: string) => ["ws", ws] as const,
  installations: (ws: string) => ["ws", ws, "installations"] as const,
  repos: (ws: string) => ["ws", ws, "repos"] as const,
  destinations: (ws: string) => ["ws", ws, "destinations"] as const,
  deliveries: (ws: string) => ["ws", ws, "deliveries"] as const,
};

/**
 * Reads every page of a small, bounded list (repositories, destinations and
 * installations are capped per workspace). The page guard stops a server
 * that keeps returning cursors from looping forever.
 */
export async function fetchAllPages<T>(load: (page: PageParams) => Promise<Page<T>>, maxPages = 20): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await load({ limit: REQUEST_LIMITS.pageSizeMax, ...(cursor ? { cursor } : {}) });
    items.push(...page.items);
    if (!page.nextCursor) return items;
    cursor = page.nextCursor;
  }
  return items;
}

export function useMe() {
  const api = useApi();
  return useQuery<MeDto>({ queryKey: queryKeys.me, queryFn: () => api.getMe() });
}

export function useInstallations(ws: string) {
  const api = useApi();
  return useQuery<InstallationDto[]>({
    queryKey: queryKeys.installations(ws),
    queryFn: () => fetchAllPages((p) => api.listInstallations(ws, p)),
  });
}

export function useRepos(ws: string) {
  const api = useApi();
  return useQuery<RepoDto[]>({
    queryKey: queryKeys.repos(ws),
    queryFn: () => fetchAllPages((p) => api.listRepos(ws, p)),
  });
}

export function useDestinations(ws: string) {
  const api = useApi();
  return useQuery<DestinationDto[]>({
    queryKey: queryKeys.destinations(ws),
    queryFn: () => fetchAllPages((p) => api.listDestinations(ws, p)),
  });
}

export function useDeliveries(ws: string) {
  const api = useApi();
  return useInfiniteQuery<Page<DeliveryDto>, Error, { pages: Page<DeliveryDto>[] }, readonly unknown[], string | undefined>({
    queryKey: queryKeys.deliveries(ws),
    initialPageParam: undefined,
    queryFn: ({ pageParam }) =>
      api.listDeliveries(ws, { limit: REQUEST_LIMITS.pageSizeDefault, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (last) => last.nextCursor,
  });
}

/** Refreshes everything cached for a workspace after a write. */
export function useInvalidateWorkspace(ws: string) {
  const client = useQueryClient();
  return useCallback(() => client.invalidateQueries({ queryKey: queryKeys.workspace(ws) }), [client, ws]);
}
