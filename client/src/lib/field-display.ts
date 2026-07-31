// ── Displaying a profile field ───────────────────────────────────────────────
// A profile's `fields` is free-form JSONB. Values arrive as primitives, but
// also as nested objects (an address written by document extraction, a legacy
// AI blob) and as arrays. `String(value)` on any of those renders the literal
// text "[object Object]" — which is what the Info tab was showing for ADDRESS.
//
// This lives here rather than in one page because profile-detail and
// profile-info both render the same values and were drifting: detail had the
// safe stringifier, info did not.

export function formatFieldKey(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim();
}

/**
 * A short, readable preview of a value `stringifyField` cannot render — an
 * empty object, an array of objects, a blob whose leaves are all nested.
 *
 * This exists so such a field stays VISIBLE. Hiding it looks tidier and is
 * worse: the row is also where the delete button lives, so a hidden field is
 * one the user can neither read nor remove, and it sits in the database
 * forever. Showing "{ geo: … }" is honest and keeps the X reachable.
 */
export function previewUnrenderable(value: any): string {
  try {
    const json = JSON.stringify(value);
    if (!json || json === "{}" || json === "[]") return "(empty)";
    return json.length > 44 ? json.slice(0, 43) + "…" : json;
  } catch {
    return "(unreadable)";
  }
}

/** Render any profile field value as text. Never returns "[object Object]". */
export function stringifyField(value: any): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    return value.map((v) => stringifyField(v)).filter(Boolean).join(", ");
  }
  if (typeof value === "object") {
    // A wrapper like { value: "M" } or { name: "Progressive" } — unwrap it.
    for (const k of ["value", "name", "label", "display", "text", "title"]) {
      if (value[k] !== undefined && (typeof value[k] === "string" || typeof value[k] === "number")) {
        return String(value[k]);
      }
    }
    // A real composite (an address). Prefer the pieces that read as one line,
    // in postal order, before falling back to labelling whatever is there.
    const ADDRESS_ORDER = ["street", "street1", "line1", "address1", "address", "unit", "apt", "city", "state", "region", "zip", "postalCode", "zipCode", "country"];
    const addressParts = ADDRESS_ORDER
      .map((k) => value[k])
      .filter((v) => typeof v === "string" || typeof v === "number")
      .map((v) => String(v).trim())
      .filter(Boolean);
    if (addressParts.length >= 2) return addressParts.join(", ");

    const entries = Object.entries(value)
      .filter(([, v]) => v !== null && v !== undefined && v !== "" && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"))
      .slice(0, 3)
      .map(([k, v]) => `${formatFieldKey(k)}: ${v}`);
    if (entries.length) return entries.join(", ");
    return "";
  }
  try { return String(value); } catch { return ""; }
}
