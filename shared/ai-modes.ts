// shared/ai-modes.ts — AI Modes the person builds for themselves.
//
// Owner request 2026-11-27: "expand AI Modes into a personalized AI workspace,
// where users aren't limited to the modes we develop. They can describe what
// they want their AI to do, and the AI builds a customized mode with its own
// interface, tabs, instructions, tools and access to relevant personal data …
// The AI should generate validated configuration schemas using approved
// interactive components rather than executing unrestricted generated code."
//
// A mode is a DESCRIPTION, never code and never data:
//   - who the AI is (name, icon, color, personality, instructions);
//   - what it may read (`access`: a fixed list of sources, enforced on the
//     server where the prompt is built — the client's copy is never trusted);
//   - its tabs, each one of four approved kinds:
//       overview  — what the mode is for, suggested conversations, cards;
//       widgets   — cards over the person's own records (shared/exec-widgets:
//                   the same lists every screen reads; nothing is copied);
//       insights  — an analysis asked for on a tap (it writes nothing);
//       chat      — the conversation (exactly one per mode).
// Every mode, whether the model proposed it, a template made it, the fixed
// rules inferred it or a file was imported, passes `sanitizeAiMode` before it
// is shown or stored. A figure the AI does not know is not a field here.
//
// Journal text is private by default (WA2): no builder ever turns `journal`
// on. A mode that would use it says so (`suggestJournal`) and the person
// switches it on themselves.
//
// Pure and deterministic. Pinned by tests/ai-modes.test.ts.

import { inferWidgetFromText, sanitizeWidget, newWidgetId, type ExecWidget } from "./exec-widgets";
import { groundWellnessWidget, sanitizeWellnessWidget, type WellnessWidget } from "./wellness-widgets";
import { isWellnessRange, type WellnessRange } from "./wellness-period";

// ── The approved parts ───────────────────────────────────────────────────────

export const AI_MODES_PREF = "ai_modes";

export const MODE_SOURCES = ["profile", "tasks", "calendar", "finance", "health", "goals", "assets", "documents", "notes", "journal"] as const;
export type ModeSource = (typeof MODE_SOURCES)[number];

export const MODE_SOURCE_LABELS: Record<ModeSource, { label: string; detail: string }> = {
  profile: { label: "Your profile", detail: "Your name and the details on your own profile. Never passwords, ID or card numbers." },
  tasks: { label: "Tasks", detail: "Open tasks with their due dates, and what you finished lately." },
  calendar: { label: "Calendar", detail: "Events from the last two weeks and the next two months." },
  finance: { label: "Money", detail: "Spending from the last 90 days and your bills and subscriptions." },
  health: { label: "Health & trackers", detail: "Your own tracker readings by day, as numbers (no tracker notes)." },
  goals: { label: "Goals & habits", detail: "Your goals with their progress, and your habits." },
  assets: { label: "Assets & debts", detail: "What you own and owe, by name, type and value." },
  documents: { label: "Saved documents", detail: "The names and kinds of your documents." },
  notes: { label: "Notes", detail: "Your notes, newest first." },
  journal: { label: "Journal", detail: "Your own journal entries. Off unless you turn it on here." },
};

export const MODE_TAB_KINDS = ["overview", "widgets", "charts", "log", "insights", "chat"] as const;
export type ModeTabKind = (typeof MODE_TAB_KINDS)[number];
export const MODE_TAB_KIND_LABELS: Record<ModeTabKind, string> = {
  overview: "Overview — what it's for, suggested conversations, cards",
  widgets: "Cards — lists drawn from your records",
  charts: "Graphs — your trackers and health readings over time",
  log: "Log — a form that saves to a tracker",
  insights: "Analysis — the AI looks at your data when you tap",
  chat: "Chat — talk to this mode",
};

export const MODE_ICONS = [
  "sparkles", "heart", "dumbbell", "apple", "wallet", "briefcase", "car", "graduation", "plane", "search",
  "brain", "target", "book", "home", "paw", "leaf", "moon", "chart", "calendar", "compass",
] as const;
export type ModeIcon = (typeof MODE_ICONS)[number];

/** Color name → HSL triplet (the app's `hsl(var)` form). */
export const MODE_COLORS = {
  violet: "262 83% 66%",
  blue: "217 91% 60%",
  cyan: "189 94% 50%",
  teal: "172 66% 45%",
  green: "142 70% 45%",
  amber: "38 92% 55%",
  orange: "24 95% 58%",
  rose: "350 89% 62%",
  pink: "322 81% 65%",
  slate: "215 20% 60%",
} as const;
export type ModeColor = keyof typeof MODE_COLORS;
export const MODE_COLOR_NAMES = Object.keys(MODE_COLORS) as ModeColor[];

export const MAX_MODES = 40;
export const MAX_MODE_TABS = 8;
export const DEFAULT_MODE_TABS = 5;
export const MAX_TAB_WIDGETS = 6;
export const MAX_MODE_PROMPTS = 6;
export const MAX_INSTRUCTIONS = 2000;
export const MAX_TAB_GRAPHS = 4;
export const MAX_LOG_FIELDS = 6;
export const MAX_MODE_REMINDERS = 4;
export const MAX_MODE_CHECKINS = 2;

/** A tracker a Log tab writes to. Created only when the person taps "Create" (Rule 11: one per name). */
export interface ModeTrackerSpec {
  name: string;
  unit?: string;
  fields: Array<{ key: string; label: string; type: "number" | "text"; unit?: string }>;
}

export const REMINDER_FREQS = ["daily", "weekly", "monthly"] as const;
export type ReminderFreq = (typeof REMINDER_FREQS)[number];
/**
 * A reminder the mode offers. Turned on, it is a real recurring TASK (the
 * app's reminders and notifications already handle those), tagged
 * `reminderTaskTag(mode, reminder)`; whether it is on is read from the task
 * list, never stored (Rule 5).
 */
export interface ModeReminder { id: string; title: string; freq: ReminderFreq; time?: string }

/**
 * A check-in the mode runs on its own: one of its Analysis tabs, asked on a
 * schedule by the server's cron (server/ai-modes.ts `runModeCheckins`). The
 * answer is kept in the mode's digest row and announced as a notification. It
 * writes no record the person owns.
 */
export interface ModeCheckin { id: string; tabId: string; freq: "daily" | "weekly"; enabled: boolean }

export const reminderTaskTag = (modeId: string, reminderId: string) => `ai-mode:${modeId}:${reminderId}`;
export const modeDigestKey = (modeId: string) => `ai_mode_digest:${modeId}`;

