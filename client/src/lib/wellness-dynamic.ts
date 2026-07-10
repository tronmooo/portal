// ── Dynamic wellness cards (2026-07) ─────────────────────────────────────────
// Builds ONE card per tracker the user ACTUALLY has data for — no predetermined
// metric list. Whatever they track (Weight, Blood Pressure, Sleep, or Guitar /
// Gaming / a custom metric) gets a card; anything with no entries produces
// nothing. This is the "truly dynamic based on my data, not predetermined
// things you keep track of" requirement: the Wellness tab reflects the user's
// real footprint and shows nothing they don't have.
import type { Tracker } from "@shared/schema";
import { getCanonicalGroup } from "./tracker-health";

export interface WellnessCard {
  id: string;
  name: string;
  /** Canonical group label (Health / Fitness / Nutrition / Mental / …) or the raw category. */
  group: string;
  category: string;
  /** Latest numeric value (or entry-count fallback for non-numeric trackers). */
  value: number | null;
  unit: string;
  /** Up to 14 values oldest→newest for the sparkline. */
  series: number[];
  changePct: number | null;
  direction: "up" | "down" | "flat";
  /** Whether the latest move is good/bad for THIS metric, or neutral when unknown. */
  favorable: "good" | "bad" | "neutral";
  lastLogged: string | null;
  entryCount: number;
  /** Blood-pressure style dual reading. */
  pair?: { systolic: number | null; diastolic: number | null };
  /** True when `value` is a fallback count of recent logs, not a measured value. */
  isCount?: boolean;
}

// Direction knowledge — mirrors the private trackerFavorableDirection in
// shared/tracker-insights.ts (not exported), kept tiny and local.
const LOWER_BETTER = /weight|body\s*fat|bmi|blood\s*pressure|\bbp\b|resting|cholesterol|\bldl\b|triglyceride|glucose|blood\s*sugar|a1c|stress|pain|anxiety/i;
const HIGHER_BETTER = /sleep|step|walk|water|hydrat|mood|energy|active|exercise|workout|meditat|mindful|protein|fiber|\bhdl\b|strength|distance|reps/i;

function favorableFor(name: string, category: string, changePct: number | null): "good" | "bad" | "neutral" {
  if (changePct == null || Math.abs(changePct) < 0.5) return "neutral";
  const s = `${name} ${category}`;
  const up = changePct > 0;
  if (LOWER_BETTER.test(s)) return up ? "bad" : "good";
  if (HIGHER_BETTER.test(s)) return up ? "good" : "bad";
  return "neutral";
}

const num = (v: any): number => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};

/** Primary numeric field of a tracker: an explicit isPrimary number field, else
 *  the first number field, else the first non-notes field. */
function primaryField(t: Tracker): string | null {
  const fields = (t.fields || []).filter((f: any) => f?.name && !/^_?notes$/i.test(f.name));
  const primary = fields.find((f: any) => f.isPrimary && (f.type === "number" || f.type === undefined));
  if (primary) return primary.name;
  const numeric = fields.find((f: any) => f.type === "number");
  if (numeric) return numeric.name;
  return fields[0]?.name ?? null;
}

const RECENT_MS = 14 * 86400000;

/**
 * Build the dynamic wellness cards from the user's trackers. Only trackers with
 * at least one entry produce a card. Sorted most-relevant first (recent activity,
 * then how much is logged).
 */
