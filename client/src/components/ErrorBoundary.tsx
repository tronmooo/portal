import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { hashNavigate } from "@/lib/hashNavigate";

// Detect "stale chunk" errors thrown when the browser has an old HTML/JS bundle
// cached and tries to lazy-import a chunk hash that no longer exists on the
// server (typical after a deploy). The fix is to hard-reload once so the
// browser picks up the new index.html + asset map.
export function isStaleChunkError(err: unknown): boolean {
  const msg = (err as any)?.message || String(err || "");
  return (
    /Importing a module script failed/i.test(msg) ||
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Loading chunk \d+ failed/i.test(msg) ||
    /ChunkLoadError/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg)
  );
}

const RELOAD_FLAG = "portol:chunk-reload-ts";
const RELOAD_COOLDOWN_MS = 30_000; // don't loop more than once per 30s

/**
 * Drop the cached app shell before reloading.
 *
 * The service worker serves navigations NetworkFirst with a 3s timeout
 * (vite.config.ts). On a slow first load — the exact condition under which a
 * deploy is most likely to have landed mid-session — that timeout fires and the
 * browser gets the PREVIOUS index.html out of "portol-shell", whose chunk
 * hashes no longer exist on the server. Reloading then re-serves the same stale
 * shell from the same cache and the import fails again, which is why users saw
 * repeated "reloaded but nothing changed" cycles rather than a single recovery.
 *
 * Deleting the shell cache (and the runtime asset cache, which may hold entries
 * a stale shell asked for) forces the reload to go to the network for the
 * document. /assets/* is content-hashed, so nothing of value is lost.
 */
async function purgeShellCaches(): Promise<void> {
  if (typeof caches === "undefined") return;
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter((k) => k === "portol-shell" || k === "portol-assets" || k.startsWith("workbox-precache"))
      .map((k) => caches.delete(k).catch(() => false)),
  );
}

export function reloadForStaleChunk(reason: string) {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_FLAG) || 0);
    if (Date.now() - last < RELOAD_COOLDOWN_MS) {
      // Already reloaded recently — don't loop; surface the error instead.
      console.warn("[stale-chunk] reload skipped (recent attempt):", reason);
      return false;
    }
    sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
    console.warn("[stale-chunk] reloading to pick up new bundle:", reason);
    // Purge first so the reload cannot be answered from the stale shell, but
    // never let a cache API failure (or a hang) strand the user on a dead page.
    const reload = () => { try { window.location.reload(); } catch { /* ignore */ } };
    void Promise.race([
      purgeShellCaches(),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]).catch(() => {}).then(reload);
    return true;
  } catch {
    try { window.location.reload(); } catch { /* ignore */ }
    return true;
  }
}

// Install global handlers ONCE so lazy-import failures thrown outside any
// React boundary (e.g. from a route Switch) still trigger the auto-reload.
let GLOBAL_HANDLERS_INSTALLED = false;
export function installStaleChunkHandlers() {
  if (GLOBAL_HANDLERS_INSTALLED || typeof window === "undefined") return;
  GLOBAL_HANDLERS_INSTALLED = true;
  window.addEventListener("error", (e) => {
    if (isStaleChunkError(e.error || e.message)) {
      e.preventDefault();
      reloadForStaleChunk("window.error");
    }
  });
  window.addEventListener("unhandledrejection", (e) => {
    if (isStaleChunkError(e.reason)) {
      e.preventDefault();
      reloadForStaleChunk("unhandledrejection");
    }
  });
}

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  /** If true, shows a compact inline error instead of full-page */
  inline?: boolean;
  /** Name of the section (for logging) */
  name?: string;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
    // Stale-chunk recovery: if the bundle the browser cached references a
    // lazy chunk that no longer exists, auto-reload once instead of showing
    // a dead-end error page. This is the single biggest cause of "the app
    // crashed when I switched tabs after a deploy".
    if (isStaleChunkError(error)) {
      reloadForStaleChunk("ErrorBoundary:" + (this.props.name || "unknown"));
      return;
    }
    // Persist the full error so we can read it after a refresh wipes
    // React's in-memory state. Helps diagnose mobile crashes where the
    // user can't easily copy the stack.
    try {
      const payload = {
        section: this.props.name || "unknown",
        message: error?.message || String(error),
        stack: error?.stack || "",
        componentStack: errorInfo?.componentStack || "",
        url: typeof window !== "undefined" ? window.location.href : "",
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
        ts: new Date().toISOString(),
      };
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("portol:lastError", JSON.stringify(payload));
      }
      // Best-effort beacon to the server so we can see it in logs.
      if (typeof fetch === "function") {
        fetch("/api/client-errors", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          credentials: "include",
          keepalive: true,
        }).catch(() => { /* swallow */ });
      }
    } catch { /* ignore */ }
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      if (this.props.inline) {
        return (
          <div className="flex items-center gap-2 p-3 rounded-lg border border-destructive/30 bg-destructive/5 text-xs text-muted-foreground">
            <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
            <span>Something went wrong loading this section.</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs ml-auto"
              onClick={() => this.setState({ hasError: false, error: undefined })}
            >
              <RefreshCw className="h-3 w-3 mr-1" /> Retry
            </Button>
          </div>
        );
      }

      return (
        <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4 px-4">
          <AlertTriangle className="h-12 w-12 text-destructive/60" />
          <h2 className="text-lg font-bold">Something went wrong</h2>
          <p className="text-sm text-muted-foreground text-center">An unexpected error occurred.</p>
          <div className="flex gap-2">
            <button
              onClick={() => {
                // Manual refresh — clear the stale-chunk cooldown so the user
                // isn't stuck if the auto-reload already fired once recently.
                try { sessionStorage.removeItem(RELOAD_FLAG); } catch { /* ignore */ }
                window.location.reload();
              }}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium"
            >
              Refresh Page
            </button>
            <button
              onClick={() => {
                try { sessionStorage.removeItem(RELOAD_FLAG); } catch { /* ignore */ }
                hashNavigate('/dashboard');
                window.location.reload();
              }}
              className="px-4 py-2 bg-muted text-foreground rounded-lg text-sm font-medium"
            >
              Go to Dashboard
            </button>
          </div>
          <details className="mt-4 max-w-md w-full" open>
            <summary className="text-xs text-muted-foreground cursor-pointer">Error Details</summary>
            <pre className="mt-2 text-xs bg-muted/50 p-3 rounded-lg overflow-x-auto whitespace-pre-wrap break-words max-h-64 overflow-y-auto">{this.state.error?.message || 'Unknown error'}{'\n\n'}{this.state.error?.stack || ''}</pre>
            <button
              type="button"
              className="mt-2 inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted/70 hover:bg-muted text-xs"
              onClick={async () => {
                const text = `${this.state.error?.message || ''}\n\n${this.state.error?.stack || ''}`;
                try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
              }}
            >
              Copy stack
            </button>
          </details>
        </div>
      );
    }

    return this.props.children;
  }
}

// Alias for backward compatibility
export const SectionErrorBoundary = ErrorBoundary;
