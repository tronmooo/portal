import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { hashNavigate } from "@/lib/hashNavigate";

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
            <button onClick={() => window.location.reload()} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium">
              Refresh Page
            </button>
            <button onClick={() => { hashNavigate('/dashboard'); window.location.reload(); }} className="px-4 py-2 bg-muted text-foreground rounded-lg text-sm font-medium">
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
