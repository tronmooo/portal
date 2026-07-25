// ── Recurring occurrence identity + routing (2026-07-25) ─────────────────────
// Pure, no I/O. The single place that answers two questions about a recurring
// occurrence:
//
//   1. WHO OWNS IT?   Every occurrence is a generated instance of a parent
//                     object — a liability profile, a person's profile, a
//                     calendar series. It is never a free-standing record with
//                     a destination of its own.
//   2. WHERE DOES TAPPING IT GO?  Always the parent's detail page. Never a
//                     collection screen (the Bills list, the Tasks list, the
//                     calendar grid), because a collection cannot answer
//                     "what did I just tap?" — which is exactly why tapping a
//                     ChatGPT Pro occurrence and landing on Bills felt like
//                     nothing happened.
//
// The mental model this encodes:
//
//     parent profile  ──owns──▶  recurrence rule
//                                     │ generates
//                                     ▼
//                                occurrences  ──displayed by──▶  calendar
//
// The calendar renders occurrences; it never owns them. Completing, skipping,
// or deleting an occurrence is a write against the PARENT, which is why every
// surface updates at once.
//
// Pinned by tests/occurrence-routing.test.ts.

// ─── Occurrence model ─────────────────────────────────────────────────────────

/**
 * The kind of object that OWNS an occurrence. This is the parent's identity,
 * not the occurrence's — "liability" means the occurrence belongs to a
 * liability profile, so selecting it opens that liability.
 */
export type OccurrenceSourceType =
  | "liability"   // recurring bill / subscription / loan → liability profile
  | "profile"     // birthday, anniversary, renewal read off a profile's fields
  | "event"       // a recurring calendar series the user created directly
  | "document"    // a document's expiration date
  | "task"        // a task's due date
  | "goal"        // a goal's target date
  | "reminder";   // a scheduled reminder

/** Per-occurrence lifecycle state. Mirrors what the parent's engine records. */
export type OccurrenceState =
  | "upcoming"
  | "today"
  | "overdue"
  | "completed"
  | "skipped"
  | "deleted";

/**
 * A section within the parent's profile to open alongside it, so a birthday
 * occurrence lands on the Birthday section rather than the top of the page.
 */
export type ParentSection =
  | "birthday"
  | "anniversary"
  | "recurring"
  | "payments"
  | "documents";

/**
 * The canonical shape every recurring occurrence carries, whichever system
 * generated it. `sourceType` + `sourceId` are the parent pointer; the rest
 * describes this one instance.
 */
export interface RecurringOccurrence {
  /** Parent object kind — decides which detail page opens. */
  sourceType: OccurrenceSourceType;
  /** Parent object id. For liabilities this is the liability PROFILE id. */
  sourceId: string;
  /** ISO YYYY-MM-DD of this instance. */
  occurrenceDate: string;
  /** This instance's state — independent of every sibling occurrence. */
  status: OccurrenceState;
  /**
   * Human-readable description of the rule that generated it, e.g.
   * "monthly on day 30". Present so an occurrence can always explain itself
   * without the UI re-deriving the rule.
   */
  generatedFromRule: string;
  /** Optional section of the parent page to reveal on arrival. */
  parentSection?: ParentSection;
}

// ─── Routing ──────────────────────────────────────────────────────────────────

/**
 * Collection routes. An occurrence must NEVER resolve to one of these: they
 * are list screens, not detail screens, so arriving there loses the identity of
 * the thing that was tapped. Exported so tests can assert the invariant.
 */
export const COLLECTION_ROUTES: readonly string[] = [
  "/obligations",
  "/bills",
  "/dashboard/obligations",
  "/tasks",
  "/dashboard/tasks",
  "/goals",
  "/dashboard/goals",
  "/documents",
  "/calendar",
  "/liabilities",
  "/trackers",
  "/profiles",
];

/**
 * True when `href` drops the user on a list with no idea which row they came
 * from. A list path carrying `focus` (and optionally `on`) is NOT a collection
 * route: those params name the exact item and date, so the destination can
 * scroll to it and open it — identity survives the navigation.
 */