export interface ModeTab {
  id: string;
  title: string;
  kind: ModeTabKind;
  /** overview / widgets: cards over the person's records. */
  widgets?: ExecWidget[];
  /** insights: what to look at when asked ("Compare sleep with workout performance"). */
  focus?: string;
  /** charts: graphs over the person's trackers and readings (shared/wellness-widgets — one system). */
  graphs?: WellnessWidget[];
  /** charts: the time range shown. */
  range?: WellnessRange;
  /** log: the tracker its form writes to. */
  tracker?: ModeTrackerSpec;
}

export interface AiMode {
  id: string;
  name: string;
  icon: ModeIcon;
  color: ModeColor;
  /** One line under the name. */
  tagline: string;
  /** How it talks ("warm and direct"). */
  personality: string;
  /** What it does and how — the system prompt's own part. */
  instructions: string;
  access: ModeSource[];
  /** Keep the conversation and what was learned between sittings (shared/ai-memory). */
  remember: boolean;
  tabs: ModeTab[];
  /** Suggested conversations. */
  prompts: string[];
  reminders: ModeReminder[];
  checkins: ModeCheckin[];
  /** Shown in the AI Modes row on the Chat page. */
  pinned: boolean;
  /** The template it started from, if any. */
  template?: string;
  createdAt: string;
  updatedAt: string;
}

/** What a builder returns before the person saves it. */
export interface ModeProposal {
  mode: AiMode;
  /** The mode would use the journal; the person decides (WA2). */
  suggestJournal: boolean;
  /** Who wrote it: the model, the fixed rules (no model, or no usable answer), or someone's published mode. */
  by: "ai" | "rules" | "library";
}

// ── Cleaning ─────────────────────────────────────────────────────────────────

const clip = (s: unknown, n: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, n) : "");
/** Multi-line text: line breaks kept, runs of blank lines folded. */
const clipText = (s: unknown, n: number) => (typeof s === "string" ? s.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, n) : "");
const slug = (s: string, n = 32) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, n);
const isIso = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
export const isModeId = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(v);

export function isModeSource(v: unknown): v is ModeSource { return (MODE_SOURCES as readonly string[]).includes(v as string); }

function sanitizeTab(raw: unknown, taken: Set<string>): ModeTab | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = String(r.kind ?? "") as ModeTabKind;
  if (!(MODE_TAB_KINDS as readonly string[]).includes(kind)) return null;
  const title = clip(r.title, 24);
  if (title.length < 2) return null;
  let id = slug(clip(r.id, 32)) || slug(title) || kind;
  for (let n = 2; taken.has(id); n++) id = `${slug(clip(r.id, 28)) || slug(title, 28) || kind}-${n}`;
  taken.add(id);
  const tab: ModeTab = { id, title, kind };
  if (kind === "overview" || kind === "widgets") {
    const widgets: ExecWidget[] = [];
    for (const w of Array.isArray(r.widgets) ? r.widgets : []) {
      const clean = sanitizeWidget(w, newWidgetId(widgets, clip((w as any)?.title, 24) || "card"));
      if (!clean) continue;
      if (widgets.some((x) => x.id === clean.id)) clean.id = newWidgetId(widgets, clean.id);
      widgets.push(clean);
      if (widgets.length >= MAX_TAB_WIDGETS) break;
    }
    tab.widgets = widgets;
  }
  if (kind === "charts") {
    const graphs: WellnessWidget[] = [];
    for (const g of Array.isArray(r.graphs) ? r.graphs : []) {
      const clean = sanitizeWellnessWidget({ display: "line", ...(g as object) }, `g${graphs.length + 1}`);
      if (!clean || graphs.some((x) => x.id === clean.id)) continue;
      graphs.push(clean);
      if (graphs.length >= MAX_TAB_GRAPHS) break;
    }
    tab.graphs = graphs;
    tab.range = isWellnessRange(r.range) ? r.range : "30d";
  }
  if (kind === "log") {
    const tracker = sanitizeTrackerSpec(r.tracker, title);
    if (!tracker) return null;
    tab.tracker = tracker;
  }
  if (kind === "insights") {
    const focus = clip(r.focus, 300);
    tab.focus = focus || `Look at my records for ${title.toLowerCase()} and tell me what stands out.`;
  }
  return tab;
}

function sanitizeTrackerSpec(raw: unknown, fallbackName: string): ModeTrackerSpec | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = clip(r.name, 40) || clip(fallbackName, 40);
  if (name.length < 2) return null;
  const fields: ModeTrackerSpec["fields"] = [];
  for (const f of Array.isArray(r.fields) ? r.fields : []) {
    const label = clip((f as any)?.label ?? (f as any)?.key, 30);
    const key = slug(clip((f as any)?.key, 30) || label, 30).replace(/-/g, "_");
    if (!label || !key || fields.some((x) => x.key === key)) continue;
    const unit = clip((f as any)?.unit, 12);
    fields.push({ key, label, type: (f as any)?.type === "text" ? "text" : "number", ...(unit ? { unit } : {}) });
    if (fields.length >= MAX_LOG_FIELDS) break;
  }
  if (fields.length === 0) fields.push({ key: "value", label: "Value", type: "number" });
  const unit = clip(r.unit, 12);
  return { name, ...(unit ? { unit } : {}), fields };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function sanitizeReminders(raw: unknown): ModeReminder[] {
  const out: ModeReminder[] = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const title = clip((r as any)?.title, 80);
    if (title.length < 3) continue;
    const freq = (REMINDER_FREQS as readonly string[]).includes((r as any)?.freq) ? (r as any).freq as ReminderFreq : "weekly";
    let id = slug(clip((r as any)?.id, 30) || title, 30) || "reminder";
    for (let n = 2; out.some((x) => x.id === id); n++) id = `${slug(title, 26) || "reminder"}-${n}`;
    const time = typeof (r as any)?.time === "string" && TIME_RE.test((r as any).time) ? (r as any).time : undefined;
    out.push({ id, title, freq, ...(time ? { time } : {}) });
    if (out.length >= MAX_MODE_REMINDERS) break;
  }
  return out;
}

function sanitizeCheckins(raw: unknown, tabs: ModeTab[]): ModeCheckin[] {
  const out: ModeCheckin[] = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    const tab = tabs.find((t) => t.kind === "insights" && t.id === (c as any)?.tabId);
    if (!tab || out.some((x) => x.tabId === tab.id)) continue;
    out.push({ id: `checkin-${tab.id}`, tabId: tab.id, freq: (c as any)?.freq === "daily" ? "daily" : "weekly", enabled: (c as any)?.enabled !== false });
    if (out.length >= MAX_MODE_CHECKINS) break;
  }
  return out;
}

