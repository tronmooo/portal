// shared/exec-widgets.ts — cards the user builds for their own Executive tab.
//
// Owner request 2026-11-22: "develop AI and stuff for own customizations of
// what you wanna follow and keep track of — can do journal entries, etc.,
// anything." A custom widget is a small, typed description of WHAT to show
// (a source, a filter, how many rows); the dashboard renders it from the same
// records every other screen reads. Nothing is copied or stored per widget, so
// a widget can never disagree with the record it lists (Rule 1).
//
// A widget is made three ways, all producing the same shape:
//   - a Widget Idea (WIDGET_TEMPLATES): one tap;
//   - the AI Builder: a sentence, turned into a widget by the model
//     (server/exec-widget-builder.ts) and validated here (`sanitizeWidget`);
//   - with no model available, `inferWidgetFromText` — the same sentence read
//     by fixed rules, so the builder always answers.
//
// Pure and deterministic. Pinned by tests/exec-widgets.test.ts.

import { resolveAssetValue } from "./asset-value";
import { routeForEntity } from "./entity-routes";

export const WIDGET_SOURCES = ["profiles", "trackers", "expenses", "journal", "notes", "tasks", "goals", "habits"] as const;
export type WidgetSource = (typeof WIDGET_SOURCES)[number];

export const WIDGET_ICONS = ["car", "dumbbell", "paw", "home", "chart", "book", "note", "check", "target", "flame", "star", "heart", "wallet", "users"] as const;
export type WidgetIcon = (typeof WIDGET_ICONS)[number];

export const WIDGET_SOURCE_LABELS: Record<WidgetSource, string> = {
  profiles: "People, pets, vehicles, property and other records",
  trackers: "Trackers and their latest readings",
  expenses: "Spending",
  journal: "Journal entries",
  notes: "Notes",
  tasks: "Tasks",
  goals: "Goals",
  habits: "Habits",
};

/** Profile kinds a `profiles` widget can be narrowed to. */
export const WIDGET_PROFILE_TYPES = ["person", "pet", "vehicle", "property", "account", "investment", "asset", "medical", "subscription", "loan", "liability"] as const;

export interface ExecWidget {
  /** Stable id; the card's id on the dashboard is `w:<id>`. */
  id: string;
  title: string;
  icon: WidgetIcon;
  source: WidgetSource;
  /** `profiles` only: which kinds of record. Empty = every kind. */
  types?: string[];
  /** Keep rows whose name / title / category / text contains this (case-insensitive). */
  match?: string;
  /** `expenses`, `journal`, `notes`: how many days back. Expenses default to this calendar month. */
  days?: number;
  /** Rows shown on the card (1–8). */
  limit: number;
}

const DEFAULT_LIMIT = 4;
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** A widget as stored or as a model proposed it → a valid widget, or null. */
export function sanitizeWidget(raw: unknown, fallbackId?: string): ExecWidget | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const source = String(r.source ?? "") as WidgetSource;
  if (!(WIDGET_SOURCES as readonly string[]).includes(source)) return null;
  const title = clip(r.title, 40);
  if (title.length < 2) return null;
  const id = clip(r.id, 40).replace(/[^a-zA-Z0-9_-]/g, "") || fallbackId || "";
  if (!id) return null;
  const icon = (WIDGET_ICONS as readonly string[]).includes(String(r.icon)) ? (r.icon as WidgetIcon) : defaultIconFor(source);
  const types = source === "profiles" && Array.isArray(r.types)
    ? Array.from(new Set(r.types.map(String).filter((t) => (WIDGET_PROFILE_TYPES as readonly string[]).includes(t))))
    : [];
  const match = clip(r.match, 40);
  const days = Number(r.days);
  const limit = Number(r.limit);
  return {
    id, title, icon, source,
    ...(types.length ? { types } : {}),
    ...(match ? { match } : {}),
    ...(Number.isFinite(days) && days >= 1 ? { days: Math.min(366, Math.round(days)) } : {}),
    limit: Number.isFinite(limit) ? Math.min(8, Math.max(1, Math.round(limit))) : DEFAULT_LIMIT,
  };
}

