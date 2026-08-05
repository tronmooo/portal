// ── What will be saved, and where ───────────────────────────────────────────
//
// One description of a confirm-extraction save, shared by the review screen the
// user reads before pressing Save and by the route that performs it.
//
// Bug report 2026-08-05 (receipt with a $50 total): the user unticked every
// extracted row — merchant, date, category, the profile fields — because all
// they wanted was the $50 expense. The Confirm button went dead: it was gated
// on `fields.every(f => !f.selected)`, i.e. on the PROFILE-extraction
// checklist, not on whether the user had chosen anything to DO. Selecting a
// destination (expense / profile / document) is the real precondition, so the
// gate now asks this module.
//
// The plan is built from the exact request payload the client is about to POST,
// so the review screen cannot drift from what the server receives — if a line
// isn't in the payload it cannot appear in the review, and anything the user
// deselected is absent from both.

export type SaveActionId = "profile" | "document" | "expense" | "obligation" | "calendar" | "tracker";

export interface ConfirmExtractionExpense {
  description?: string;
  amount?: unknown;
  category?: string;
  date?: string;
  vendor?: string;
  /** Owner/profile the expense is attributed to. Falls back to the extraction's profile. */
  profileId?: string;
}

export interface ConfirmExtractionObligation {
  name?: string;
  amount?: unknown;
  frequency?: string;
  category?: string;
  nextDueDate?: string;
}

/** The POST /api/chat/confirm-extraction body, as far as the plan cares. */
export interface ConfirmExtractionPayload {
  extractionId?: string;
  confirmedFields?: Array<{ key: string; value: any }>;
  targetProfileId?: string;
  /** Write the confirmed fields onto the target profile. Default true. */
  saveToProfile?: boolean;
  /** Keep the original file as a document with the confirmed values on it. Default true. */
  saveDocument?: boolean;
  createCalendarEvents?: Array<{ field?: string; date?: string; title?: string; category?: string }>;
  trackerEntries?: Array<{ trackerName?: string; values?: Record<string, any>; unit?: string }>;
  createExpense?: ConfirmExtractionExpense | null;
  createObligation?: ConfirmExtractionObligation | null;
}

export interface SavePlanContext {
  /** Display name of the profile the fields (and expense) are attributed to. */
  profileName?: string;
  /** Display name of the uploaded file / document. */
  documentLabel?: string;
  /** key → human label, so the review reads like the checklist above it. */
  fieldLabels?: Record<string, string>;
  /** Labels of the rows the user turned OFF — surfaced as "not saved". */
  deselectedLabels?: string[];
}

export interface SaveDestination {
  id: SaveActionId;
  /** Where the data lands, e.g. "Profile · Robert's Honda CR-V". */
  where: string;
  /** One line saying what happens there. */
  summary: string;
  /** The exact values that will be written. */
  items: string[];
}

export interface SavePlan {
  destinations: SaveDestination[];
  /** Destination actions the user actually selected, in render order. */
  actions: SaveActionId[];
  /** True when at least one valid destination action is selected. */
  canSave: boolean;
  /** Selected-but-unusable actions, e.g. an expense with no amount. */
  blockers: string[];
  /** Extracted rows the user deselected — stated so a partial save is visible. */
  notSaved: string[];
}

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function parseAmount(raw: unknown): number | null {
  if (typeof raw === "number") return isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const n = parseFloat(raw.replace(/[$,\s]/g, ""));
  return isFinite(n) ? n : null;
}

/** Values arrive either plain or wrapped as {value, confidence}. */
export function unwrapFieldValue(v: any): any {
  return v && typeof v === "object" && !Array.isArray(v) && "value" in v ? (v as any).value : v;
}

export function formatFieldValue(v: any): string {
  const raw = unwrapFieldValue(v);
  if (raw === null || raw === undefined || raw === "") return "—";
  if (typeof raw === "object") {
    try {
      return Object.entries(raw)
        .map(([k, val]) => `${k}: ${val}`)
        .join(", ");
    } catch {
      return String(raw);
    }
  }
  return String(raw);
}

const humanize = (key: string) =>
  key
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());

/**
 * Turn the request payload into the list of destinations it will write to.
 * Only selected, usable actions become destinations — an expense with a
 * missing amount is reported as a blocker instead of being counted.
 */
