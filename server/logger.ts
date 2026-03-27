/**
 * Structured logger — single logging interface for the entire server.
 * Outputs consistent [timestamp] [LEVEL] [category] message format.
 * Never logs raw error objects, PII, or sensitive data.
 */

type LogLevel = "info" | "warn" | "error" | "debug";

function formatTimestamp(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function log(level: LogLevel, category: string, message: string, extra?: Record<string, unknown>) {
  const ts = formatTimestamp();
  const prefix = `${ts} [${level.toUpperCase()}] [${category}]`;
  const extraStr = extra ? ` ${JSON.stringify(extra)}` : "";
  
  switch (level) {
    case "error":
      console.error(`${prefix} ${message}${extraStr}`);
      break;
    case "warn":
      console.warn(`${prefix} ${message}${extraStr}`);
      break;
    case "debug":
      if (process.env.NODE_ENV === "development") {
        console.log(`${prefix} ${message}${extraStr}`);
      }
      break;
    default:
      console.log(`${prefix} ${message}${extraStr}`);
  }
}

export const logger = {
  info: (category: string, message: string, extra?: Record<string, unknown>) => log("info", category, message, extra),
  warn: (category: string, message: string, extra?: Record<string, unknown>) => log("warn", category, message, extra),
  error: (category: string, message: string, extra?: Record<string, unknown>) => log("error", category, message, extra),
  debug: (category: string, message: string, extra?: Record<string, unknown>) => log("debug", category, message, extra),
};
