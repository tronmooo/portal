/**
 * Sanitize API error messages before showing to users.
 * Strips internal details (table names, constraints, SQL) and returns friendly messages.
 */
export function formatApiError(err: Error | string): string {
  const msg = typeof err === "string" ? err : err.message || "Something went wrong";
  const lower = msg.toLowerCase();

  // Supabase constraint violations
  if (lower.includes("duplicate key") || lower.includes("unique constraint")) {
    return "This item already exists. Try a different name.";
  }
  if (lower.includes("foreign key") || lower.includes("violates foreign key")) {
    return "Can't complete this action — a related item is missing.";
  }
  if (lower.includes("not null") || lower.includes("null value in column")) {
    return "A required field is missing. Please fill in all fields.";
  }
  if (lower.includes("check constraint")) {
    return "Invalid value. Please check your input.";
  }

  // Auth errors
  if (lower.includes("jwt") || lower.includes("token") || lower.includes("unauthorized")) {
    return "Session expired. Please sign in again.";
  }

  // Network errors
  if (lower.includes("network") || lower.includes("fetch") || lower.includes("failed to fetch")) {
    return "Network error. Check your connection and try again.";
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "Request timed out. Try again.";
  }

  // Rate limiting
  if (lower.includes("rate limit") || lower.includes("too many requests")) {
    return "Too many requests. Please wait a moment and try again.";
  }

  // Generic server errors
  if (lower.includes("internal server error") || lower.includes("500")) {
    return "Server error. Please try again.";
  }

  // If the message is very long (likely raw SQL or stack trace), truncate
  if (msg.length > 100) {
    return "Something went wrong. Please try again.";
  }

  // Otherwise return the original (it's probably already user-friendly)
  return msg;
}