export function buildSavePlan(
  payload: ConfirmExtractionPayload,
  ctx: SavePlanContext = {},
): SavePlan {
  const destinations: SaveDestination[] = [];
  const blockers: string[] = [];

  const fields = (payload.confirmedFields || []).filter((f) => f && f.key);
  const labelFor = (key: string) => ctx.fieldLabels?.[key] || humanize(key);
  const profileName = ctx.profileName || "your profile";
  const docLabel = ctx.documentLabel || "the uploaded file";

  // 1. Profile — the extracted values the user kept ticked. With
  // saveToProfile off the kept values stay on the document only; that is a
  // deliberate choice, not an error, so no destination is listed for it.
  if (payload.saveToProfile !== false && fields.length > 0) {
    destinations.push({
      id: "profile",
      where: `Profile · ${profileName}`,
      summary: `${fields.length} field${fields.length === 1 ? "" : "s"} saved to this profile`,
      items: fields.map((f) => `${labelFor(f.key)}: ${formatFieldValue(f.value)}`),
    });
  }

  // 2. Document — the original receipt/photo, with the kept values on it.
  if (payload.saveDocument !== false) {
    const items = [`Original file: ${docLabel}`];
    items.push(
      fields.length > 0
        ? `${fields.length} extracted value${fields.length === 1 ? "" : "s"} attached to the document`
        : "No extracted values attached",
    );
    if (payload.targetProfileId) items.push(`Linked to ${profileName}`);
    destinations.push({
      id: "document",
      where: "Documents",
      summary: "The original is kept as a document",
      items,
    });
  }

  // 3. Expense — the whole point of the $50-only case.
  if (payload.createExpense) {
    const exp = payload.createExpense;
    const amount = parseAmount(exp.amount);
    if (amount === null || amount <= 0) {
      blockers.push("The expense needs an amount greater than 0.");
    } else {
      const items = [`Amount: ${money(amount)}`];
      if (exp.category) items.push(`Category: ${humanize(exp.category)}`);
      if (exp.date) items.push(`Date: ${exp.date}`);
      items.push(`Owner: ${ctx.profileName || "your profile"}`);
      if (exp.vendor) items.push(`Merchant: ${exp.vendor}`);
      if (exp.description) items.push(`Description: ${exp.description}`);
      destinations.push({
        id: "expense",
        where: "Finance · Expenses",
        summary: `A ${money(amount)} expense is created`,
        items,
      });
    }
  }

  // 4. Recurring bill.
  if (payload.createObligation) {
    const obl = payload.createObligation;
    const amount = parseAmount(obl.amount);
    if (amount === null || amount <= 0) {
      blockers.push("The recurring bill needs an amount greater than 0.");
    } else if (!obl.nextDueDate) {
      blockers.push("The recurring bill needs a next due date.");
    } else {
      destinations.push({
        id: "obligation",
        where: "Finance · Recurring bills",
        summary: `${money(amount)} ${obl.frequency || "monthly"} bill`,
        items: [
          `Name: ${obl.name || "Bill"}`,
          `Amount: ${money(amount)}`,
          `Next due: ${obl.nextDueDate}`,
        ],
      });
    }
  }

  // 5. Calendar events.
  const events = (payload.createCalendarEvents || []).filter((e) => e && e.date);
  if (events.length > 0) {
    destinations.push({
      id: "calendar",
      where: "Calendar",
      summary: `${events.length} event${events.length === 1 ? "" : "s"} created`,
      items: events.map((e) => `${e.title || humanize(String(e.field || "Event"))} — ${e.date}`),
    });
  }

  // 6. Tracker entries.
  const trackers = (payload.trackerEntries || []).filter(Boolean);
  if (trackers.length > 0) {
    destinations.push({
      id: "tracker",
      where: "Trackers",
      summary: `${trackers.length} entr${trackers.length === 1 ? "y" : "ies"} logged`,
      items: trackers.map((t) => {
        const vals = Object.values(t.values || {}).join(", ");
        return `${humanize(String(t.trackerName || "Entry"))}: ${vals}${t.unit ? ` ${t.unit}` : ""}`;
      }),
    });
  }

  const actions = destinations.map((d) => d.id);
  return {
    destinations,
    actions,
    canSave: actions.length > 0,
    blockers,
    notSaved: ctx.deselectedLabels ? [...ctx.deselectedLabels] : [],
  };
}

/**
 * Server-side gate. The question is "did the user pick at least one thing to
 * do?" — NOT "did the user tick at least one extracted field". Saving only a
 * total as an expense, with every extracted field deselected, is a complete and
 * valid request.
 */
export function selectedSaveActions(payload: ConfirmExtractionPayload): SaveActionId[] {
  return buildSavePlan(payload).actions;
}

export function hasSelectedSaveAction(payload: ConfirmExtractionPayload): boolean {
  return selectedSaveActions(payload).length > 0;
}
