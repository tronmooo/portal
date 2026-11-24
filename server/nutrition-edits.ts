// ─── Corrections to food already logged ──────────────────────────────────────
//
// "Actually that was yesterday", "remove the cheese from my lunch", "the same
// breakfast as yesterday": each changes or reuses an entry that EXISTS. The
// chat model names the entry and the change; the arithmetic and the copying
// are done here, on the stored rows, so a correction never becomes a second
// entry and a repeated meal carries the same numbers and the same sources it
// had the first time.
//
// Pinned by tests/nutrition-corrections.test.ts.

import type { IStorage } from "./storage";
import {
  LINKED_SOURCE_KEY,
  applyUserProvided,
  buildEntryValuePatch,
  canonicalNutrientKey,
  overallConfidence,
  summarizeEnrichment,
  sumComponentTotals,
  ENTRY_VALUE_NUTRIENTS,
  type NutritionEnrichment,
} from "@shared/nutrition-enrichment";
import { getZonedParts, addDays, DEFAULT_TIMEZONE } from "@shared/timezone";
import { itemTextOf } from "./nutrition-enrichment";

export type Meal = "breakfast" | "lunch" | "dinner" | "snack";
const MEALS: readonly Meal[] = ["breakfast", "lunch", "dinner", "snack"];

export function mealWord(text: string | null | undefined): Meal | null {
  const t = String(text || "").toLowerCase();
  if (/\bbreakfast\b/.test(t)) return "breakfast";
  if (/\blunch\b/.test(t)) return "lunch";
  if (/\b(dinner|supper)\b/.test(t)) return "dinner";
  if (/\bsnacks?\b/.test(t)) return "snack";
  return null;
}

/** The meal an entry belongs to: the one it was logged as, else the one its local time of day falls in. */
export function mealOfEntry(entry: { values?: Record<string, any> | null; timestamp?: string | null }, timezone: string = DEFAULT_TIMEZONE): Meal {
  const v = entry.values || {};
  const stated = String(v.mealType || v.meal || "").toLowerCase().trim();
  if ((MEALS as readonly string[]).includes(stated)) return stated as Meal;
  const hour = getZonedParts(String(entry.timestamp || new Date().toISOString()), timezone).hours;
  if (hour >= 4 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 16) return "lunch";
  if (hour >= 17 && hour < 22) return "dinner";
  return "snack";
}

const localDate = (entry: { timestamp?: string | null }, timezone: string) =>
  getZonedParts(String(entry.timestamp || new Date().toISOString()), timezone).date;

const words = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !/^(the|my|that|this|of|with|and|some)$/.test(w)).map((w) => w.replace(/s$/, ""));

/** Does the entry's food (its item, or a component of it) mention every word of `name`? */
export function entryMentions(entry: { values?: Record<string, any> | null; computed?: Record<string, any> | null }, name: string): boolean {
  const want = words(name);
  if (want.length === 0) return false;
  const comps: string[] = ((entry.computed?.nutrition as NutritionEnrichment | undefined)?.components || []).map((c) => `${c.name} ${c.sourceItem || ""}`);
  const have = new Set(words(`${itemTextOf(entry.values)} ${comps.join(" ")}`));
  return want.every((w) => have.has(w));
}

/**
 * The entry a correction is about. `match` is the user's word for it: a food
 * ("protein bar") picks the most recent entry naming it; a meal ("lunch")
 * picks from the most recent day that has that meal — the entry containing
 * `containing` when one is given ("the cheese from my lunch"), else the last.
 * Entries are oldest-first, as the tracker holds them.
 */
export function findNutritionEntry<T extends { values?: Record<string, any> | null; computed?: Record<string, any> | null; timestamp?: string | null }>(
  entries: T[],
  match: string,
  opts: { timezone?: string; containing?: string } = {},
): T | undefined {
  const tz = opts.timezone || DEFAULT_TIMEZONE;
  const newestFirst = [...entries].reverse();
  const meal = mealWord(match);
  if (meal) {
    const ofMeal = newestFirst.filter((e) => mealOfEntry(e, tz) === meal);
    if (ofMeal.length === 0) return undefined;
    const day = localDate(ofMeal[0], tz);
    const sameDay = ofMeal.filter((e) => localDate(e, tz) === day);
    if (opts.containing) return sameDay.find((e) => entryMentions(e, opts.containing!)) || sameDay[0];
    return sameDay[0];
  }
  return newestFirst.find((e) => entryMentions(e, match));
}

export interface RemoveComponentResult {
  ok: boolean;
  /** The entry has no ingredient breakdown to subtract from: the caller must supply recalculated values. */
  needsValues?: boolean;
  reason?: string;
  removed?: string;
  entry?: any;
}

/**
 * Take one ingredient out of an entry and recalculate it from what is left.
 * Works on an entry whose components are on record (each with its own
 * numbers and source); the totals are re-summed, never guessed. An entry
 * saved as a single estimate has nothing to subtract, and says so.
 */