function defaultIconFor(source: WidgetSource): WidgetIcon {
  return ({ profiles: "users", trackers: "chart", expenses: "wallet", journal: "book", notes: "note", tasks: "check", goals: "target", habits: "flame" } as const)[source];
}

/** A fresh id for a widget the user is adding. */
export function newWidgetId(existing: readonly ExecWidget[], seed: string): string {
  const base = clip(seed, 24).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "widget";
  let id = base;
  for (let n = 2; existing.some((w) => w.id === id); n++) id = `${base}-${n}`;
  return id;
}

// ── Widget Ideas ─────────────────────────────────────────────────────────────

export interface WidgetTemplate {
  key: string;
  /** Two-line chip label, as in the owner's design. */
  label: [string, string];
  widget: Omit<ExecWidget, "id">;
}

export const WIDGET_TEMPLATES: readonly WidgetTemplate[] = [
  { key: "vehicles", label: ["Vehicle", "Overview"], widget: { title: "Vehicle Overview", icon: "car", source: "profiles", types: ["vehicle"], limit: 4 } },
  { key: "fitness", label: ["Fitness", "Summary"], widget: { title: "Fitness Summary", icon: "dumbbell", source: "trackers", match: "fitness", limit: 4 } },
  { key: "pets", label: ["Pet Care", "Tracker"], widget: { title: "Pet Care Tracker", icon: "paw", source: "profiles", types: ["pet"], limit: 4 } },
  { key: "home", label: ["Home &", "Property"], widget: { title: "Home & Property", icon: "home", source: "profiles", types: ["property"], limit: 4 } },
  { key: "spending", label: ["Spending", "This Month"], widget: { title: "Spending This Month", icon: "chart", source: "expenses", limit: 5 } },
  { key: "journal", label: ["Recent", "Journal"], widget: { title: "Recent Journal", icon: "book", source: "journal", limit: 3 } },
];

// ── A sentence → a widget, by fixed rules ────────────────────────────────────

const RULES: Array<{ re: RegExp; widget: Omit<ExecWidget, "id" | "title" | "limit"> }> = [
  { re: /\bjournal|diary|mood|how i (?:felt|feel)\b/i, widget: { icon: "book", source: "journal" } },
  { re: /\bnotes?\b|memo/i, widget: { icon: "note", source: "notes" } },
  { re: /\bspend|spent|expens|purchas|bought|groceries|grocery|dining|restaurant|budget\b/i, widget: { icon: "wallet", source: "expenses" } },
  { re: /\b(?:cars?|vehicles?|trucks?|motorcycles?)\b/i, widget: { icon: "car", source: "profiles", types: ["vehicle"] } },
  { re: /\b(?:pets?|dogs?|cats?|puppy|kitten)\b/i, widget: { icon: "paw", source: "profiles", types: ["pet"] } },
  { re: /\b(?:home|house|property|properties|apartment|condo|real estate)\b/i, widget: { icon: "home", source: "profiles", types: ["property"] } },
  { re: /\b(?:family|people|kids?|children|contacts?)\b/i, widget: { icon: "users", source: "profiles", types: ["person"] } },
  { re: /\b(?:accounts?|savings|checking|investments?|portfolio|stocks?)\b/i, widget: { icon: "wallet", source: "profiles", types: ["account", "investment"] } },
  { re: /\bgoals?|targets?\b/i, widget: { icon: "target", source: "goals" } },
  { re: /\bhabits?|streaks?|routine\b/i, widget: { icon: "flame", source: "habits" } },
  { re: /\b(?:tasks?|to-?dos?|chores?|errands?)\b/i, widget: { icon: "check", source: "tasks" } },
  { re: /\b(?:fitness|workouts?|exercise|running|runs?|gym|steps|lifting|cardio)\b/i, widget: { icon: "dumbbell", source: "trackers", match: "fitness" } },
  { re: /\b(?:sleep|weight|blood pressure|heart rate|glucose|health|medication|meds?|water|hydration|calories|trackers?|track|log)\b/i, widget: { icon: "heart", source: "trackers" } },
];