/**
 * A mode as stored, proposed by a model, inferred or imported → a valid mode,
 * or null. Anything outside the approved parts is dropped, never coerced into
 * something plausible. There is always exactly one Chat tab.
 */
export function sanitizeAiMode(raw: unknown, opts: { id?: string; now?: Date; keepJournal?: boolean } = {}): AiMode | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = clip(r.name, 40);
  if (name.length < 2) return null;
  const id = opts.id ?? (isModeId(r.id) ? r.id : "");
  if (!isModeId(id)) return null;
  const nowIso = (opts.now ?? new Date()).toISOString();
  const icon = (MODE_ICONS as readonly string[]).includes(String(r.icon)) ? (r.icon as ModeIcon) : "sparkles";
  const color = (MODE_COLOR_NAMES as string[]).includes(String(r.color)) ? (r.color as ModeColor) : "violet";
  const access = Array.from(new Set((Array.isArray(r.access) ? r.access : []).filter(isModeSource)))
    .filter((s) => s !== "journal" || opts.keepJournal !== false)
    .sort((a, b) => MODE_SOURCES.indexOf(a) - MODE_SOURCES.indexOf(b));

  const taken = new Set<string>();
  const tabs: ModeTab[] = [];
  let chat: ModeTab | null = null;
  for (const t of Array.isArray(r.tabs) ? r.tabs : []) {
    const clean = sanitizeTab(t, taken);
    if (!clean) continue;
    if (clean.kind === "chat") { if (!chat) chat = clean; continue; }
    if (tabs.length < MAX_MODE_TABS - 1) tabs.push(clean);
  }
  if (!chat) { const cid = taken.has("chat") ? "chat-2" : "chat"; taken.add(cid); chat = { id: cid, title: "Chat", kind: "chat" }; }
  tabs.push(chat);

  const prompts = Array.from(new Set((Array.isArray(r.prompts) ? r.prompts : []).map((p) => clip(p, 140)).filter((p) => p.length >= 4))).slice(0, MAX_MODE_PROMPTS);
  const template = clip(r.template, 40);
  return {
    id, name, icon, color,
    tagline: clip(r.tagline, 120),
    personality: clip(r.personality, 200),
    instructions: clipText(r.instructions, MAX_INSTRUCTIONS),
    access,
    remember: r.remember !== false,
    tabs,
    prompts,
    reminders: sanitizeReminders(r.reminders),
    checkins: sanitizeCheckins(r.checkins, tabs),
    pinned: r.pinned === true,
    ...(template ? { template } : {}),
    createdAt: isIso(r.createdAt) ? r.createdAt : nowIso,
    updatedAt: isIso(r.updatedAt) ? r.updatedAt : nowIso,
  };
}

/** A fresh id for a new mode, from its name, unique among `existing`. */
export function newModeId(existing: ReadonlyArray<Pick<AiMode, "id">>, name: string): string {
  const base = slug(name, 28) || "mode";
  let id = base;
  for (let n = 2; existing.some((m) => m.id === id); n++) id = `${base}-${n}`;
  return id;
}

// ── The stored row ───────────────────────────────────────────────────────────

/** The `ai_modes` preferences row → its modes (an unreadable row is no modes). */
export function parseAiModes(raw: unknown): AiMode[] {
  let v: unknown = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { return []; } }
  const list = Array.isArray(v) ? v : (v && typeof v === "object" && Array.isArray((v as any).modes) ? (v as any).modes : []);
  const out: AiMode[] = [];
  for (const m of list) {
    // A stored mode keeps the journal switch the person set.
    const clean = sanitizeAiMode(m, { keepJournal: true });
    if (clean && !out.some((x) => x.id === clean.id)) out.push(clean);
    if (out.length >= MAX_MODES) break;
  }
  return out;
}
export const serializeAiModes = (modes: readonly AiMode[]): string => JSON.stringify({ version: 1, modes });

// ── Changing the list (each applied on the server to the STORED row, Rule 6) ─

export function reorderModes(modes: readonly AiMode[], ids: readonly string[]): AiMode[] {
  const byId = new Map(modes.map((m) => [m.id, m]));
  const out: AiMode[] = [];
  for (const id of ids) { const m = byId.get(id); if (m && !out.includes(m)) out.push(m); }
  for (const m of modes) if (!out.includes(m)) out.push(m);
  return out;
}

export function duplicateMode(modes: readonly AiMode[], id: string, now: Date): AiMode | null {
  const src = modes.find((m) => m.id === id);
  if (!src) return null;
  const name = clip(`${src.name} (copy)`, 40);
  const iso = now.toISOString();
  return sanitizeAiMode({ ...src, name, pinned: false, createdAt: iso, updatedAt: iso }, { id: newModeId(modes, name), now, keepJournal: true });
}

/** Fields a PATCH may change. `id`, `createdAt` never change. */
export const MODE_PATCH_KEYS = ["name", "icon", "color", "tagline", "personality", "instructions", "access", "remember", "tabs", "prompts", "reminders", "checkins", "pinned"] as const;

export function applyModePatch(mode: AiMode, patch: unknown, now: Date): AiMode | null {
  if (!patch || typeof patch !== "object") return null;
  const p = patch as Record<string, unknown>;
  const next: Record<string, unknown> = { ...mode };
  for (const k of MODE_PATCH_KEYS) if (k in p) next[k] = p[k];
  next.updatedAt = now.toISOString();
  return sanitizeAiMode(next, { id: mode.id, now, keepJournal: true });
}

// ── Templates (sharing a mode shares no private data) ───────────────────────

export const MODE_TEMPLATE_FORMAT = "portol-ai-mode";

/** What a shared template carries: the description only — no ids, dates, conversation or memories. */
export function exportModeTemplate(mode: AiMode): Record<string, unknown> {
  const { id: _id, createdAt: _c, updatedAt: _u, pinned: _p, ...rest } = mode;
  return { format: MODE_TEMPLATE_FORMAT, version: 1, mode: { ...rest, access: rest.access.filter((s) => s !== "journal") } };
}

/** A shared template file → a proposal to review (journal never on). */
export function importModeTemplate(raw: unknown, existing: readonly AiMode[], now: Date): AiMode | null {
  let v: unknown = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { return null; } }
  if (!v || typeof v !== "object") return null;
  const body = (v as any).format === MODE_TEMPLATE_FORMAT ? (v as any).mode : v;
  const name = clip((body as any)?.name, 40);
  if (name.length < 2) return null;
  return sanitizeAiMode({ ...body, pinned: false, createdAt: undefined, updatedAt: undefined }, { id: newModeId(existing, name), now, keepJournal: false });
}