export function isCollectionRoute(href: string): boolean {
  const raw = String(href || "").replace(/^#/, "");
  const [rawPath, query = ""] = raw.split("?");
  const path = rawPath.replace(/\/+$/, "") || "/";
  if (!COLLECTION_ROUTES.includes(path)) return false;
  const params = new URLSearchParams(query);
  return !params.get("focus") && !params.get("section");
}

/** Where a parent object's detail page lives. */
function parentPath(sourceType: OccurrenceSourceType, sourceId: string): string {
  switch (sourceType) {
    // Liabilities ARE profiles (a recurring bill is a liability profile whose
    // recurrence lives in its fields), so both resolve to the profile route —
    // which dispatches to the liability detail view by type.
    case "liability":
    case "profile":
      return `/profiles/${sourceId}`;
    case "document":
      return `/documents/${sourceId}`;
    // An event series owns itself. There is no standalone event page, so it
    // opens on the calendar FOCUSED on that series rather than as a bare grid.
    case "event":
      return `/calendar`;
    case "task":
      return `/tasks`;
    case "goal":
      return `/goals`;
    case "reminder":
      return `/calendar`;
  }
}

export interface OccurrenceTarget {
  /** Hash href for wouter's hash router, e.g. "#/profiles/abc?section=birthday". */
  href: string;
  /** Path without the leading "#", for `navigate()`. */
  path: string;
  sourceType: OccurrenceSourceType;
  sourceId: string;
}

/**
 * Resolve where selecting an occurrence goes: always its parent object.
 *
 *   ChatGPT Pro occurrence  → #/profiles/<chatgpt-pro-liability-id>
 *   Netflix occurrence      → #/profiles/<netflix-liability-id>
 *   Joe's birthday          → #/profiles/<joe-id>?section=birthday
 *
 * Types with no standalone detail page (event series, tasks, goals, reminders)
 * carry a `focus` query so the destination scrolls to and highlights the exact
 * item — the screen is shared, the target is not.
 */
export function resolveOccurrenceTarget(
  occ: Pick<RecurringOccurrence, "sourceType" | "sourceId"> & {
    parentSection?: ParentSection;
    occurrenceDate?: string;
  },
): OccurrenceTarget {
  const sourceId = String(occ.sourceId || "");
  let path = parentPath(occ.sourceType, sourceId);
  const params = new URLSearchParams();

  if (occ.parentSection) params.set("section", occ.parentSection);
  // Shared destinations need the item id to single out the occurrence's parent;
  // dedicated detail pages already have it in the path.
  if (sourceId && (occ.sourceType === "event" || occ.sourceType === "task"
    || occ.sourceType === "goal" || occ.sourceType === "reminder")) {
    params.set("focus", sourceId);
    if (occ.occurrenceDate) params.set("on", occ.occurrenceDate);
  }

  const qs = params.toString();
  if (qs) path = `${path}?${qs}`;
  return { href: `#${path}`, path, sourceType: occ.sourceType, sourceId };
}

/**
 * The profile section a date-driven occurrence should reveal. Birthdays open
 * the Birthday section, anniversaries the Anniversary section, everything else
 * the profile's Recurring Dates section.
 */
export function sectionForCategory(category: string | null | undefined): ParentSection | undefined {
  const c = String(category || "").toLowerCase();
  if (c.includes("birthday")) return "birthday";
  if (c.includes("anniversary")) return "anniversary";
  return undefined;
}

// ─── Default generation horizons ──────────────────────────────────────────────
//
// How far ahead each kind of recurrence materializes by default. These are
// FIXED rules, not inferred per item — a subscription always generates a
// rolling 12 months, a birthday always 5 years — so the same liability
// produces the same dates on every surface. The user can extend or regenerate
// afterwards; nothing here is a ceiling.

export type GenerationKind =
  | "subscription" | "bill" | "loan_payment" | "birthday" | "anniversary"
  | "medication_refill" | "maintenance" | "appointment" | "renewal" | "custom";

export interface GenerationRule {
  /** Months of occurrences to generate up front. */
  months: number;
  /** Short label for the UI ("12 months", "5 years"). */
  label: string;
  /**
   * True when the horizon is bounded by the parent's own end date (a loan
   * stops at payoff) rather than by a rolling window.
   */
  boundedByParent?: boolean;
}

const YEAR = 12;

export const DEFAULT_GENERATION_RULES: Record<GenerationKind, GenerationRule> = {
  subscription:      { months: 12,         label: "12 months" },
  bill:              { months: 12,         label: "12 months" },
  // A loan generates until its payoff date; the 12-month figure is only the
  // display window when no payoff date is known.
  loan_payment:      { months: 12,         label: "until payoff", boundedByParent: true },
  birthday:          { months: 5 * YEAR,   label: "5 years" },
  anniversary:       { months: 5 * YEAR,   label: "5 years" },
  medication_refill: { months: 12,         label: "12 months" },
  maintenance:       { months: 12,         label: "12 months" },
  appointment:       { months: 12,         label: "12 months" },
  renewal:           { months: 12,         label: "12 months" },
  custom:            { months: 12,         label: "12 months" },
};

/** Map any category/kind token onto a generation kind. Never guesses beyond
 *  this table — unrecognized kinds fall back to the 12-month default. */
export function generationKindFor(kind: string | null | undefined): GenerationKind {
  const k = String(kind || "").toLowerCase();
  if (k.includes("birthday")) return "birthday";
  if (k.includes("anniversary")) return "anniversary";
  if (k.includes("subscription")) return "subscription";
  if (k.includes("loan") || k.includes("credit_card") || k.includes("mortgage")) return "loan_payment";
  if (k.includes("medication") || k.includes("prescription") || k.includes("refill")) return "medication_refill";
  if (k.includes("maintenance") || k.includes("service") || k.includes("inspection")) return "maintenance";
  if (k.includes("appointment")) return "appointment";
  if (k.includes("renewal") || k.includes("registration") || k.includes("membership")) return "renewal";
  if (k.includes("bill") || k.includes("payment") || k.includes("insurance")) return "bill";
  return "custom";
}

/** Months of occurrences to generate for a kind. */
export function generationMonths(kind: string | null | undefined): number {
  return DEFAULT_GENERATION_RULES[generationKindFor(kind)].months;
}

/** The rule (months + label) for a kind — for UI that explains the horizon. */
export function generationRule(kind: string | null | undefined): GenerationRule {
  return DEFAULT_GENERATION_RULES[generationKindFor(kind)];
}