export function buildWellnessCards(trackers: Tracker[] | undefined): WellnessCard[] {
  const cards: WellnessCard[] = [];
  for (const t of trackers || []) {
    const entries = (t.entries || []).filter((e: any) => e && e.values && e.timestamp);
    if (entries.length === 0) continue;
    const sorted = [...entries].sort(
      (a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
    const lastLogged = sorted[0]?.timestamp ?? null;
    const category = String(t.category || "custom");
    const group = getCanonicalGroup(category) || (category ? category[0].toUpperCase() + category.slice(1) : "Other");

    // Blood-pressure style dual reading gets its own shape.
    const isBP = /blood\s*pressure|\bbp\b/i.test(t.name);
    if (isBP) {
      const latest = sorted[0].values || {};
      const sys = num(latest.systolic ?? latest.sys ?? latest.value);
      const dia = num(latest.diastolic ?? latest.dia);
      const series = sorted.slice(0, 14).reverse()
        .map((e: any) => num(e.values?.systolic ?? e.values?.sys ?? e.values?.value))
        .filter((n) => Number.isFinite(n));
      const prevSys = Number.isFinite(num(sorted[1]?.values?.systolic ?? sorted[1]?.values?.sys)) ? num(sorted[1]?.values?.systolic ?? sorted[1]?.values?.sys) : null;
      const changePct = Number.isFinite(sys) && prevSys != null && prevSys !== 0 ? ((sys - prevSys) / Math.abs(prevSys)) * 100 : null;
      cards.push({
        id: t.id, name: t.name, group, category,
        value: Number.isFinite(sys) ? sys : null, unit: t.unit || "mmHg",
        series, changePct,
        direction: changePct == null ? "flat" : changePct > 0 ? "up" : changePct < 0 ? "down" : "flat",
        favorable: favorableFor(t.name, category, changePct),
        lastLogged, entryCount: entries.length,
        pair: { systolic: Number.isFinite(sys) ? sys : null, diastolic: Number.isFinite(dia) ? dia : null },
      });
      continue;
    }

    const field = primaryField(t);
    const numsAll = field ? sorted.map((e: any) => num(e.values?.[field])) : [];
    const nums = numsAll.filter((n) => Number.isFinite(n));

    if (nums.length > 0) {
      const value = nums[0];
      const prev = nums[1];
      const changePct = prev != null && prev !== 0 ? ((value - prev) / Math.abs(prev)) * 100 : null;
      const series = nums.slice(0, 14).reverse();
      const unit = (t.fields || []).find((f: any) => f.name === field)?.unit || t.unit || "";
      cards.push({
        id: t.id, name: t.name, group, category,
        value, unit, series, changePct,
        direction: changePct == null ? "flat" : changePct > 0 ? "up" : changePct < 0 ? "down" : "flat",
        favorable: favorableFor(t.name, category, changePct),
        lastLogged, entryCount: entries.length,
      });
    } else {
      // Non-numeric tracker (e.g. a checkbox/notes habit-like tracker such as
      // "Guitar"): still dynamic — surface how often it was logged recently.
      const recentCount = sorted.filter((e: any) => Date.now() - new Date(e.timestamp).getTime() <= RECENT_MS).length;
      cards.push({
        id: t.id, name: t.name, group, category,
        value: recentCount, unit: recentCount === 1 ? "log · 14d" : "logs · 14d",
        series: [], changePct: null, direction: "flat", favorable: "neutral",
        lastLogged, entryCount: entries.length, isCount: true,
      });
    }
  }

  // Relevance sort: most recently logged first, then most-logged.
  return cards.sort((a, b) => {
    const ta = a.lastLogged ? new Date(a.lastLogged).getTime() : 0;
    const tb = b.lastLogged ? new Date(b.lastLogged).getTime() : 0;
    if (tb !== ta) return tb - ta;
    return b.entryCount - a.entryCount;
  });
}

/** Group cards by their canonical group, preserving relevance order. Only
 *  non-empty groups come back — nothing predetermined. */
export function groupWellnessCards(cards: WellnessCard[]): Array<{ group: string; cards: WellnessCard[] }> {
  const order: string[] = [];
  const map = new Map<string, WellnessCard[]>();
  for (const c of cards) {
    if (!map.has(c.group)) { map.set(c.group, []); order.push(c.group); }
    map.get(c.group)!.push(c);
  }
  return order.map((g) => ({ group: g, cards: map.get(g)! }));
}