// ── Built-in templates, and a sentence → a mode by fixed rules ──────────────

type W = Omit<ExecWidget, "id">;
const w = (title: string, source: ExecWidget["source"], extra: Partial<W> = {}): W => ({ title, source, icon: extra.icon ?? "star", limit: 4, ...extra } as W);
const T = (title: string, kind: ModeTabKind, extra: { widgets?: W[]; focus?: string; graphs?: Array<Omit<WellnessWidget, "id">>; range?: WellnessRange; tracker?: ModeTrackerSpec } = {}) => ({ title, kind, ...extra });

export interface ModeTemplate {
  key: string;
  /** Words that point at this template. */
  re: RegExp;
  suggestJournal?: boolean;
  mode: Omit<AiMode, "id" | "pinned" | "createdAt" | "updatedAt" | "remember" | "template" | "tabs" | "reminders" | "checkins"> & {
    tabs: Array<{ title: string; kind: ModeTabKind; widgets?: W[]; focus?: string; graphs?: Array<Omit<WellnessWidget, "id">>; range?: WellnessRange; tracker?: ModeTrackerSpec }>;
    reminders?: Array<Omit<ModeReminder, "id">>;
    checkins?: Array<Omit<ModeCheckin, "id" | "enabled">>;
  };
}

export const MODE_TEMPLATES: readonly ModeTemplate[] = [
  {
    key: "life-coach", re: /\b(life coach|coach me|motivat|personal growth|self[- ]improve|purpose|accountab)/i, suggestJournal: true,
    mode: {
      name: "Life Coach", icon: "compass", color: "violet", tagline: "Patterns, goals and growth — at your pace",
      personality: "Warm, direct and encouraging; asks one good question at a time",
      instructions: "Help me understand my habits, motivation and energy, set goals that fit my life, and take one small step at a time. Notice patterns in what I do and point them out kindly. You are a coach, not a therapist: you don't diagnose or treat anything.",
      access: ["profile", "tasks", "calendar", "goals", "health"],
      tabs: [
        T("Overview", "overview", { widgets: [w("My Goals", "goals", { icon: "target" }), w("Habits", "habits", { icon: "flame" })] }),
        T("Patterns", "insights", { focus: "What patterns do you see in my habits, energy and activity? What tends to come before a good week and a hard one?" }),
        T("Goals", "widgets", { widgets: [w("Goals", "goals", { icon: "target", limit: 6 }), w("Open tasks", "tasks", { icon: "check" })] }),
        T("Growth", "insights", { focus: "Where have I made progress lately, what keeps getting in the way, and what is one small next step?" }),
        T("Chat", "chat"),
      ],
      prompts: ["Why do I keep repeating the same habits?", "Help me set one goal for this month", "What should I focus on this week?"],
      reminders: [{ title: "Weekly reflection with my coach", freq: "weekly", time: "18:00" }],
      checkins: [{ tabId: "patterns", freq: "weekly" }],
    },
  },
  {
    key: "reflection", re: /\b(reflect|emotion|feelings?|understand myself|mood|self[- ]awareness|mental)/i, suggestJournal: true,
    mode: {
      name: "Personal Reflection", icon: "moon", color: "pink", tagline: "Understand yourself, gently",
      personality: "Calm, kind and curious; listens before it suggests",
      instructions: "Help me understand myself emotionally: reflect back what I say, notice patterns in how I feel and what comes with it, and help me look at a harsh thought from another side. You are a companion, not a therapist: you never diagnose or suggest treatment. If I am in danger, tell me to contact emergency services or a crisis line.",
      access: ["profile", "health", "calendar"],
      tabs: [
        T("Insights", "insights", { focus: "What do you notice about how I've been lately — what lifts me and what weighs on me?" }),
        T("Emotions", "insights", { focus: "Which feelings come up most, and what tends to come with them?" }),
        T("Patterns", "insights", { focus: "Do my sleep, activity or busy days line up with how I feel? Only say what the days support." }),
        T("Journal", "widgets", { widgets: [w("Recent entries", "journal", { icon: "book", limit: 5 })] }),
        T("Chat", "chat"),
      ],
      prompts: ["Help me understand why today felt heavy", "What have I been feeling most lately?", "Walk me through a short grounding exercise"],
    },
  },
  {
    key: "finance", re: /\b(financ|money|budget|spend|saving|invest|debt|net worth|retire)/i,
    mode: {
      name: "Financial Advisor", icon: "wallet", color: "green", tagline: "Spending, forecasts and strategy",
      personality: "Clear, practical and numbers-first; plain words, no jargon",
      instructions: "Help me understand where my money goes, what is coming up, and how to reach my goals. Use only the figures on file and say when something is missing. Give general education, not regulated financial advice.",
      access: ["profile", "finance", "assets", "goals"],
      tabs: [
        T("Overview", "overview", { widgets: [w("Spending this month", "expenses", { icon: "wallet", limit: 5 }), w("Upcoming bills", "bills", { icon: "wallet" })] }),
        T("Spending", "widgets", { widgets: [w("Recent spending", "expenses", { icon: "wallet", limit: 8, days: 30 }), w("Accounts & investments", "profiles", { icon: "wallet", types: ["account", "investment"] })] }),
        T("Forecasts", "insights", { focus: "Based on my bills and recent spending, what does the next month look like? Flag anything unusual." }),
        T("Strategy", "insights", { focus: "Given my spending, debts and goals, what are the two or three changes that would help most?" }),
        T("Chat", "chat"),
      ],
      prompts: ["Where did most of my money go this month?", "Which bill could I cut?", "How long until I pay off my debts?"],
      checkins: [{ tabId: "forecasts", freq: "weekly" }],
    },
  },
  {
    key: "fitness", re: /\b(fitness|workout|exercise|gym|training|run(?:ning)?|strength|recovery|athlet)/i,
    mode: {
      name: "Fitness Coach", icon: "dumbbell", color: "orange", tagline: "Progress, workouts and recovery",
      personality: "Upbeat and specific; celebrates consistency",
      instructions: "Help me train consistently: read my workouts and health trackers, notice trends, and suggest plans that fit my schedule. You are not a doctor: for pain or a medical question, tell me to see one.",
      access: ["profile", "health", "calendar", "goals"],
      tabs: [
        T("Progress", "insights", { focus: "How has my training changed over the last weeks — volume, consistency and the trend in my numbers?" }),
        T("Workouts", "charts", { range: "30d", graphs: [
          { title: "Workouts", icon: "dumbbell", kind: "metric", source: { kind: "workouts" }, calc: "count", display: "bar" },
          { title: "Steps", icon: "chart", kind: "metric", source: { kind: "metric", key: "steps" }, calc: "total", display: "bar" },
          { title: "Sleep", icon: "heart", kind: "metric", source: { kind: "metric", key: "sleep_hours" }, calc: "average", display: "line" },
        ] }),
        T("Recovery", "insights", { focus: "Compare my sleep and rest days with my workout performance. Only say what the days support." }),
        T("Plans", "insights", { focus: "Suggest a training plan for next week that fits my calendar and recent load." }),
        T("Chat", "chat"),
      ],
      prompts: ["Plan my workouts for next week", "Am I training too much?", "How is my progress this month?"],
      reminders: [{ title: "Log today's workout", freq: "daily", time: "19:00" }],
      checkins: [{ tabId: "progress", freq: "weekly" }],
    },
  },
  {
    key: "nutrition", re: /\b(nutrition|diet|food|meal|calori|protein|eat(?:ing)?|macro)/i,
    mode: {
      name: "Nutrition Coach", icon: "apple", color: "teal", tagline: "Meals, nutrients and trends",
      personality: "Friendly and non-judgmental; practical suggestions",
      instructions: "Help me eat in a way that fits my goals: read what I log, point out trends in calories and nutrients, and suggest simple meals. No medical diets: for a condition, tell me to talk to a doctor or dietitian.",
      access: ["profile", "health", "goals", "finance"],
      tabs: [
        T("Meals", "widgets", { widgets: [w("Food log", "trackers", { icon: "heart", match: "nutrition", limit: 6 })] }),
        T("Nutrients", "insights", { focus: "How do my calories, protein and other logged nutrients look over the last weeks?" }),
        T("Trends", "insights", { focus: "What eating patterns do you see — days, times, what tends to go together?" }),
        T("Plans", "insights", { focus: "Suggest a simple meal plan for the next few days that fits my goals and what I usually eat." }),
        T("Chat", "chat"),
      ],
      prompts: ["How much protein did I average this week?", "Plan three easy dinners", "What should I eat more of?"],
    },
  },
  {
    key: "business", re: /\b(business|company|startup|revenue|clients?|customers?|projects?|manage my work)/i,
    mode: {
      name: "Business Manager", icon: "briefcase", color: "blue", tagline: "Revenue, projects and strategy",
      personality: "Focused and decisive; turns ideas into next actions",
      instructions: "Help me run my business and projects: keep track of what is open and due, spot what is slipping, and turn plans into concrete next steps. Use only what is on file and say what is missing.",
      access: ["profile", "tasks", "calendar", "finance", "documents", "notes"],
      tabs: [
        T("Overview", "overview", { widgets: [w("Open tasks", "tasks", { icon: "check", limit: 6 }), w("Coming up", "events", { icon: "star" })] }),
        T("Revenue", "insights", { focus: "What do my income and spending records say about the business this month and last?" }),
        T("Projects", "widgets", { widgets: [w("Tasks", "tasks", { icon: "check", limit: 8 }), w("Project notes", "notes", { icon: "note" })] }),
        T("Strategy", "insights", { focus: "What are the three most important things to move forward this week, and what is at risk?" }),
        T("Chat", "chat"),
      ],
      prompts: ["What's slipping this week?", "Turn my notes into a project plan", "Summarize where things stand"],
    },
  },
  {
    key: "vehicle", re: /\b(vehicles?|cars?|truck|motorcycle|maintenance|mileage|oil change)/i,
    mode: {
      name: "Vehicle Manager", icon: "car", color: "slate", tagline: "Maintenance, costs and value",
      personality: "Practical and thorough",
      instructions: "Help me look after my vehicles: what maintenance is due, what they cost me, and what they are worth. Use only what is on file.",
      access: ["assets", "finance", "documents", "calendar", "tasks"],
      tabs: [
        T("Overview", "overview", { widgets: [w("My vehicles", "profiles", { icon: "car", types: ["vehicle"] })] }),
        T("Maintenance", "widgets", { widgets: [w("Car tasks", "tasks", { icon: "check", match: "car" }), w("Service events", "events", { icon: "star", match: "service" })] }),
        T("Costs", "insights", { focus: "What have my vehicles cost me lately — fuel, repairs, insurance, loans?" }),
        T("Valuation", "insights", { focus: "What are my vehicles worth now, and when would it make sense to sell or replace one?" }),
        T("Chat", "chat"),
      ],
      prompts: ["What maintenance is due?", "How much does my car cost per month?", "Should I sell my car?"],
    },
  },
  {
    key: "career", re: /\b(career|job|resume|résumé|interview|promotion|skills?)/i,
    mode: {
      name: "Career Coach", icon: "briefcase", color: "amber", tagline: "Skills, opportunities and progress",
      personality: "Encouraging and candid",
      instructions: "Help me grow my career: name my strengths from what is on file, plan the skills to build, prepare for interviews and improve my résumé. Never invent experience I don't have.",
      access: ["profile", "documents", "goals", "tasks", "notes"],
      tabs: [
        T("Skills", "insights", { focus: "From my profile, documents and notes, what are my strongest skills and what is worth building next?" }),
        T("Opportunities", "insights", { focus: "What kinds of roles or next steps fit what is on file about me?" }),
        T("Résumé", "insights", { focus: "How could my résumé be stronger? Name what is missing rather than inventing it." }),
        T("Progress", "widgets", { widgets: [w("Career goals", "goals", { icon: "target" }), w("Career tasks", "tasks", { icon: "check" })] }),
        T("Chat", "chat"),
      ],
      prompts: ["Help me prepare for an interview", "What skills should I learn next?", "Review my résumé"],
    },
  },
  {
    key: "learning", re: /\b(learn|study|course|class|exam|lesson|tutor|language)/i,
    mode: {
      name: "Learning Assistant", icon: "graduation", color: "cyan", tagline: "Subjects, lessons and practice",
      personality: "Patient and clear; checks understanding",
      instructions: "Help me learn: explain things step by step, quiz me, and keep track of what I am studying. Say when you are not sure.",
      access: ["notes", "goals", "tasks", "calendar"],
      tabs: [
        T("Subjects", "widgets", { widgets: [w("Study notes", "notes", { icon: "note", limit: 6 })] }),
        T("Lessons", "insights", { focus: "From my notes, what have I covered and what should the next lesson be?" }),
        T("Practice", "log", { tracker: { name: "Study sessions", unit: "min", fields: [{ key: "minutes", label: "Minutes", type: "number", unit: "min" }, { key: "subject", label: "Subject", type: "text" }] } }),
        T("Progress", "widgets", { widgets: [w("Learning goals", "goals", { icon: "target" }), w("Study tasks", "tasks", { icon: "check" })] }),
        T("Chat", "chat"),
      ],
      prompts: ["Quiz me on my notes", "Explain this simply", "Make me a study plan"],
    },
  },
  {
    key: "travel", re: /\b(travel|trip|vacation|holiday|itinerar|flight|hotel)/i,
    mode: {
      name: "Travel Planner", icon: "plane", color: "cyan", tagline: "Destinations, itinerary and budget",
      personality: "Enthusiastic and organized",
      instructions: "Help me plan trips: ideas, day-by-day itineraries, budgets and the documents I need. Use my calendar and spending only as they are on file.",
      access: ["calendar", "finance", "documents", "tasks", "notes"],
      tabs: [
        T("Destinations", "insights", { focus: "Suggest destinations that fit my calendar and recent spending, with one line on why." }),
        T("Itinerary", "widgets", { widgets: [w("Trip events", "events", { icon: "star", match: "trip" }), w("Trip tasks", "tasks", { icon: "check", match: "trip" })] }),
        T("Budget", "insights", { focus: "What would a trip cost me against my usual spending, and how could I save for it?" }),
        T("Documents", "widgets", { widgets: [w("Travel notes", "notes", { icon: "note", match: "travel" })] }),
        T("Chat", "chat"),
      ],
      prompts: ["Plan a long weekend", "Make a packing list", "What will my trip cost?"],
    },
  },
  {
    key: "research", re: /\b(research|investigat|sources?|findings?|report|paper|analy[sz]e a topic)/i,
    mode: {
      name: "Research Assistant", icon: "search", color: "blue", tagline: "Topics, sources and findings",
      personality: "Careful and precise; separates fact from guess",
      instructions: "Help me research topics: organize what I have in my notes and documents, summarize findings, and draft reports. Say clearly what comes from my notes and what is your own knowledge, and when you are unsure.",
      access: ["notes", "documents"],
      tabs: [
        T("Topics", "widgets", { widgets: [w("Research notes", "notes", { icon: "note", limit: 6 })] }),
        T("Sources", "insights", { focus: "Which of my notes and documents are sources, and what does each one cover?" }),
        T("Findings", "insights", { focus: "What are the main findings across my notes, and where do they disagree?" }),
        T("Reports", "insights", { focus: "Draft an outline for a short report on what my notes cover." }),
        T("Chat", "chat"),
      ],
      prompts: ["Summarize my research so far", "What are the open questions?", "Outline a report"],
    },
  },
  {
    key: "productivity", re: /\b(productiv|focus|organi[sz]e|time management|to-?dos?|prioriti|procrastinat)/i,
    mode: {
      name: "Productivity", icon: "target", color: "amber", tagline: "Priorities, time and focus",
      personality: "Brisk and practical",
      instructions: "Help me decide what to do next and get it done: prioritize my tasks against my calendar, spot what keeps getting pushed, and plan my days.",
      access: ["tasks", "calendar", "goals", "notes"],
      tabs: [
        T("Overview", "overview", { widgets: [w("Due soon", "tasks", { icon: "check", limit: 6 }), w("Today & next", "events", { icon: "star" })] }),
        T("Priorities", "insights", { focus: "Which three tasks matter most today and why? What keeps getting pushed back?" }),
        T("Week", "insights", { focus: "Plan my week: when should each important task happen, given my calendar?" }),
        T("Goals", "widgets", { widgets: [w("Goals", "goals", { icon: "target" }), w("Habits", "habits", { icon: "flame" })] }),
        T("Chat", "chat"),
      ],
      prompts: ["What should I do first today?", "Plan my week", "What have I been putting off?"],
      reminders: [{ title: "Plan tomorrow", freq: "daily", time: "21:00" }],
    },
  },
];