export async function removeNutritionComponent(
  storage: IStorage,
  opts: { trackerId: string; entry: any; name: string; now?: string },
): Promise<RemoveComponentResult> {
  const now = opts.now || new Date().toISOString();
  const entry = opts.entry;
  const enrichment: NutritionEnrichment | undefined = entry?.computed?.nutrition;
  const want = words(opts.name);
  if (want.length === 0) return { ok: false, reason: "no ingredient was named" };
  const comps = enrichment?.components || [];
  const hit = comps.findIndex((c) => { const have = new Set(words(`${c.name} ${c.sourceItem || ""}`)); return want.every((w) => have.has(w)); });
  if (!enrichment || comps.length < 2 || hit < 0 || enrichment.fromLabel) {
    return { ok: false, needsValues: true, reason: `This entry has no separate figures for ${opts.name}, so it cannot be subtracted exactly.` };
  }
  const removed = comps[hit];
  const components = comps.filter((_, i) => i !== hit);
  const summed = sumComponentTotals(components, now);
  // The user's own numbers described the food WITH the ingredient; they no
  // longer describe what is left, so the remaining components' figures stand.
  const { totals } = applyUserProvided(summed, {}, now);
  const next: NutritionEnrichment = {
    ...enrichment,
    components,
    totals,
    userProvided: [],
    userValues: {},
    confidence: overallConfidence(components),
    summary: summarizeEnrichment({ components, totals }),
    enrichedAt: now,
  };
  const patch: Record<string, any> = buildEntryValuePatch({}, next);
  // A nutrient only the removed ingredient carried is no longer known for the entry.
  const valuesToDelete = ENTRY_VALUE_NUTRIENTS.filter((k) => entry.values?.[k] != null && next.totals[k] == null && k !== "calories");
  const item = itemTextOf(entry.values);
  const esc = opts.name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const renamed = item
    .replace(new RegExp(`\\s*(?:,|\\+|&|and|with|plus)\\s+(?:a\\s+|some\\s+|extra\\s+)?${esc}\\b(?:\\s*\\([^)]*\\))?`, "i"), "")
    .replace(new RegExp(`^${esc}\\b(?:\\s*\\([^)]*\\))?\\s*(?:,|\\+|&|and|with|plus)\\s+`, "i"), "")
    .trim();
  const itemKey = ["item", "food", "meal", "name", "description"].find((k) => typeof entry.values?.[k] === "string" && entry.values[k].trim());
  if (itemKey && renamed && renamed !== item) patch[itemKey] = renamed.charAt(0).toUpperCase() + renamed.slice(1);
  const updated = await storage.updateTrackerEntry(opts.trackerId, entry.id, { values: patch, ...(valuesToDelete.length ? { valuesToDelete } : {}), computed: { nutrition: next } } as any);
  if (!updated) return { ok: false, reason: "the entry could not be updated" };
  return { ok: true, removed: removed.sourceItem || removed.name, entry: updated };
}

/** "yesterday", "today", "2 days ago" or a YYYY-MM-DD date → the calendar day, in the user's zone. */
export function resolveRepeatDate(raw: string | null | undefined, today: string): string | null {
  const t = String(raw || "").trim().toLowerCase();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  if (t === "today") return today;
  if (t === "yesterday") return addDays(today, -1);
  const ago = t.match(/^(\d+)\s+days?\s+ago$/);
  if (ago) return addDays(today, -Number(ago[1]));
  return null;
}

/**
 * "The same breakfast as yesterday": one log per food that was eaten then,
 * with the same item and the same numbers. Each runs as its own
 * log_tracker_entry, so each is its own entry with its own card and undo, and
 * the day it was copied from is not touched. Nothing is estimated anew.
 * Entries are the person's own, oldest first.
 */
export function repeatedMealInputs(
  input: Record<string, any>,
  entries: Array<{ values?: Record<string, any> | null; timestamp?: string | null }>,
  opts: { timezone?: string; today: string },
): { inputs: Array<Record<string, any>> } | { error: string } {
  const tz = opts.timezone || DEFAULT_TIMEZONE;
  const fromDate = resolveRepeatDate(input.repeatFrom, opts.today);
  if (!fromDate) return { error: `"${String(input.repeatFrom || "")}" is not a day I can copy from. Pass repeatFrom as "yesterday" or a YYYY-MM-DD date.` };
  const meal = mealWord(String(input.repeatMeal || ""));
  const source = entries
    .filter((e) => localDate(e, tz) === fromDate)
    .filter((e) => !meal || mealOfEntry(e, tz) === meal)
    .filter((e) => itemTextOf(e.values))
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  if (source.length === 0) return { error: `Nothing was logged for ${meal || "food"} on ${fromDate}, so there is nothing to repeat. Ask the user what they had.` };
  const { repeatFrom: _from, repeatMeal: _meal, values: _values, ...rest } = input;
  return {
    inputs: source.map((src) => {
      const values: Record<string, any> = {};
      for (const [k, v] of Object.entries(src.values || {})) if (k !== LINKED_SOURCE_KEY && !k.startsWith("_") && v != null) values[k] = v;
      if (meal && values.mealType == null) values.mealType = meal;
      return { ...rest, values, __repeatedFrom: fromDate };
    }),
  };
}