/** Words that say what kind of card it is, not what to look for. */
const FILLER = /\b(?:show|me|my|a|an|the|of|for|on|in|to|and|with|all|card|widget|dashboard|track|tracking|tracker|trackers|keep|follow|following|recent|latest|last|this|month|week|overview|summary|list|entries|entry|want|would|like|please|i|see|view|about|how|much|many|what|is|are|am|spent|spend|spending|expenses?|journal|notes?|tasks?|goals?|habits?|log|logs|logged)\b/gi;

/**
 * Read a request ("my dog's vet visits", "spending on groceries", "journal
 * entries about work") into a widget. Deterministic: the AI builder's answer
 * when no model is reachable, and the shape the model's answer is held to.
 */
export function inferWidgetFromText(text: string, id = "widget"): ExecWidget {
  const said = clip(text, 200);
  const rule = RULES.find((r) => r.re.test(said));
  const base = rule?.widget ?? { icon: "star" as WidgetIcon, source: "profiles" as WidgetSource };
  // What is left after the words that only named the source is the filter:
  // "spending on groceries" → groceries; "journal entries about work" → work.
  let match = "";
  if (base.source !== "profiles") {
    const rest = said.replace(FILLER, " ").replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
    // A tracker request keeps its subject as the filter ("sleep"); a fitness
    // one already carries its own.
    match = base.match ?? (rest.split(" ").filter((w) => w.length > 2).slice(0, 2).join(" "));
    if (base.source === "trackers" && !base.match && !match) match = "";
  }
  const title = clip(said.replace(/^(?:show me|i want(?: to see)?|track|keep track of|follow)\s+/i, "").replace(/^(?:my|the|a|an)\s+/i, ""), 40)
    .replace(/^./, (c) => c.toUpperCase()) || "My widget";
  return sanitizeWidget({ ...base, id, title, ...(match ? { match } : {}), limit: DEFAULT_LIMIT }, id)!;
}

// ── Rows ─────────────────────────────────────────────────────────────────────

export interface WidgetData {
  profiles?: any[]; trackers?: any[]; expenses?: any[]; journal?: any[];
  notes?: any[]; tasks?: any[]; goals?: any[]; habits?: any[];
}

export interface WidgetRow {
  key: string;
  title: string;
  /** Second line: what kind of thing, when, where. */
  sub?: string;
  /** Right-aligned figure: a value, an amount, a date. */
  right?: string;
  /** Where the row's record lives (app route). */
  href?: string;
}

export interface WidgetView {
  /** A headline figure ("$642 this month"), when the source has one. */
  headline?: { label: string; value: string };
  rows: WidgetRow[];
  /** How many rows matched before the limit. */
  total: number;
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const DAY = /^\d{4}-\d{2}-\d{2}/;
const shortDay = (iso: unknown) => {
  const s = String(iso ?? "").slice(0, 10);
  if (!DAY.test(s)) return "";
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};
const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
};
const has = (hay: unknown[], needle: string) => !needle || hay.some((h) => String(h ?? "").toLowerCase().includes(needle));

/** Which lists a widget reads — so the card fetches only those. */
export function widgetNeeds(w: ExecWidget): Array<keyof WidgetData> {
  return w.source === "profiles" ? ["profiles", "tasks"] : [w.source];
}

/**
 * What the card shows. `data` holds whatever lists have loaded; a list that is
 * absent yields no rows (the card shows its loading or error state for it —
 * this function never invents an empty account, Rule 7).
 */