/** The template whose words best match `text`, or null. */
export function matchModeTemplate(text: string): ModeTemplate | null {
  const said = String(text || "");
  let best: { t: ModeTemplate; score: number } | null = null;
  for (const t of MODE_TEMPLATES) {
    const re = new RegExp(t.re.source, "gi");
    const score = (said.match(re) || []).length;
    if (score > 0 && (!best || score > best.score)) best = { t, score };
  }
  return best?.t ?? null;
}

/** A template → a new mode (not saved). */
export function modeFromTemplate(t: ModeTemplate, existing: readonly AiMode[], now: Date): AiMode {
  return sanitizeAiMode({ ...t.mode, template: t.key, remember: true, pinned: false }, { id: newModeId(existing, t.mode.name), now, keepJournal: false })!;
}

const NAME_FILLER = /^(?:an?|the|my)\s+(?:ai|assistant|mode|app)?\s*(?:that|which|who|to)?\s*(?:helps?|lets?)?\s*(?:me)?\s*(?:to)?\s*/i;

/**
 * Read a description ("An AI that helps me understand myself emotionally")
 * into a mode by fixed rules: the nearest template, its purpose set to what
 * was asked. Deterministic: the builder's answer when no model is reachable.
 */
export function inferModeFromText(text: string, existing: readonly AiMode[], now: Date): ModeProposal {
  const said = clip(text, 600);
  const t = matchModeTemplate(said);
  if (t) {
    const mode = modeFromTemplate(t, existing, now);
    mode.instructions = clipText(`${mode.instructions}\n\nWhat I asked for: ${said}`, MAX_INSTRUCTIONS);
    return { mode, suggestJournal: !!t.suggestJournal, by: "rules" };
  }
  // Nothing known: a general assistant named from the request.
  const core = said.replace(NAME_FILLER, "").replace(/[.!?].*$/, "").trim();
  const words = core.split(/\s+/).filter((x) => x.length > 2).slice(0, 3);
  const name = clip(words.map((x) => x[0].toUpperCase() + x.slice(1)).join(" "), 40) || "My Assistant";
  const card = inferWidgetFromText(said, "related");
  const mode = sanitizeAiMode({
    name, icon: "sparkles", color: "violet", tagline: clip(said, 120), personality: "Helpful, clear and concise",
    instructions: `Help me with this: ${said}\nUse only what is on file about me, and say when something is missing.`,
    access: ["profile", "tasks", "calendar", "notes"],
    tabs: [
      { title: "Overview", kind: "overview", widgets: [card] },
      { title: "Insights", kind: "insights", focus: `Looking at my records, what stands out for: ${said}` },
      { title: "Plan", kind: "insights", focus: `Suggest a simple plan for: ${said}` },
      { title: "Records", kind: "widgets", widgets: [{ title: "Open tasks", source: "tasks", icon: "check", limit: 5 }] },
      { title: "Chat", kind: "chat" },
    ],
    prompts: [`Where should I start with ${core.toLowerCase().slice(0, 80) || "this"}?`, "What do you need to know about me?"],
    remember: true, pinned: false,
  }, { id: newModeId(existing, name), now, keepJournal: false })!;
  return { mode, suggestJournal: /\bjournal|diary|feel/i.test(said), by: "rules" };
}

