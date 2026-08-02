// shared/strength-entry.ts
// =============================================================================
// THE single place that understands a strength/lift entry — including per-set
// values like weight "70/80/80" and reps "10/8/6".
// =============================================================================
//
// WHY THIS FILE EXISTS
// A lift is logged per set ("70s×10, 80s×8, 80s×6"), so the AI chat routinely
// wrote a SLASH LIST into fields the rest of the app expects to be numeric:
//
//   { sets: 3, reps: "10/8/6", weight: "70/80/80", totalVolume: 2100 }
//
// Nothing downstream could read those strings, which produced the 2026-08-02
// bug report: the Incline Dumbbell Press card read "3 lbs" and Shoulder Press
// read "2 lbs". The card's lift branch did
//
//   pickNum(values, "weight", "lbs", primaryField, "value")
//
// — "weight" was the unreadable "70/80/80", so it fell through to primaryField,
// which (because weight had been auto-created as a TEXT field) was `sets`. It
// then stamped the hardcoded "lbs" onto that number: the SET COUNT rendered as
// pounds. Two independent faults, one symptom:
//
//   1. per-set lists were unreadable, so every numeric read of a lift failed
//   2. a fallback number was labeled with a unit it never belonged to
//
// THE RULE
// Every surface that needs the weight / reps / sets / volume of a lift entry —
// tracker card, history row, chart, AI enrichment, entry normalizer — reads it
// through readStrengthEntry() and NOWHERE else. A number and the unit it is
// displayed with must come from the SAME field: `weightKey` is returned so
// callers resolve the unit for the field the number actually came from (via
// resolveTrackerUnit) instead of guessing "lbs".
//
// Pure + unit-tested (tests/strength-entry.test.ts).
// =============================================================================

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Field names that hold a LOAD (what was lifted). Never a count. */
const WEIGHT_NAME = /^(weight|weights|weightlbs|weightlb|weightkg|weightkgs|bodyweight|load|loadlbs|lb|lbs|kg|kgs|pound|pounds|kilogram|kilograms)$/;
/** Field names that hold a REP count. */
const REPS_NAME = /^(rep|reps|repetition|repetitions|repcount|repscompleted)$/;
/** Field names that hold a SET count. */
const SETS_NAME = /^(set|sets|setcount|setscompleted)$/;

export function isWeightFieldName(key: string): boolean { return WEIGHT_NAME.test(norm(key)); }
export function isRepsFieldName(key: string): boolean { return REPS_NAME.test(norm(key)); }
export function isSetsFieldName(key: string): boolean { return SETS_NAME.test(norm(key)); }

// Preference order when an entry carries more than one weight-ish key (the
// same workout logged as `weight` on one day and `weightLbs` on another).
const WEIGHT_KEY_PREFERENCE = ["weight", "weightlbs", "weightlb", "loadlbs", "load", "lbs", "lb", "pounds", "weightkg", "kgs", "kg", "bodyweight"];

function preferenceRank(key: string, order: string[]): number {
  const i = order.indexOf(norm(key));
  return i === -1 ? order.length : i;
}

/** Strict numeric read — "70/80/80" is NOT 70 (parseFloat would say it is). */
function strictNumber(v: unknown): number | null {
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  const m = s.match(/^([-+]?\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return isFinite(n) ? n : null;
}

/**
 * Parse a per-set list: "70/80/80" → [70, 80, 80]. Also accepts commas and a
 * unit suffix per entry ("70lb/80lb"). Returns null unless EVERY part is a
 * number and there are at least two of them.
 *
 * CAUTION: "120/80" parses as [120, 80]. This is only ever safe to call on
 * fields already known to be a lift's weight/reps — never on a blood-pressure
 * value. Callers in this module gate on isWeightFieldName/isRepsFieldName.
 */
export function parseSetList(raw: unknown): number[] | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || !/[/,]/.test(s)) return null;
  const parts = s.split(/[/,]/).map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const m = p.match(/^(\d+(?:\.\d+)?)\s*(?:lbs?|kgs?|pounds?|kilograms?|reps?|x)?$/i);
    if (!m) return null;
    const n = Number(m[1]);
    if (!isFinite(n)) return null;
    nums.push(n);
  }
  return nums;
}

/** [70, 80, 80] → "70/80/80" (the shape the user typed it in). */
export function formatSetList(list: number[]): string {
  return list.map((n) => String(Math.round(n * 100) / 100)).join("/");
}