export function buildWidgetView(w: ExecWidget, data: WidgetData, todayISO: string): WidgetView {
  const today = String(todayISO).slice(0, 10);
  const needle = String(w.match ?? "").toLowerCase();
  let rows: WidgetRow[] = [];
  let headline: WidgetView["headline"];

  if (w.source === "profiles") {
    const types = new Set(w.types ?? []);
    const openTasks = (data.tasks || []).filter((t) => t && t.status !== "done");
    rows = (data.profiles || [])
      .filter((p) => p && p.type !== "self" && (types.size === 0 || types.has(String(p.type))) && has([p.name, p.type_key ?? p.typeKey], needle))
      .map((p) => {
        const value = ["vehicle", "property", "asset", "investment", "account"].includes(String(p.type)) ? resolveAssetValue(p) : 0;
        // The next thing to do for this record, if there is one — what makes a
        // "Pet Care" or "Vehicle" card more than a list of names.
        const next = openTasks
          .filter((t) => Array.isArray(t.linkedProfiles) && t.linkedProfiles.includes(p.id))
          .sort((a, b) => String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")))[0];
        const kind = String(p.type_key ?? p.typeKey ?? p.type ?? "").replace(/_/g, " ");
        return {
          key: `profile:${p.id}`, title: String(p.name || "Untitled"),
          sub: next ? `Next: ${next.title}${next.dueDate ? ` · ${shortDay(next.dueDate)}` : ""}` : kind,
          right: value > 0 ? money(value) : undefined,
          href: routeForEntity("profile", p.id),
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title));
    const total = (data.profiles || []).reduce((s, p) => (rows.some((r) => r.key === `profile:${p?.id}`) && ["vehicle", "property", "asset", "investment", "account"].includes(String(p.type)) ? s + resolveAssetValue(p) : s), 0);
    if (total > 0) headline = { label: "Total value", value: money(total) };
  } else if (w.source === "trackers") {
    rows = (data.trackers || [])
      .filter((t) => t && has([t.name, t.category], needle))
      .map((t) => {
        const entries = Array.isArray(t.entries) ? t.entries.slice().sort((a: any, b: any) => String(b.timestamp).localeCompare(String(a.timestamp))) : [];
        const last = entries[0];
        const vals = last?.values && typeof last.values === "object" ? last.values : {};
        const firstNum = Object.entries(vals).find(([, v]) => Number.isFinite(Number(v)) && v !== "" && v !== null);
        const unit = (t.fields || []).find((f: any) => f?.name === firstNum?.[0])?.unit || t.unit || "";
        return {
          key: `tracker:${t.id}`, title: String(t.name || "Tracker"),
          sub: last ? `Last logged ${shortDay(last.timestamp)}` : "Nothing logged yet",
          right: firstNum ? `${Number(firstNum[1]).toLocaleString("en-US")}${unit ? ` ${unit}` : ""}` : undefined,
          href: routeForEntity("tracker", t.id),
          _at: last ? String(last.timestamp) : "",
        } as WidgetRow & { _at: string };
      })
      .sort((a: any, b: any) => String(b._at).localeCompare(String(a._at)))
      .map(({ _at, ...r }: any) => r);
  } else if (w.source === "expenses") {
    const from = w.days ? addDays(today, -w.days) : `${today.slice(0, 7)}-01`;
    const inWindow = (data.expenses || []).filter((e) => e && !e.deletedAt && String(e.date).slice(0, 10) >= from && String(e.date).slice(0, 10) <= today
      && has([e.category, e.description, e.vendor], needle));
    const sum = inWindow.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    headline = { label: w.days ? `Last ${w.days} days` : "This month", value: money(sum) };
    if (needle) {
      rows = inWindow.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)))
        .map((e) => ({ key: `expense:${e.id}`, title: String(e.description || e.vendor || e.category || "Expense"), sub: shortDay(e.date), right: money(Number(e.amount) || 0), href: routeForEntity("expense", e.id) }));
    } else {
      const byCat = new Map<string, number>();
      for (const e of inWindow) byCat.set(String(e.category || "other"), (byCat.get(String(e.category || "other")) || 0) + (Number(e.amount) || 0));
      rows = Array.from(byCat.entries()).sort((a, b) => b[1] - a[1])
        .map(([cat, amt]) => ({ key: `cat:${cat}`, title: cat.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), sub: sum > 0 ? `${Math.round((amt / sum) * 100)}% of spending` : undefined, right: money(amt), href: routeForEntity("expense") }));
    }
  } else if (w.source === "journal") {
    const from = w.days ? addDays(today, -w.days) : "";
    rows = (data.journal || [])
      .filter((j) => j && (!from || String(j.date).slice(0, 10) >= from) && has([j.title, j.content, ...(Array.isArray(j.tags) ? j.tags : [])], needle))
      .sort((a, b) => String(b.updatedAt || b.createdAt || b.date).localeCompare(String(a.updatedAt || a.createdAt || a.date)))
      .map((j) => ({ key: `journal:${j.id}`, title: clip(j.title || j.content, 60) || "Journal entry", sub: [shortDay(j.date), j.mood ? String(j.mood).replace(/_/g, " ") : ""].filter(Boolean).join(" · "), href: routeForEntity("journal", j.id) }));
  } else if (w.source === "notes") {
    const from = w.days ? addDays(today, -w.days) : "";
    rows = (data.notes || [])
      .filter((n) => n && (!from || String(n.updatedAt || n.createdAt || "").slice(0, 10) >= from) && has([n.title, n.content], needle))
      .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
      .map((n) => ({ key: `note:${n.id}`, title: clip(n.title || n.content, 60) || "Note", sub: shortDay(n.updatedAt || n.createdAt), href: routeForEntity("note", n.id) }));
  } else if (w.source === "tasks") {
    rows = (data.tasks || [])
      .filter((t) => t && t.status !== "done" && has([t.title, t.description, ...(Array.isArray(t.tags) ? t.tags : [])], needle))
      .sort((a, b) => String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999")))
      .map((t) => ({ key: `task:${t.id}`, title: String(t.title || "Task"), sub: t.dueDate ? `Due ${shortDay(t.dueDate)}` : "No due date", href: routeForEntity("task", t.id) }));
  } else if (w.source === "goals") {
    rows = (data.goals || [])
      .filter((g) => g && g.status !== "abandoned" && g.status !== "completed" && has([g.title, g.category, g.type], needle))
      .map((g) => {
        const target = Number(g.target), current = Number(g.current);
        const pct = Number.isFinite(target) && target !== 0 && Number.isFinite(current) ? Math.max(0, Math.min(100, Math.round((current / target) * 100))) : null;
        return { key: `goal:${g.id}`, title: String(g.title || "Goal"), sub: g.deadline ? `By ${shortDay(g.deadline)}` : undefined, right: pct != null ? `${pct}%` : undefined, href: routeForEntity("goal", g.id) };
      });
  } else if (w.source === "habits") {
    rows = (data.habits || [])
      .filter((h) => h && has([h.name], needle))
      .map((h) => {
        const doneToday = (Array.isArray(h.checkins) ? h.checkins : []).some((c: any) => String(c?.date).slice(0, 10) === today);
        return { key: `habit:${h.id}`, title: String(h.name || "Habit"), sub: doneToday ? "Done today" : "Not done today", href: routeForEntity("habit", h.id) };
      });
  }

  return { headline, rows: rows.slice(0, w.limit), total: rows.length };
}

