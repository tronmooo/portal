// Mega-plan multi-section extraction — pure pieces (whitelist, schema,
// prompt, parsing, dedupe, dependency ordering, sectioned reply). No imports
// from ai-engine so this module stays unit-testable (tests/mega-plan.test.ts,
// tests/mega-reply.test.ts) and free of circular dependencies; the executor
// lives in server/ai-engine.ts (runMegaPlanPath) because it needs the
// engine's private tool plumbing — the same split ai-bulk-log.ts uses.
//
// The mega path exists for ONE message shape: a giant mixed-CRUD command
// ("set up my whole dashboard: create these tasks, bills, habits, assets,
// link the loan to the car, log today's run…") with dozens of operations
// across every dashboard section. The bulk path can't take it (9-tool
// whitelist, no ordering); the agentic loop can't survive it (wall-clock
// budget). Here: one forced-tool extraction call produces a typed plan with
// dependency refs, a pure normalize pass dedupes across sections and orders
// by dependency, and the executor runs each op through the standard
// validate → execute → verify → ledger pipeline.
import type Anthropic from "@anthropic-ai/sdk";
import type { OperationOutcome } from "./ai-bulk-log";
import { trackerIdentityKey } from "@shared/tracker-identity";

/** Write tools the mega extractor may emit. Anything else is dropped.
 * Deliberately excludes deletes, merges, and document tools — a first-contact
 * mega command creates and links; destructive ops stay behind the agentic
 * loop's confirmation flows. Every name is pinned against TOOL_DEFINITIONS
 * by tests/ai-tool-registry.test.ts. */
export const MEGA_ACTION_TOOLS = [
  // Tasks
  "create_task",
  "update_task",
  "complete_task",
  // Events / reminders
  "create_event",
  "create_reminder",
  // Bills / liabilities (bills ARE liability profiles)
  "create_liability",
  "create_obligation",
  "update_liability",
  "add_liability_payment",
  "pay_obligation",
  // Habits
  "create_habit",
  "checkin_habit",
  // Trackers / wellness
  "create_tracker",
  "log_tracker_entry",
  "log_medication_dose",
  "journal_entry",
  // Finance
  "create_expense",
  "log_income",
  "set_budget",
  "create_budget",
  // Assets / profiles
  "create_profile",
  "update_profile",
  "revalue_asset",
  // Linking
  "link_liability_asset",
  "link_asset_to_liability",
  "link_asset_owner",
  "link_entities",
  // Goals / dashboard
  "create_goal",
  "configure_dashboard_sections",
] as const;
export type MegaActionTool = (typeof MEGA_ACTION_TOOLS)[number];

/** Hard cap on operations per mega message. */
export const MAX_MEGA_OPERATIONS = 80;

/** The dashboard sections a mega reply is grouped by, in display order. */
export const MEGA_SECTIONS = [
  "attention",
  "tasks",
  "events",
  "bills",
  "habits",
  "trackers",
  "finance",
  "wellness",
  "assets",
  "liabilities",
  "today",
  "dashboard",
] as const;
export type MegaSection = (typeof MEGA_SECTIONS)[number];

const SECTION_LABELS: Record<MegaSection, string> = {
  attention: "Attention",
  tasks: "Tasks",
  events: "Events",
  bills: "Bills",
  habits: "Habits",
  trackers: "Trackers",
  finance: "Finance",
  wellness: "Wellness",
  assets: "Assets",
  liabilities: "Liabilities",
  today: "Today",
  dashboard: "Dashboard",
};

/** Sections that are DERIVED views over source records — the reply explains
 * the derivation instead of pretending a record was written "into" them. */
const DERIVED_SECTION_NOTES: Partial<Record<MegaSection, string>> = {
  attention:
    "Attention is computed from urgent source records — these alerts surface there automatically and clear when the underlying record is resolved.",
  today:
    "Today's timeline rebuilds itself from records dated today — everything below appears there sorted by time, with no duplicates.",
  wellness:
    "Wellness reads directly from your trackers — the entries below feed it without duplicate wellness records.",
  dashboard:
    "Every dashboard bubble recomputes from the saved records — counts, due-soon totals, and next-item labels update automatically on any future edit, completion, payment, or deletion.",
};