export interface StrengthReading {
  /** Heaviest set's load, or the single load logged. null when none exists. */
  weight: number | null;
  /** The KEY the weight came from ("weight", "weightLbs", …) so the caller can
   *  resolve that field's unit instead of assuming pounds. */
  weightKey: string | null;
  /** Every set's load when logged per set, else null. */
  weightPerSet: number[] | null;
  /** Reps of the heaviest set (paired by index when both lists align). */
  reps: number | null;
  repsKey: string | null;
  repsPerSet: number[] | null;
  /** Sets logged, or the length of a per-set list when not stated. */
  sets: number | null;
  /** Explicit totalVolume, else Σ(weightᵢ × repsᵢ), else weight × reps × sets. */
  totalVolume: number | null;
}

const EMPTY_READING: StrengthReading = {
  weight: null, weightKey: null, weightPerSet: null,
  reps: null, repsKey: null, repsPerSet: null,
  sets: null, totalVolume: null,
};

function pickKey(values: Record<string, any>, matches: (k: string) => boolean, order: string[]): string | null {
  const keys = Object.keys(values || {}).filter((k) => !k.startsWith("_") && matches(k) &&
    values[k] != null && values[k] !== "");
  if (keys.length === 0) return null;
  return keys.sort((a, b) => preferenceRank(a, order) - preferenceRank(b, order))[0];
}

/**
 * Read a lift entry's numbers, whatever shape they were logged in.
 *
 *   { sets: 3, reps: "10/8/6", weight: "70/80/80" }
 *     → weight 80 (top set), reps 8 (that set's reps), sets 3, volume 2100
 *   { sets: 3, reps: 10, weightLbs: 50 }
 *     → weight 50 from key "weightLbs", reps 10, sets 3, volume 1500
 */
export function readStrengthEntry(values: Record<string, any> | null | undefined): StrengthReading {
  if (!values || typeof values !== "object") return { ...EMPTY_READING };

  const weightKey = pickKey(values, isWeightFieldName, WEIGHT_KEY_PREFERENCE);
  const repsKey = pickKey(values, isRepsFieldName, ["reps", "rep", "repetitions", "repcount"]);
  const setsKey = pickKey(values, isSetsFieldName, ["sets", "set", "setcount"]);

  // Per-set values live in one of two shapes, and both must read the same:
  //   raw from the model   → weight: "70/80/80"
  //   normalized/stored    → weight: 80, weightPerSet: "70/80/80"
  const perSetOf = (key: string | null): number[] | null => {
    if (!key) return null;
    const inField = parseSetList(values[key]);
    if (inField) return inField;
    const companion = Object.keys(values).find((k) => norm(k) === norm(`${key}PerSet`));
    return companion ? parseSetList(values[companion]) : null;
  };
  const weightPerSet = perSetOf(weightKey);
  const repsPerSet = perSetOf(repsKey);

  // Top set = the heaviest one. Reps pair by index when both lists align, so
  // "80 lbs × 8" reports the reps actually done at that load.
  let topIndex = 0;
  if (weightPerSet) {
    for (let i = 1; i < weightPerSet.length; i++) if (weightPerSet[i] > weightPerSet[topIndex]) topIndex = i;
  }

  const weight = weightPerSet ? weightPerSet[topIndex] : (weightKey ? strictNumber(values[weightKey]) : null);
  const reps = repsPerSet
    ? (weightPerSet && weightPerSet.length === repsPerSet.length ? repsPerSet[topIndex] : Math.max(...repsPerSet))
    : (repsKey ? strictNumber(values[repsKey]) : null);

  const statedSets = setsKey ? strictNumber(values[setsKey]) : null;
  const sets = statedSets ?? (weightPerSet?.length ?? repsPerSet?.length ?? null);

  const explicitVolume = strictNumber(values.totalVolume) ?? strictNumber(values.volume);
  let totalVolume = explicitVolume;
  if (totalVolume == null) {
    if (weightPerSet && repsPerSet && weightPerSet.length === repsPerSet.length) {
      // Exact: every set's load × that set's reps.
      totalVolume = weightPerSet.reduce((sum, w, i) => sum + w * repsPerSet[i], 0);
    } else if (weight != null && weight > 0 && reps != null && reps > 0) {
      totalVolume = weight * reps * (sets ?? 1);
    }
  }
  if (totalVolume != null) totalVolume = Math.round(totalVolume * 100) / 100;

  return { weight, weightKey, weightPerSet, reps, repsKey, repsPerSet, sets, totalVolume };
}