/** One plain sentence saying what a widget shows — the dialog's description line. */
export function describeWidget(w: ExecWidget): string {
  const about = w.match ? ` matching “${w.match}”` : "";
  const n = `up to ${w.limit}`;
  switch (w.source) {
    case "profiles": {
      const kinds = (w.types && w.types.length ? w.types : ["record"]).map((t) => `${t.replace(/_/g, " ")}s`).join(" and ");
      return `Your ${kinds}${about}, with value and the next task for each (${n}).`;
    }
    case "trackers": return `Trackers${about} with their latest reading (${n}).`;
    case "expenses": return w.match
      ? `What you spent${about} ${w.days ? `in the last ${w.days} days` : "this month"}, with the total.`
      : `Spending by category ${w.days ? `over the last ${w.days} days` : "this month"}, with the total.`;
    case "journal": return `Your latest journal entries${about}${w.days ? ` from the last ${w.days} days` : ""} (${n}).`;
    case "notes": return `Your latest notes${about}${w.days ? ` from the last ${w.days} days` : ""} (${n}).`;
    case "tasks": return `Open tasks${about}, soonest first (${n}).`;
    case "goals": return `Active goals${about} and how far along each is (${n}).`;
    case "habits": return `Habits${about} and whether each is done today (${n}).`;
  }
}
