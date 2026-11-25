import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { ORPCError } from "@orpc/client";
import { QueryClient } from "@tanstack/react-query";
import { m } from "../paraglide/messages.js";
import { createCoreConnection } from "./core-connection";

// One connection to core per page, with TanStack Query utilities on top.
// Components call procedures only through `orpc.*.queryOptions` and
// `mutationOptions` (handbook: API and agents).

export const connection = createCoreConnection(window.sondine);
export const orpc = createTanstackQueryUtils(connection.client);

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 2, refetchOnWindowFocus: false },
  },
});

// A new core has new state: refetch everything, live status included.
connection.onReconnect(() => void queryClient.invalidateQueries());

/** A short, translated message for a failed procedure call. */
export function errorMessage(error: unknown): string {
  if (error instanceof ORPCError) {
    switch (error.code) {
      case "HELPER_UNAVAILABLE":
        return m.error_helper_unavailable();
      case "HELPER_REJECTED":
        return m.error_helper_rejected();
      case "TIMEOUT":
        return m.error_timeout();
      case "NOT_FOUND":
        return m.error_not_found();
    }
  }
  return m.error_generic();
}
