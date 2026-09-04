import { lazy, type ComponentType } from "react";
import { isStaleChunkError, reloadForStaleChunk } from "@/components/ErrorBoundary";

/**
 * The chunk URL out of a failed dynamic import.
 *
 * Browsers put it in the message: "Failed to fetch dynamically imported
 * module: https://portol.me/assets/dashboard-B3kfn6HX.js". We need it because
 * a module record that failed to load is cached by its specifier — calling the
 * same `import("@/pages/dashboard")` again returns the same rejection without
 * touching the network, so a retry is only real if it asks for a different URL.
 *
 * Same-origin `/assets/*.js` only: this string comes from an error message, and
 * it is about to become a script the page executes.
 */
function chunkUrlFrom(err: unknown): string | null {
  const msg = (err as any)?.message || "";
  const found = String(msg).match(/https?:\/\/[^\s'")]+\.js/);
  if (!found) return null;
  try {
    const url = new URL(found[0]);
    if (url.origin !== window.location.origin) return null;
    if (!url.pathname.startsWith("/assets/")) return null;
    return url.href;
  } catch {
    return null;
  }
}

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
          const url = chunkUrlFrom(err);
          const busted = url ? `${url}${url.includes("?") ? "&" : "?"}retry=${Date.now()}` : null;
          const attempt = busted
            ? (import(/* @vite-ignore */ busted) as Promise<{ default: T }>)
            : factory();
          attempt.then(resolve).catch((err2) => {
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
