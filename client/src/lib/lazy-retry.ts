import { lazy, type ComponentType } from "react";
import { isStaleChunkError, reloadForStaleChunk } from "@/components/ErrorBoundary";

/**
 * `React.lazy` that survives one failed chunk fetch.
 *
 * Two different things produce "Failed to fetch dynamically imported module":
 *
 *  1. A genuinely stale bundle — a deploy replaced the hashed chunk the loaded
 *     shell points at, so the URL now 404s. Only a reload onto the new shell
 *     fixes it.
 *  2. A transient network failure — a dropped connection, a request that raced
 *     a service-worker activation, a flaky mobile link. The chunk is still
 *     there; the fetch just didn't land.
 *
 * Before this, both cases went straight to a full page reload, so an ordinary
 * network blip cost the user their page state and several seconds of reboot.
 * We now retry once — case 2 then recovers silently — and only fall back to the
 * reload when the second attempt fails too, which is the case-1 signature.
 */
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
) {
  return lazy(() =>
    factory().catch((err) => {
      if (!isStaleChunkError(err)) throw err;
      return new Promise<{ default: T }>((resolve, reject) => {
        setTimeout(() => {
          factory().then(resolve).catch((err2) => {
            // Second failure: treat it as a real stale deploy and reload onto
            // the current shell. reloadForStaleChunk rate-limits itself, so
            // this cannot become a reload loop.
            reloadForStaleChunk("lazyWithRetry");
            reject(err2);
          });
        }, 500);
      });
    }),
  );
}