// ── Changing a mode by talking ───────────────────────────────────────────────

/**
 * Apply a plain instruction by fixed rules ("add a sleep analysis tab",
 * "rename it to Coach", "remove the Budget tab", "be more direct"). Returns
 * the changed mode, or null when the rules can't read it.
 */
export function reviseModeByRules(mode: AiMode, instruction: string, now: Date): AiMode | null {
  const said = clip(instruction, 400);
  let m: RegExpMatchArray | null;
  if ((m = said.match(/\b(?:rename|call)\s+(?:it|this|the mode|this mode)?\s*(?:to|as)?\s*["“]?([^"”]{2,40})["”]?$/i))) {
    return applyModePatch(mode, { name: m[1].trim() }, now);
  }
  if ((m = said.match(/\b(?:remove|delete|drop)\s+(?:the\s+)?["“]?([^"”]+?)["”]?\s+tab\b/i))) {
    const name = m[1].trim().toLowerCase();
    const tabs = mode.tabs.filter((t) => t.kind === "chat" || t.title.toLowerCase() !== name);
    return tabs.length === mode.tabs.length ? null : applyModePatch(mode, { tabs }, now);
  }
  if ((m = said.match(/\badd\s+(?:an?\s+)?(.+?)\s+tab\b(.*)$/i))) {
    if (mode.tabs.length >= MAX_MODE_TABS) return null;
    const subject = m[1].replace(/\b(?:new|analysis|analyses)\b/gi, " ").replace(/\s+/g, " ").trim();
    const title = clip(subject.split(" ").slice(0, 3).map((x) => x[0]?.toUpperCase() + x.slice(1)).join(" "), 24) || "New";
    const wantsCards = /\b(list|cards?|show|tracker|widgets?)\b/i.test(said) && !/\b(compare|analy|why|pattern|trend)/i.test(said);
    const tab = wantsCards
      ? { title, kind: "widgets", widgets: [inferWidgetFromText(subject || said, "card")] }
      : { title, kind: "insights", focus: clip(`${said.replace(/^.*?\btab\b\s*(?:to|and|that)?\s*/i, "") || `Analyze my ${subject}`}`, 300) };
    const chatAt = mode.tabs.findIndex((t) => t.kind === "chat");
    const tabs = [...mode.tabs.slice(0, chatAt), tab, ...mode.tabs.slice(chatAt)];
    return applyModePatch(mode, { tabs }, now);
  }
  if (/\b(be|sound|talk|act)\s+(more|less)\b/i.test(said) || /\b(tone|personality)\b/i.test(said)) {
    return applyModePatch(mode, { personality: clip(`${mode.personality}; ${said}`, 200) }, now);
  }
  return null;
}

/** One line per difference between two versions of a mode, for the person to review before applying. */
export function describeModeChanges(before: AiMode, after: AiMode): string[] {
  const out: string[] = [];
  if (before.name !== after.name) out.push(`Name: ${before.name} → ${after.name}`);
  if (before.icon !== after.icon || before.color !== after.color) out.push("Icon or color changed");
  if (before.tagline !== after.tagline) out.push("Tagline changed");
  if (before.personality !== after.personality) out.push(`Personality: ${after.personality || "(none)"}`);
  if (before.instructions !== after.instructions) out.push("Instructions changed");
  const added = after.access.filter((s) => !before.access.includes(s));
  const removed = before.access.filter((s) => !after.access.includes(s));
  if (added.length) out.push(`Can now read: ${added.map((s) => MODE_SOURCE_LABELS[s].label).join(", ")}`);
  if (removed.length) out.push(`No longer reads: ${removed.map((s) => MODE_SOURCE_LABELS[s].label).join(", ")}`);
  const titles = (m: AiMode) => m.tabs.map((t) => t.title);
  const newTabs = titles(after).filter((t) => !titles(before).includes(t));
  const goneTabs = titles(before).filter((t) => !titles(after).includes(t));
  if (newTabs.length) out.push(`New tab${newTabs.length > 1 ? "s" : ""}: ${newTabs.join(", ")}`);
  if (goneTabs.length) out.push(`Removed tab${goneTabs.length > 1 ? "s" : ""}: ${goneTabs.join(", ")}`);
  if (!newTabs.length && !goneTabs.length && JSON.stringify(before.tabs) !== JSON.stringify(after.tabs)) out.push("Tabs rearranged or changed");
  if (JSON.stringify(before.prompts) !== JSON.stringify(after.prompts)) out.push("Suggested conversations changed");
  return out;
}

// ── The model's part ─────────────────────────────────────────────────────────

/** The schema the model fills in, described once for both the builder and the reviser. */
export const MODE_SCHEMA_PROMPT =
  `A mode is JSON: {"name": "2–40 chars", "icon": one of ${JSON.stringify(MODE_ICONS)}, "color": one of ${JSON.stringify(MODE_COLOR_NAMES)}, ` +
  `"tagline": "one line", "personality": "how it talks, one line", "instructions": "what it does and how, in the first person of the user ('Help me …'), under 1500 chars", ` +
  `"access": a list from ${JSON.stringify(MODE_SOURCES.filter((s) => s !== "journal"))} — only what the purpose needs, ` +
  `"tabs": ${DEFAULT_MODE_TABS} tabs by default (at most ${MAX_MODE_TABS}), the LAST one {"title":"Chat","kind":"chat"}; every other tab is one of:\n` +
  `  {"title":"…","kind":"overview","widgets":[CARD,…]}  (what it's for, suggested conversations, cards)\n` +
  `  {"title":"…","kind":"widgets","widgets":[CARD,…]}   (lists drawn from the user's records)\n` +
  `  {"title":"…","kind":"insights","focus":"the question the AI answers from the records when the user taps"}\n` +
  `  {"title":"…","kind":"charts","range":"7d"|"30d"|"90d"|"1y","graphs":[GRAPH,…]}  (graphs over time, at most ${MAX_TAB_GRAPHS})\n` +
  `  {"title":"…","kind":"log","tracker":{"name":"Tracker name","unit":"optional","fields":[{"key":"minutes","label":"Minutes","type":"number"|"text","unit":"optional"}]}}  (a form that saves an entry to that tracker)\n` +
  `  GRAPH = {"title":"…","kind":"metric","source":{"kind":"metric","key":one of ["sleep_hours","steps","weight","heart_rate"]} or {"kind":"tracker","key":"<a tracker name>","field":"<number field>"} or {"kind":"workouts"} or {"kind":"mood"},"calc":"average"|"total"|"latest"|"count","display":"line"|"bar"}\n` +
  `  CARD = {"title":"…","source": one of ["profiles","trackers","expenses","bills","events","journal","notes","tasks","goals","habits"], "match":"optional word to filter by", ` +
  `"types":["vehicle"|"pet"|"property"|"person"|"account"|"investment"|… only for profiles], "days": optional number, "limit": 1–8}\n` +
  `"prompts": up to ${MAX_MODE_PROMPTS} suggested first messages, "suggestJournal": true only if reading the user's journal is central to the purpose.\n` +
  `"reminders": up to ${MAX_MODE_REMINDERS} of {"title":"Log today's workout","freq":"daily"|"weekly"|"monthly","time":"HH:MM optional"} (offered, the user turns them on), ` +
  `"checkins": up to ${MAX_MODE_CHECKINS} of {"tabId":"<the id of an insights tab, its title in lower-case-with-dashes>","freq":"daily"|"weekly"} (the AI runs that tab on a schedule).\n` +
  `Tab titles are one or two words. Nothing else: no code, no markup, no other keys.`;

/** Pull the first JSON object out of a model answer. */
export function extractJson(raw: string): unknown {
  const s = String(raw || "").replace(/```(?:json)?/gi, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

// ── Insights: grounded in the sources that were sent ────────────────────────

export interface ModeInsight { title: string; detail: string; sources: ModeSource[] }

/**
 * The model's insight list → items that stand on something that was SENT.
 * An item naming no source, or only sources that were not read, is dropped.
 */
export function parseModeInsights(raw: string, sent: readonly ModeSource[]): ModeInsight[] | null {
  const v = extractJson(raw) as any;
  if (!v || !Array.isArray(v.items)) return null;
  const out: ModeInsight[] = [];
  for (const it of v.items) {
    const title = clip(it?.title, 90);
    const detail = clipText(it?.detail, 900);
    const sources = Array.from(new Set((Array.isArray(it?.sources) ? it.sources : []).filter((s: unknown) => isModeSource(s) && sent.includes(s as ModeSource)))) as ModeSource[];
    if (!title || !detail || sources.length === 0) continue;
    out.push({ title, detail, sources });
    if (out.length >= 6) break;
  }
  return out;
}

/** The memory row's app name for a mode (shared/ai-memory). */
export const modeMemoryApp = (id: string) => `mode-${id}` as const;

// ── Graphs are grounded in what the person tracks ────────────────────────────

/**
 * A graph over a tracker the person does not have, and that no Log tab of the
 * mode will create, is dropped (H8: the AI only chooses from what is
 * tracked). A graph over one they do have is written back with its real name.
 * A Log tab's own tracker counts as existing: the graph fills in once
 * entries are saved.
 */
export function groundModeGraphs(mode: AiMode, trackers: readonly any[]): AiMode {
  const declared = mode.tabs.filter((t) => t.kind === "log" && t.tracker).map((t) => ({ name: t.tracker!.name, fields: t.tracker!.fields.map((f) => ({ name: f.key, type: f.type })), entries: [] }));
  const known = [...trackers, ...declared];
  const tabs = mode.tabs.map((t) => {
    if (t.kind !== "charts" || !t.graphs) return t;
    const graphs = t.graphs.map((g) => {
      const usesDeclared = [g.source, g.other].some((r) => r?.kind === "tracker" && declared.some((d) => d.name.toLowerCase() === String(r.key || "").toLowerCase()));
      return usesDeclared ? g : groundWellnessWidget(g, known);
    }).filter((g): g is WellnessWidget => !!g);
    return { ...t, graphs };
  });
  return { ...mode, tabs };
}

// ── Check-ins ────────────────────────────────────────────────────────────────

export interface ModeDigestRun { at: string; items: ModeInsight[]; read: ModeSource[] }
export interface ModeDigest { runs: Record<string, ModeDigestRun> }

export function parseModeDigest(raw: unknown): ModeDigest {
  let v: unknown = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { return { runs: {} }; } }
  const runs: Record<string, ModeDigestRun> = {};
  const src = (v && typeof v === "object" && (v as any).runs && typeof (v as any).runs === "object") ? (v as any).runs : {};
  for (const [tabId, r] of Object.entries(src as Record<string, any>)) {
    if (!r || !isIso(r.at) || !Array.isArray(r.items)) continue;
    const read = (Array.isArray(r.read) ? r.read : []).filter(isModeSource) as ModeSource[];
    const items = parseModeInsights(JSON.stringify({ items: r.items }), read) ?? [];
    runs[tabId] = { at: r.at, items, read };
  }
  return { runs };
}

const HOUR = 3_600_000;
/** Is a check-in due? Daily: 20 hours since the last run; weekly: six and a half days. Never run: due. */
export function checkinDue(c: ModeCheckin, lastAt: string | null | undefined, now: Date): boolean {
  if (!c.enabled) return false;
  if (!lastAt || !Number.isFinite(Date.parse(lastAt))) return true;
  const gap = now.getTime() - Date.parse(lastAt);
  return gap >= (c.freq === "daily" ? 20 * HOUR : 156 * HOUR);
}

/** The recurring task a reminder becomes when the person turns it on. */
export function reminderTask(mode: Pick<AiMode, "id" | "name">, r: ModeReminder, todayISO: string): { title: string; dueDate: string; dueTime?: string; tags: string[]; priority: "low" } {
  return {
    title: r.title,
    dueDate: todayISO,
    ...(r.time ? { dueTime: r.time } : {}),
    tags: [`recur:${r.freq}`, reminderTaskTag(mode.id, r.id)],
    priority: "low",
  };
}
