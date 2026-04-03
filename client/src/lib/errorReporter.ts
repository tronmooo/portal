/**
 * Lightweight error reporter — logs errors to the server audit log.
 * This is a simple alternative to Sentry for catching frontend crashes.
 */

let reported = new Set<string>();

export function initErrorReporter() {
  // Catch unhandled errors
  window.addEventListener("error", (event) => {
    reportError("unhandled_error", {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });

  // Catch unhandled promise rejections
  window.addEventListener("unhandledrejection", (event) => {
    reportError("unhandled_rejection", {
      message: String(event.reason?.message || event.reason || "unknown"),
      stack: event.reason?.stack?.slice(0, 500),
    });
  });
}

function reportError(type: string, details: Record<string, any>) {
  // Dedup: don't report the same error twice
  const key = `${type}:${details.message || ""}`;
  if (reported.has(key)) return;
  reported.add(key);

  // Log to console
  console.error(`[ErrorReporter] ${type}:`, details);

  // Fire-and-forget POST to audit log
  try {
    const token = sessionStorage.getItem("sb-access-token") || "";
    if (token) {
      fetch("/api/audit-log", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: "error",
          entity_type: "frontend",
          entity_name: details.message?.slice(0, 200) || type,
          details: { ...details, url: window.location.href, userAgent: navigator.userAgent },
          source: "error_reporter",
        }),
      }).catch(() => {});
    }
  } catch {
    // Never throw from the error reporter
  }
}
