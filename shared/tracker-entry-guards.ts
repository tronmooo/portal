// ─── Tracker-entry value guards ─────────────────────────────────────────────
//
// Pure validation for the VALUES of a tracker entry, shared by every door
// that logs one. These rules lived only in the REST route handler
// (POST /api/trackers/:id/entries), so a chat- or extraction-logged entry
// could store what the UI would have rejected: a string in a numeric field
// (crashing charts on toFixed), a negative distance, a 5,000-lb weigh-in.
// One implementation; the door only decides what to do with the failure.
//
// Deliberately value-level only. Semantic interpretation (which tracker a
// name refers to, canonical activities, enrichment/estimation) is the chat
// door's own layer — these guards run AFTER a concrete tracker is known.

export interface TrackerFieldLike { name: string; type?: string }

export interface GuardFailure {
  error: string;
  field?: string;
  received?: string;
}

/**
 * Coerce values against the tracker's field schema: numeric fields accept
 * numbers or numeric strings (currency/unit suffixes stripped); anything else
 * is a failure, not a silent string write.
 */
export function coerceNumericValues(
  fields: TrackerFieldLike[] | undefined,
  values: Record<string, any>,
): GuardFailure | null {
  if (!Array.isArray(fields)) return null;
  const numericFieldNames = new Set(
    fields
      .filter((f) => f && (f.type === "number" || f.type === "integer" || f.type === "decimal"))
      .map((f) => f.name),
  );
  for (const k of Object.keys(values)) {
    if (k === "_notes" || k === "notes" || k === "timestamp" || k.startsWith("_")) continue;
    if (!numericFieldNames.has(k)) continue;
    const raw = values[k];
    if (raw == null || raw === "") continue;
    if (typeof raw === "number") {
      if (!isFinite(raw)) return { error: `"${k}" must be a number (got ${raw}).`, field: k };
      continue;
    }
    const s = String(raw).trim();
    const stripped = s.replace(/[$,\s]/g, "").replace(/[a-zA-Z\/%]+$/g, "");
    const n = parseFloat(stripped);
    if (!isFinite(n) || stripped === "" || !/\d/.test(stripped)) {
      return {
        error: `"${k}" expects a number. Received "${s}" — use a numeric value (e.g. 12.5).`,
        field: k,
        received: s,
      };
    }
    values[k] = n;
  }
  return null;
}

/** Reject an entry whose meaningful values are all empty. */
export function checkMeaningfulValues(values: Record<string, any>): GuardFailure | null {
  const meaningfulKeys = Object.keys(values).filter((k) => k !== "_notes" && k !== "notes" && k !== "timestamp" && !k.startsWith("_"));
  const hasOne = meaningfulKeys.some((k) => {
    const v = values[k];
    return v !== null && v !== undefined && v !== "" && !(typeof v === "number" && isNaN(v));
  });
  if (meaningfulKeys.length > 0 && !hasOne) {
    return { error: "At least one value is required. Cannot log an empty entry." };
  }
  return null;
}

/** Fields that can't be negative. Temperature/elevation/PnL stay unlisted. */
const NON_NEGATIVE_FIELDS = new Set(["calories", "weight", "distance", "duration", "steps", "heartRate", "bpm", "systolic", "diastolic"]);

export function checkValueSigns(values: Record<string, any>): GuardFailure | null {
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === "number" && v < 0 && NON_NEGATIVE_FIELDS.has(k)) {
      return { error: `${k} cannot be negative`, field: k };
    }
  }
  if (Object.entries(values).some(([k, v]) => !k.startsWith("_") && typeof v === "number" && isNaN(v))) {
    return { error: "All values must be valid numbers" };
  }
  return null;
}

/** Reject obviously impossible readings before they poison a history. */
export function checkSanityBounds(
  values: Record<string, any>,
  ctx: { isPetTracker?: boolean } = {},
): GuardFailure | null {
  for (const [key, val] of Object.entries(values)) {
    if (key.startsWith("_") || typeof val !== "number") continue;
    if (key === "weight") {
      if (ctx.isPetTracker && val > 500) return { error: `Pet weight ${val} lbs is unrealistic. Max: 500 lbs.`, field: key };
      if (val > 1000) return { error: `Weight ${val} lbs is unrealistic. Max: 1000 lbs.`, field: key };
    }
    if ((key === "systolic" || key === "sbp") && val > 300) return { error: `Systolic ${val} is unrealistic. Max: 300.`, field: key };
    if ((key === "diastolic" || key === "dbp") && val > 200) return { error: `Diastolic ${val} is unrealistic. Max: 200.`, field: key };
    if ((key === "heartRate" || key === "bpm" || key === "pulse") && val > 250) return { error: `Heart rate ${val} is unrealistic. Max: 250.`, field: key };
    if (key === "hours" && val > 24) return { error: `Sleep ${val} hours is impossible. Max: 24.`, field: key };
    if (key === "calories" && val > 20000) return { error: `${val} calories is unrealistic. Max: 20,000.`, field: key };
    if (val > 100000) return { error: `Value ${val} for "${key}" exceeds maximum (100,000).`, field: key };
  }
  return null;
}

/** All value guards in canonical order. Mutates `values` (numeric coercion). */
export function guardTrackerEntryValues(
  fields: TrackerFieldLike[] | undefined,
  values: Record<string, any>,
  ctx: { isPetTracker?: boolean } = {},
): GuardFailure | null {
  return (
    coerceNumericValues(fields, values)
    ?? checkMeaningfulValues(values)
    ?? checkValueSigns(values)
    ?? checkSanityBounds(values, ctx)
  );
}
