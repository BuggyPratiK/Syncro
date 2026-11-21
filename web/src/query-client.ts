import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api/errors";

/**
 * Reads retry transient failures only. A 4xx answer (including 429, which
 * the user is told about with its wait time) is never retried automatically.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
          return failureCount < 2;
        },
      },
    },
  });
}