/** Does this entry look like a lift (a load and/or reps/sets)? */
export function isStrengthShaped(values: Record<string, any> | null | undefined): boolean {
  if (!values || typeof values !== "object") return false;
  const keys = Object.keys(values).filter((k) => !k.startsWith("_") && values[k] != null && values[k] !== "");
  const hasWeight = keys.some(isWeightFieldName);
  const hasCount = keys.some((k) => isRepsFieldName(k) || isSetsFieldName(k));
  return hasWeight && hasCount;
}

/**
 * Turn per-set LISTS into storable numbers WITHOUT losing the per-set detail:
 *
 *   { sets: 3, reps: "10/8/6", weight: "70/80/80" }
 *     → { sets: 3, reps: 8, repsPerSet: "10/8/6", weight: 80, weightPerSet: "70/80/80" }
 *
 * A numeric field never keeps a string, so charts, stats, trends and units all
 * work — and the exact sets the user did are still on the entry. Used by the
 * entry normalizer, so chat, document extraction, and any future ingestor all
 * store the same shape no matter what the model emitted.
 */
export function expandStrengthSetLists(
  raw: Record<string, any> | null | undefined,
): { values: Record<string, any>; warnings: string[] } {
  const values = { ...(raw || {}) };
  const warnings: string[] = [];
  if (!isStrengthShaped(values)) return { values, warnings };

  const r = readStrengthEntry(values);
  if (!r.weightPerSet && !r.repsPerSet) return { values, warnings };

  // Idempotent: only a field still HOLDING a list needs rewriting. An entry
  // already healed (weight 80 + weightPerSet "70/80/80") reads the same and is
  // left byte-identical, so re-running the backfill is a no-op.
  const holdsList = (key: string | null) => !!key && typeof values[key] === "string" && parseSetList(values[key]) != null;
  if (!holdsList(r.weightKey) && !holdsList(r.repsKey)) return { values, warnings };

  if (r.weightKey && holdsList(r.weightKey) && r.weightPerSet && r.weight != null) {
    const detailKey = `${r.weightKey}PerSet`;
    if (values[detailKey] == null || values[detailKey] === "") values[detailKey] = formatSetList(r.weightPerSet);
    values[r.weightKey] = r.weight;
    warnings.push(`Per-set ${r.weightKey} "${formatSetList(r.weightPerSet)}" → top set ${r.weight} (detail kept in ${detailKey})`);
  }
  if (r.repsKey && holdsList(r.repsKey) && r.repsPerSet && r.reps != null) {
    const detailKey = `${r.repsKey}PerSet`;
    if (values[detailKey] == null || values[detailKey] === "") values[detailKey] = formatSetList(r.repsPerSet);
    values[r.repsKey] = r.reps;
    warnings.push(`Per-set ${r.repsKey} "${formatSetList(r.repsPerSet)}" → top set ${r.reps} (detail kept in ${detailKey})`);
  }
  // Volume is arithmetic on the sets the user did, so a per-set list is the
  // final word on it. The chat computed its own totalVolume and got it wrong
  // (2026-08-02: it stored 2100 for 70×10 + 80×8 + 80×6, which is 1820), and a
  // wrong total is worse than none — recompute from the sets themselves.
  if (r.weightPerSet && r.repsPerSet && r.weightPerSet.length === r.repsPerSet.length) {
    const exact = Math.round(r.weightPerSet.reduce((sum, w, i) => sum + w * r.repsPerSet![i], 0) * 100) / 100;
    const stated = strictNumber(values.totalVolume);
    if (stated !== exact) {
      warnings.push(stated == null
        ? `Computed totalVolume ${exact} from the per-set values`
        : `Corrected totalVolume ${stated} → ${exact} (Σ of each set's weight × reps)`);
      values.totalVolume = exact;
    }
  }

  // "70/80/80" states the set count implicitly — don't lose it.
  const setsKey = Object.keys(values).find(isSetsFieldName);
  if (r.sets != null && (setsKey == null || strictNumber(values[setsKey]) == null)) {
    values[setsKey || "sets"] = r.sets;
    warnings.push(`Derived sets=${r.sets} from the per-set list`);
  }
  return { values, warnings };
}