/** Fallback section when the extractor didn't tag one. */
const TOOL_SECTION_MAP: Record<MegaActionTool, MegaSection> = {
  create_task: "tasks",
  update_task: "tasks",
  complete_task: "tasks",
  create_event: "events",
  create_reminder: "events",
  create_liability: "bills",
  create_obligation: "bills",
  update_liability: "liabilities",
  add_liability_payment: "liabilities",
  pay_obligation: "bills",
  create_habit: "habits",
  checkin_habit: "habits",
  create_tracker: "trackers",
  log_tracker_entry: "trackers",
  log_medication_dose: "trackers",
  journal_entry: "wellness",
  create_expense: "finance",
  log_income: "finance",
  set_budget: "finance",
  create_budget: "finance",
  create_profile: "assets",
  update_profile: "assets",
  revalue_asset: "assets",
  link_liability_asset: "liabilities",
  link_asset_to_liability: "liabilities",
  link_asset_owner: "assets",
  link_entities: "assets",
  create_goal: "dashboard",
  configure_dashboard_sections: "dashboard",
};

export function sectionForOp(tool: string, tagged?: string | null): MegaSection {
  if (tagged && (MEGA_SECTIONS as readonly string[]).includes(tagged)) return tagged as MegaSection;
  return TOOL_SECTION_MAP[tool as MegaActionTool] || "dashboard";
}

export interface MegaPlanOp {
  /** 1-based position in the ORIGINAL extracted array — the number `#opN`
   * refs point at. Stable across dedupe/reordering. */
  originalIndex: number;
  tool: MegaActionTool;
  input: Record<string, any>;
  raw: string;
  section: MegaSection;
  /** input-field name → originalIndex of the op whose created entity fills it. */
  refs: Record<string, number>;
  /** Extra ordering edges beyond refs (originalIndex values). */
  dependsOn: number[];
}

export interface MegaPlanNormalized {
  /** Executable ops in dependency order. */
  ops: MegaPlanOp[];
  /** Outcomes pre-seeded for ops merged away by the dedupe pass. */
  preseededOutcomes: OperationOutcome[];
  /** originalIndex of a dropped op → originalIndex of its surviving twin.
   * The executor resolves refs through this before looking up entity ids. */
  aliasMap: Record<number, number>;
  /** Human-readable notes about anything the normalizer changed or dropped. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Extraction tool schema
// ---------------------------------------------------------------------------

export const EXTRACT_PLAN_TOOL: Anthropic.Messages.Tool = {
  name: "extract_plan",
  description:
    "Convert the user's multi-section command into an ordered operation plan. One entry per requested record or link. Never merge, drop, or skip a requested item.",
  input_schema: {
    type: "object" as const,
    properties: {
      operations: {
        type: "array",
        description: "One entry per requested operation, in message order.",
        items: {
          type: "object",
          properties: {
            tool: {
              type: "string",
              enum: [...MEGA_ACTION_TOOLS],
              description: "Which write tool handles this operation.",
            },
            input: {
              type: "object",
              description: "The exact input object for that tool.",
            },
            raw: {
              type: "string",
              description: "The clause from the user's message this operation came from, verbatim.",
            },
            section: {
              type: "string",
              enum: [...MEGA_SECTIONS],
              description: "Which dashboard section the user framed this request under (for the reply summary only).",
            },
            refs: {
              type: "object",
              description:
                'Input fields whose value is an entity created by an EARLIER operation in this plan. Map field name → "#opN" (1-based operation number). Example: linking a loan to the car created by operation 9: { "assetName": "#op9" }.',
            },
            dependsOn: {
              type: "array",
              items: { type: "number" },
              description: "Operation numbers (1-based) that must execute before this one, when refs alone don't capture it.",
            },
          },
          required: ["tool", "input", "raw"],
        },
      },
    },
    required: ["operations"],
  },
};

// ---------------------------------------------------------------------------
// Extraction prompt
// ---------------------------------------------------------------------------

export function buildMegaExtractionPrompt(opts: {
  nowISO: string;
  timezone?: string;
  trackerNames: string[];
  profileNames: string[];
  habitNames: string[];
}): string {
  const trackers = opts.trackerNames.slice(0, 150).join(", ") || "(none yet)";
  const habits = opts.habitNames.slice(0, 60).join(", ") || "(none)";
  const profiles = opts.profileNames.slice(0, 60).join(", ") || "(none)";
  return `You are the plan extractor for Portol, a life-tracking OS. The user sent ONE giant command asking for many records across their dashboard sections (Attention, Tasks, Events, Bills, Habits, Trackers, Finance, Wellness, Assets, Liabilities, Today, Dashboard). Convert EVERY requested record, log, and link into one operation via the extract_plan tool. NEVER drop, merge, or refuse a requested item.

NOW: ${opts.nowISO}${opts.timezone ? ` (user timezone: ${opts.timezone})` : ""}

SECTION ROUTING DOCTRINE:
- ATTENTION: there is NO attention table. An "attention item" or "urgent alert" is its SOURCE record — an urgent create_reminder or high-priority create_task with an imminent due date, or an overdue bill (create_liability). The Attention bubble derives alerts from those records and clears them when resolved. Tag such operations section:"attention" so the reply can explain this.
- BILLS: a RECURRING bill (phone, internet, insurance — anything "monthly on the Nth") → create_liability (bills are liability records in this app). A one-time bill due on a date → create_liability with a single due date. Money ALREADY spent → create_expense. NEVER emit both a bill and a liability operation for the same payment — one recurring payment is ONE create_liability.
- LIABILITIES: loans → create_liability with balance and payment fields. Linking a liability to an asset → link_liability_asset with refs when the asset is created in this same plan.
- EVENTS: appointments with a date/time → create_event (include start/end times). Recurring events ("every Sunday at 5:30") → create_event with the recurrence stated. Annual all-day events (birthdays) → create_event marked all-day annual. Do NOT re-create bills, habits, or liabilities as events — the calendar derives their occurrences automatically.
- HABITS: recurring personal routines ("daily medication at 8 AM", "workout Mon/Wed/Fri") → create_habit with frequency, days, and time. A completion TODAY of an existing habit → checkin_habit.
- TRACKERS: every measurement gets its own log_tracker_entry with the correct tracker and units — run (distance + duration), steps, water ounces, sleep hours, weight, blood pressure (systolic/diastolic — NEVER confused with heart rate), resting heart rate (bpm), mood /10, energy /10, practice minutes, workout minutes. Reuse an EXISTING tracker name from the list below when it matches.
- FINANCE: income → log_income. Purchases → create_expense with category. A TRANSFER between the user's own accounts → create_expense with category "transfer" and description "Transfer: <from> → <to>" — transfers are excluded from income and spending math automatically. NEVER log a transfer as income.
- WELLNESS: meals, sleep, hydration, mood, energy, exercise → log_tracker_entry (Nutrition/Sleep/Hydration/Mood/Energy trackers); Wellness derives from trackers, so no separate wellness records exist. Meals: one Nutrition entry per meal with the items.
- ASSETS: a vehicle/property → create_profile with type "asset" and its fields (value, mileage). Maintenance work with a cost (oil change) → ONE create_expense with category "maintenance" and assetName set to the asset (use refs when the asset is created in this plan) — the expense appears in both the asset's history and Finance without duplication. Do NOT also write mileage/maintenance into the asset separately when the expense op carries it; DO use update_profile for a bare mileage update.
- TODAY / DASHBOARD: these are derived views — do not invent records for them. Only configure_dashboard_sections when the user explicitly asks to change dashboard layout.
- DOCUMENTS: out of scope — skip document requests entirely.

DEPENDENCY REFS: when an operation needs an entity created EARLIER IN THIS PLAN (a loan linked to a car created here, an expense attached to that car), reference it via refs: { "<inputField>": "#opN" } where N is the 1-based operation number. Order operations so creations come before their links.

INPUT SHAPES (the executor validates these exactly — use these field names):
- create_task { title, dueDate?: "YYYY-MM-DD", priority?: "low"|"medium"|"high", tags? }
- create_reminder { title, fireAt: "YYYY-MM-DDTHH:MM:SS" (user-local wall clock, REQUIRED) }
- create_event { title, date: "YYYY-MM-DD", time?: "HH:MM", endTime?, allDay?, recurrence?: "none"|"daily"|"weekdays"|"weekends"|"weekly"|"biweekly"|"monthly"|"yearly", category? }
- create_liability { name, amount (per-payment), frequency: "monthly"|"weekly"|"yearly"|"once", dueDay? (1-31) or dueDate? "YYYY-MM-DD", balance? (remaining principal), category?, forProfile? }
- create_habit { name, frequency: "daily"|"weekly"|"custom", targetDays?: ["mon",...], time?: "HH:MM", targetPerDay? }
- log_tracker_entry { trackerName, values: {...}, at?: "HH:MM AM/PM" }
- create_expense { amount, description, category?, date?: "YYYY-MM-DD", vendor?, assetName? (maintenance work on an asset), forProfile? }
- log_income { amount, source, date? }
- create_profile { name, type: "vehicle"|"property"|"asset"|"person"|"pet"|..., fields?: { value?, mileage?, ... } }
- link_liability_asset { liabilityName, assetName, role?: "collateral" }

OTHER RULES:
- NEVER drop a stated detail: every amount, date, time, recurrence, priority, unit, and quantity must land in the input ("due monthly on the 15th" → frequency monthly + due day 15; "$86.50" → 86.50; "high priority" → priority high).
- Dates resolve against NOW ("tomorrow", "Friday", "August 6").
- forProfile / owner: set ONLY when the message names someone else. Never infer.
- Echo each source clause verbatim in raw.

EXISTING TRACKERS: ${trackers}
EXISTING HABITS: ${habits}
PROFILES: ${profiles}

Return EVERY requested operation — a command asking for ~45 records yields ~45 operations.`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const REF_RE = /^#?op\s*#?\s*(\d+)$/i;

function parseRefValue(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  if (typeof v === "string") {
    const m = v.trim().match(REF_RE);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

function summarizeInput(input: Record<string, any>): string {
  return String(input.trackerName || input.title || input.description || input.name || "operation");
}

/** Validate + normalize whatever the model returned. Drops non-whitelisted
 * tools and malformed rows; validates ref targets; caps the total. */
export function parseExtractedPlan(toolInput: any): { ops: MegaPlanOp[]; warnings: string[] } {
  const rows = Array.isArray(toolInput?.operations) ? toolInput.operations : [];
  const ops: MegaPlanOp[] = [];
  const warnings: string[] = [];
  const total = Math.min(rows.length, MAX_MEGA_OPERATIONS);
  if (rows.length > MAX_MEGA_OPERATIONS) {
    warnings.push(`Plan had ${rows.length} operations; capped at ${MAX_MEGA_OPERATIONS}.`);
  }
  for (let i = 0; i < total; i++) {
    const row = rows[i];
    const originalIndex = i + 1;
    if (!row || typeof row !== "object") continue;
    const tool = String(row.tool || "");
    if (!(MEGA_ACTION_TOOLS as readonly string[]).includes(tool)) {
      warnings.push(`Dropped operation #${originalIndex}: tool "${tool}" is not allowed in a plan.`);
      continue;
    }
    if (!row.input || typeof row.input !== "object" || Array.isArray(row.input)) continue;

    const refs: Record<string, number> = {};
    if (row.refs && typeof row.refs === "object" && !Array.isArray(row.refs)) {
      for (const [field, v] of Object.entries(row.refs)) {
        const target = parseRefValue(v);
        if (target == null || target === originalIndex || target > total) {
          warnings.push(`Operation #${originalIndex}: dropped invalid reference ${JSON.stringify(v)} for "${field}".`);
          continue;
        }
        refs[field] = target;
      }
    }
    const dependsOn: number[] = [];
    if (Array.isArray(row.dependsOn)) {
      for (const v of row.dependsOn) {
        const target = parseRefValue(v);
        if (target == null || target === originalIndex || target > total) continue;
        dependsOn.push(target);
      }
    }

    ops.push({
      originalIndex,
      tool: tool as MegaActionTool,
      input: row.input as Record<string, any>,
      raw: typeof row.raw === "string" && row.raw.trim() ? row.raw.trim() : summarizeInput(row.input),
      section: sectionForOp(tool, typeof row.section === "string" ? row.section : null),
      refs,
      dependsOn,
    });
  }
  return { ops, warnings };
}

// ---------------------------------------------------------------------------
// Cross-section dedupe + dependency ordering
// ---------------------------------------------------------------------------

/** Payment-shaped creates that can collide across sections (the same $74.99
 * internet charge requested as both a "bill" and a "liability"). */
const PAYMENT_TOOLS = new Set<string>(["create_liability", "create_obligation"]);

/** Preference order when payment-shaped twins merge: the liability record is
 * the canonical one (bills ARE liabilities in this app). */
const PAYMENT_SURVIVOR_RANK: Record<string, number> = {
  create_liability: 0,
  create_obligation: 1,
  create_expense: 2,
};

const IDENTITY_NOISE_RE =
  /\b(bill|bills|liability|liabilities|payment|payments|subscription|subscriptions|plan|service|monthly|weekly|yearly|annual|recurring|fee|charge|expense|due)\b/g;

function slugIdentity(name: unknown): string {
  return String(name || "")
    .toLowerCase()
    .replace(IDENTITY_NOISE_RE, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");
}

function centsOf(v: unknown): string {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? String(Math.round(n * 100)) : "";
}

function cadenceOf(input: Record<string, any>): string {
  const freq = String(input.frequency || input.recurrence || input.billingCycle || "").toLowerCase().replace(/[^a-z]/g, "");
  const day = input.dueDay ?? input.dayOfMonth ?? input.dueDate ?? input.nextDueDate ?? "";
  return `${freq}|${String(day)}`;
}

function nameOf(input: Record<string, any>): string {
  return String(input.name || input.title || input.description || "");
}

function stableStringify(v: any): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}

/** Identity key for the pre-execution dedupe pass, in the spirit of
 * calendar-occurrences' seriesIdentityKey: same normalized name + amount +
 * cadence ⇒ the same real-world record, whatever section it was phrased
 * under. Returns null for ops that should never merge. */
export function megaOpIdentity(op: MegaPlanOp): string | null {
  const input = op.input || {};
  if (PAYMENT_TOOLS.has(op.tool)) {
    const slug = slugIdentity(nameOf(input));
    if (!slug) return null;
    return `pay:${slug}|${centsOf(input.amount ?? input.paymentAmount ?? input.monthlyPayment)}|${cadenceOf(input)}`;
  }
  switch (op.tool) {
    case "create_event": {
      const slug = slugIdentity(input.title || input.name);
      return slug ? `event:${slug}|${String(input.date || input.startDate || "")}` : null;
    }
    case "create_reminder": {
      const slug = slugIdentity(input.title || input.name);
      return slug ? `reminder:${slug}|${String(input.date || input.dueDate || "")}` : null;
    }
    case "create_task": {
      const slug = slugIdentity(input.title || input.name);
      return slug ? `task:${slug}|${String(input.dueDate || "")}` : null;
    }
    case "create_habit": {
      const slug = slugIdentity(input.name || input.title);
      return slug ? `habit:${slug}` : null;
    }
    case "create_profile": {
      const slug = slugIdentity(input.name);
      return slug ? `profile:${slug}|${String(input.type || "")}` : null;
    }
    case "log_tracker_entry": {
      const key = trackerIdentityKey(String(input.trackerName || ""));
      return key ? `tracker:${key}|${stableStringify(input.values ?? {})}|${String(input.at || "")}` : null;
    }
    case "create_expense": {
      // Only recurring-shaped expenses can collide with bills/liabilities.
      if (!input.frequency && !input.recurring && !input.billingCycle) return null;
      const slug = slugIdentity(nameOf(input));
      return slug ? `pay:${slug}|${centsOf(input.amount)}|${cadenceOf(input)}` : null;
    }
    default:
      return null;
  }
}

function dedupeExplanation(dropped: MegaPlanOp, survivor: MegaPlanOp): string {
  if (PAYMENT_TOOLS.has(dropped.tool) || PAYMENT_TOOLS.has(survivor.tool)) {
    const recurring = /monthly|weekly|yearly|annual|biweekly|quarterly/i.test(String(survivor.input?.frequency || dropped.input?.frequency || ""));
    return `"${nameOf(dropped.input) || dropped.raw}" and "${nameOf(survivor.input) || survivor.raw}" are the same ${recurring ? "recurring payment" : "payment"} — saved once as a single record.`;
  }
  return `Duplicate of "${nameOf(survivor.input) || survivor.raw}" — saved once.`;
}

/** Dedupe colliding ops, remap refs onto survivors, and order by dependency
 * (Kahn's toposort; cycles break by dropping the offending edge; ties keep
 * message order). Pure. */
export function normalizeMegaPlan(parsed: MegaPlanOp[]): MegaPlanNormalized {
  const warnings: string[] = [];
  const preseededOutcomes: OperationOutcome[] = [];
  const aliasMap: Record<number, number> = {};

  // ── Dedupe ──
  const byIdentity = new Map<string, MegaPlanOp>();
  const survivors: MegaPlanOp[] = [];
  for (const op of parsed) {
    const identity = megaOpIdentity(op);
    const twin = identity ? byIdentity.get(identity) : undefined;
    if (!twin) {
      if (identity) byIdentity.set(identity, op);
      survivors.push(op);
      continue;
    }
    // Decide which of the pair survives (liability > obligation > expense;
    // otherwise first mention wins).
    const rankNew = PAYMENT_SURVIVOR_RANK[op.tool] ?? 99;
    const rankOld = PAYMENT_SURVIVOR_RANK[twin.tool] ?? 99;
    let survivor = twin;
    let dropped = op;
    if (rankNew < rankOld) {
      // The later op is the stronger record type — it takes the twin's slot
      // (and its position in message order).
      survivor = op;
      dropped = twin;
      const idx = survivors.indexOf(twin);
      if (idx >= 0) survivors[idx] = op;
      byIdentity.set(identity!, op);
    }
    // Union inputs: survivor's fields win; dropped op fills gaps.
    for (const [k, v] of Object.entries(dropped.input || {})) {
      if (survivor.input[k] == null && v != null) survivor.input[k] = v;
    }
    for (const [field, target] of Object.entries(dropped.refs)) {
      if (survivor.refs[field] == null) survivor.refs[field] = target;
    }
    survivor.dependsOn = Array.from(new Set([...survivor.dependsOn, ...dropped.dependsOn]));
    aliasMap[dropped.originalIndex] = survivor.originalIndex;
    preseededOutcomes.push({
      index: dropped.originalIndex - 1,
      raw: dropped.raw,
      tool: dropped.tool,
      status: "deduped",
      section: dropped.section,
      detail: dedupeExplanation(dropped, survivor),
    });
  }

  // Chase alias chains (a→b, b→c ⇒ a→c) so executor lookups are one hop.
  for (const key of Object.keys(aliasMap)) {
    let target = aliasMap[Number(key)];
    while (aliasMap[target] != null) target = aliasMap[target];
    aliasMap[Number(key)] = target;
  }
  const resolveAlias = (n: number): number => aliasMap[n] ?? n;

  // Refs/dependsOn pointing at dropped ops now point at their survivors.
  for (const op of survivors) {
    for (const field of Object.keys(op.refs)) op.refs[field] = resolveAlias(op.refs[field]);
    op.dependsOn = Array.from(new Set(op.dependsOn.map(resolveAlias))).filter((n) => n !== op.originalIndex);
  }

  // ── Toposort (Kahn's) — ties keep message order ──
  const byOriginal = new Map<number, MegaPlanOp>(survivors.map((o) => [o.originalIndex, o]));
  const edgesOf = (op: MegaPlanOp): number[] =>
    Array.from(new Set([...Object.values(op.refs), ...op.dependsOn])).filter((n) => byOriginal.has(n));

  const indegree = new Map<number, number>();
  const dependents = new Map<number, number[]>();
  for (const op of survivors) {
    indegree.set(op.originalIndex, 0);
  }
  for (const op of survivors) {
    for (const dep of edgesOf(op)) {
      indegree.set(op.originalIndex, (indegree.get(op.originalIndex) || 0) + 1);
      const list = dependents.get(dep) || [];
      list.push(op.originalIndex);
      dependents.set(dep, list);
    }
  }

  const ordered: MegaPlanOp[] = [];
  const ready = survivors.filter((o) => (indegree.get(o.originalIndex) || 0) === 0).map((o) => o.originalIndex);
  // Min-heap behavior via sort — plans are ≤80 ops, so O(n² log n) is fine.
  while (ready.length > 0) {
    ready.sort((a, b) => a - b);
    const next = ready.shift()!;
    ordered.push(byOriginal.get(next)!);
    for (const dep of dependents.get(next) || []) {
      indegree.set(dep, (indegree.get(dep) || 0) - 1);
      if ((indegree.get(dep) || 0) === 0) ready.push(dep);
    }
  }
  if (ordered.length < survivors.length) {
    // Cycle: break it by appending the leftovers in message order with their
    // unmet edges ignored (the executor treats a missing ref as a skip, and
    // a warning tells the user why).
    const placed = new Set(ordered.map((o) => o.originalIndex));
    const leftovers = survivors.filter((o) => !placed.has(o.originalIndex)).sort((a, b) => a.originalIndex - b.originalIndex);
    for (const op of leftovers) {
      warnings.push(`Operation #${op.originalIndex} ("${op.raw}") is part of a circular dependency — running it in message order.`);
      ordered.push(op);
    }
  }

  return { ops: ordered, preseededOutcomes, aliasMap, warnings };
}

// ---------------------------------------------------------------------------
// Sectioned reply
// ---------------------------------------------------------------------------

export interface MegaValidationSummary {
  /** OK outcomes whose row was re-read from the database. */
  verifiedSaves: number;
  totalOk: number;
  /** Recurring records checked / confirmed to generate a future occurrence. */
  recurrenceChecked: number;
  recurrenceConfirmed: number;
  /** Human-readable duplicate warnings surfaced by the write envelopes. */
  duplicateWarnings: string[];
  /** True when budget ran out and a remainder can be resumed with "continue". */
  continueHint?: boolean;
}

function opLabel(o: OperationOutcome): string {
  const name = o.trackerName || o.raw || o.tool;
  return o.detail && o.status !== "deduped" ? `${name} — ${o.detail}` : name;
}

/** Deterministic sectioned reply — never claims more or less than what
 * actually happened, grouped the way the dashboard is organized. */
export function buildMegaReply(
  outcomes: OperationOutcome[],
  validation?: MegaValidationSummary,
  extraWarnings?: string[],
): string {
  const ok = outcomes.filter((o) => o.status === "ok");
  const failed = outcomes.filter((o) => o.status === "failed");
  const skipped = outcomes.filter((o) => o.status === "skipped");

  const lines: string[] = [];
  if (failed.length === 0 && skipped.length === 0) {
    lines.push(`I processed your request as ${outcomes.length} separate operations and updated each section. Documents were skipped.`);
  } else {
    lines.push(
      `I processed your request as ${outcomes.length} separate operations: ${ok.length} saved` +
        (failed.length ? `, ${failed.length} failed` : "") +
        (skipped.length ? `, ${skipped.length} not run` : "") +
        `. Documents were skipped. Details by section:`,
    );
  }

  const bySection = new Map<MegaSection, OperationOutcome[]>();
  for (const o of outcomes) {
    const section = sectionForOp(o.tool, o.section);
    const list = bySection.get(section) || [];
    list.push(o);
    bySection.set(section, list);
  }

  for (const section of MEGA_SECTIONS) {
    const list = bySection.get(section);
    if (!list || list.length === 0) continue;
    lines.push("");
    lines.push(`**${SECTION_LABELS[section]}**`);
    const note = DERIVED_SECTION_NOTES[section];
    if (note) lines.push(note);
    for (const o of list) {
      switch (o.status) {
        case "ok":
          lines.push(`✅ ${opLabel(o)}${o.recurrenceVerified === false ? " (couldn't confirm future occurrences — check its schedule)" : ""}`);
          break;
        case "deduped":
          lines.push(`↩️ ${o.raw} — ${o.detail || "already saved once, not duplicated"}`);
          break;
        case "failed":
          lines.push(`✗ ${opLabel(o)} — ${o.error || "failed"}`);
          break;
        case "skipped":
          lines.push(`⏸ ${opLabel(o)} — ${o.error || "not run"}`);
          break;
      }
    }
  }

  const footer: string[] = [];
  if (validation) {
    const bits: string[] = [];
    if (validation.totalOk > 0) {
      bits.push(
        validation.verifiedSaves >= validation.totalOk
          ? `All ${validation.totalOk} saves verified in the database`
          : `${validation.verifiedSaves} of ${validation.totalOk} saves verified in the database`,
      );
    }
    if (validation.recurrenceChecked > 0) {
      bits.push(
        validation.recurrenceConfirmed >= validation.recurrenceChecked
          ? `recurrence confirmed for ${validation.recurrenceChecked} recurring record${validation.recurrenceChecked === 1 ? "" : "s"}`
          : `recurrence confirmed for ${validation.recurrenceConfirmed} of ${validation.recurrenceChecked} recurring records`,
      );
    }
    if (validation.duplicateWarnings.length === 0) bits.push("no duplicates created");
    if (bits.length > 0) footer.push(`Validation: ${bits.join(" · ")}.`);
    for (const w of validation.duplicateWarnings) footer.push(`⚠️ ${w}`);
    if (validation.continueHint) {
      footer.push(`I ran out of time before finishing everything — say "continue" and I'll pick up where I left off.`);
    }
  }
  for (const w of extraWarnings || []) footer.push(`⚠️ ${w}`);
  if (footer.length > 0) {
    lines.push("");
    lines.push(...footer);
  }

  if (outcomes.length === 0) return "I couldn't extract any operations from that — try rephrasing?";
  return lines.join("\n");
}
