// shared/calendar-adapters.ts — every system, one shape.
//
// The calendar is the single source of truth for every date in the app, which
// is only possible if every system's records arrive in ONE normalized form.
// Each adapter here converts one system's rows into `CalendarSeries`
// (shared/calendar-occurrences); nothing downstream ever touches a raw event,
// obligation, profile field or task again.
//
// The adapters are also where SHADOW records are declared. A birthday typed in
// as a recurring calendar event is a shadow of the profile's date-of-birth
// field: both are real records, but only one of them is the thing to edit.
// Marking the event `shadow: true` is what makes `dedupeSeries` collapse the
// pair — the bug where Joe's birthday rendered twice with two different next
// dates.
//
// Pure, dependency-free. Pinned by tests/calendar-adapters.test.ts.

import {
  type CalendarSeries,
  type OccurrenceKind,
  type SourceSystem,
  sourceHref,
} from "./calendar-occurrences";
import { parseRecurringMeta, expandRecurrenceDates } from "./recurring-dates";
import { addYearsISO } from "./date-math";
import { canonicalObligationCategory } from "./category-canon";
import { resolveBillingModel, resolveOccurrenceAmount } from "./liability-billing";
import { groupMaterializedSeries } from "./series-detect";
import { rulesFromAll, seriesFromDateRules } from "./date-rules";
import { normalizeDateString } from "./extraction-normalize";

const ISO_RE = /^\d{4}-\d{2}-\d{2}/;
const clip = (v: unknown): string => String(v ?? "").slice(0, 10);
const isISO = (v: unknown): boolean => ISO_RE.test(clip(v));

/** Compact a list of maybe-ids into unique, non-empty strings. */
function uniq(ids: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id === "string" && id && !out.includes(id)) out.push(id);
  }
  return out;
}


/**
 * Never show a database property name to a user.
 *
 * User report 2026-07-25: the page listed a card titled
 * "date Of Birth: 03/12/2034". Some writer had created an event whose title
 * was a raw field dump. Such records no longer reach the recurring screen
 * (they do not repeat), but a title is displayed on the calendar grid too, so
 * the humanising happens at the adapter — one place, every surface.
 *
 * "dateOfBirth: 03/12/2034" -> "Date Of Birth"
 * "expiration_date"         -> "Expiration Date"
 */
export function humanizeTitle(raw: unknown, fallback = "Untitled"): string {
  const text = String(raw ?? "").trim();
  if (!text) return fallback;
  // Only rewrite things that actually look like `key: value` field dumps —
  // a real title such as "Rent: due Friday" keeps its wording.
  const m = text.match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/);
  const key = m ? m[1] : text;
  const looksLikeFieldName =
    /^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(key) || /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(key);
  if (!looksLikeFieldName) return text;
  const words = key
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.join(" ") || fallback;
}


/**
 * Pull a money amount out of a title, returning the cleaned title.
 *
 * User report 2026-07-25: "Lubi why is there a duplicate of that". Lubi
 * existed twice — once as a subscription obligation ("Lubi", $10) and once as
 * a hand-created recurring event titled "Lubi — $10". They never merged for
 * two reasons, and this fixes the first: the amount was baked into the title,
 * so the normalized slugs were "lubi" and "lubi10" and could never match.
 *
 * Only a TRAILING amount is stripped, so "Rent for $2,500 apartment" keeps its
 * wording while "Netflix — $9.99" becomes "Netflix" + 9.99.
 */
export function parseAmountFromTitle(raw: unknown): { title: string; amount?: number } {
  const text = String(raw ?? "").trim();
  if (!text) return { title: text };
  // "Name — $10", "Name - $9.99", "Name $20", "Name ($15.00)"
  const m = text.match(/^(.*?)[\s]*[-–—:(]?[\s]*\$\s*([\d,]+(?:\.\d{1,2})?)\s*\)?$/);
  if (!m) return { title: text };
  const name = m[1].replace(/[\s\-–—:]+$/, "").trim();
  const amount = Number(m[2].replace(/,/g, ""));
  if (!name || !Number.isFinite(amount)) return { title: text };
  return { title: name, amount };
}

// ─── Kind inference ──────────────────────────────────────────────────────────

/** Map a free-text title/category onto a calendar kind. */
export function inferKindFromText(title: unknown, category?: unknown): OccurrenceKind {
  const t = `${String(title ?? "")} ${String(category ?? "")}`.toLowerCase();
  if (/\bbirthday\b|\bb-?day\b/.test(t)) return "birthday";
  if (/\banniversar/.test(t)) return "anniversary";
  if (/\bsubscription\b|\bstreaming\b|\bmembership\b/.test(t)) return "subscription";
  if (/\bmortgage\b|\bloan\b|\bcredit card\b|\bliabilit/.test(t)) return "liability";
  if (/\bbill\b|\bpayment\b|\brent\b|\butilit/.test(t)) return "bill";
  if (/\brenew|\bregistration\b/.test(t)) return "renewal";
  if (/\bmaintenance\b|\bservice\b|\boil change\b|\binspection\b/.test(t)) return "maintenance";
  if (/\bappointment\b|\bdoctor\b|\bdentist\b|\bvet\b|\bcheck-?up\b/.test(t)) return "appointment";
  return "custom";
}

/** The profile-field keys that carry a person's or pet's birthday. */
const BIRTHDAY_KEYS = /^(birthday|birthdate|birth_date|dob|dateofbirth|date_of_birth)$/i;
const ANNIVERSARY_KEYS = /anniversary/i;

// ─── Profiles: birthdays & anniversaries ─────────────────────────────────────

/**
 * Birthdays and anniversaries carried on a profile's `fields`. These are the
 * AUTHORITATIVE source for those dates — editing a birthday means editing the
 * profile, so `dedupeSeries` prefers these over any typed-in event.
 *
 * Only one birthday series is emitted per profile even if several field
 * spellings are present (`dob` and `birthday` both set), because the identity
 * key is per-profile and the first match wins.
 */
export function seriesFromProfiles(profiles: readonly any[]): CalendarSeries[] {
  const out: CalendarSeries[] = [];
  for (const p of profiles || []) {
    if (!p?.id) continue;
    const fields = p.fields && typeof p.fields === "object" ? p.fields : {};
    const name = p.name || "Unnamed";
    const seenKinds = new Set<OccurrenceKind>();

    const visit = (obj: any, depth: number) => {
      if (!obj || typeof obj !== "object" || depth > 2) return;
      for (const [key, value] of Object.entries(obj)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          visit(value, depth + 1);
          continue;
        }
        if (typeof value !== "string" || !isISO(value)) continue;
        const kind: OccurrenceKind | null = BIRTHDAY_KEYS.test(key)
          ? "birthday"
          : ANNIVERSARY_KEYS.test(key)
            ? "anniversary"
            : null;
        if (!kind || seenKinds.has(kind)) continue;
        seenKinds.add(kind);
        out.push({
          id: `profile:${p.id}:${kind}`,
          kind,
          title: kind === "birthday" ? `${name}'s Birthday` : `${name} — Anniversary`,
          subtitle: name,
          source: {
            system: "profile",
            id: p.id,
            profileId: p.id,
            ownerIds: uniq([p.id, p.parentProfileId]),
            label: name,
            href: sourceHref("profile", p.id, p.id),
          },
          baseDate: clip(value),
          recurrence: "yearly",
        });
      }
    };
    visit(fields, 0);
  }
  return out;
}

// ─── Calendar events ─────────────────────────────────────────────────────────

/**
 * Recurring calendar events, including the ones the Recurring Dates manager
 * creates (they carry `rd:*` tags with per-occurrence state).
 *
 * `knownBirthdayProfiles` / `knownAnniversaryProfiles` are the profile ids that
 * already supply that date from their own fields. An event matching one of
 * those is flagged `shadow` so the profile record wins deduplication — this is
 * precisely the "Joe's birthday appears twice" fix.
 */
export function seriesFromEvents(
  events: readonly any[],
  opts: {
    knownBirthdayProfiles?: ReadonlySet<string>;
    knownAnniversaryProfiles?: ReadonlySet<string>;
    /**
     * `documentId@YYYY-MM-DD` for every date a document already puts on the
     * calendar as a Date Rule.
     *
     * Extraction used to write a standalone event for every date it found, so
     * an uploaded licence produced BOTH `document:…` (derived from the field)
     * and `event:…` (a copy). It no longer does, but accounts are full of the
     * copies. Rather than migrate rows, the copy is marked a SHADOW of the
     * record it was copied from — the same mechanism that collapses a typed-in
     * birthday into the profile's. Matching is by link AND DATE, not by title,
     * so an emoji or a "— Expires" suffix cannot make the pair miss each other
     * — and a "House Viewing" the extractor legitimately created from the same
     * document (a date no rule covers, which routes.ts deliberately still
     * writes) is not swept away with it.
     */
    ruledDocumentDates?: ReadonlySet<string>;
  } = {},
): CalendarSeries[] {
  const out: CalendarSeries[] = [];
  const knownBirthdays = opts.knownBirthdayProfiles ?? new Set<string>();
  const knownAnniversaries = opts.knownAnniversaryProfiles ?? new Set<string>();
  const ruledDocDates = opts.ruledDocumentDates ?? new Set<string>();

  for (const e of events || []) {
    if (!e?.id || !isISO(e.date)) continue;
    const meta = parseRecurringMeta(e.tags);
    // A recurring event carrying a money amount ("Lubi — $10") is somebody
    // tracking a PAYMENT on the calendar. Treat it as one so it shares an
    // identity space with the obligation that already models the same charge,
    // instead of sitting alongside it as a second, unrelated "Event".
    const parsed = parseAmountFromTitle(humanizeTitle(e.title, "Event"));
    const recurs = !!e.recurrence && e.recurrence !== "none";
    const textKind = inferKindFromText(parsed.title, e.category);
    const kind: OccurrenceKind = meta.kind
      ? (meta.kind as OccurrenceKind)
      : parsed.amount != null && recurs
        ? (textKind === "custom" ? "bill" : textKind)
        : textKind;
    const profileId = Array.isArray(e.linkedProfiles) ? e.linkedProfiles[0] : undefined;

    // A typed-in birthday/anniversary for a profile that already carries the
    // date on its own record is a duplicate of it, not a second date.
    const tagList: string[] = Array.isArray(e.tags) ? e.tags : [];
    const autoFromDocument =
      tagList.includes("document-extraction") &&
      // An event the pipeline deliberately created for a date NO rule covers
      // says so, and is never treated as a copy — even when it happens to land
      // on the same day as a derived rule from the same document.
      !tagList.includes("date-rule-uncovered") &&
      (Array.isArray(e.linkedDocuments) ? e.linkedDocuments : [])
        .some((id: any) => ruledDocDates.has(`${String(id)}@${clip(e.date)}`));
    const shadow =
      (kind === "birthday" && !!profileId && knownBirthdays.has(profileId)) ||
      (kind === "anniversary" && !!profileId && knownAnniversaries.has(profileId)) ||
      autoFromDocument;

    out.push({
      id: `event:${e.id}`,
      kind: kind === "custom" && recurs ? "event" : kind,
      title: parsed.title,
      amount: parsed.amount,
      subtitle: e.location || (e.time ? `at ${e.time}` : undefined),
      source: {
        system: "event",
        id: e.id,
        profileId,
        ownerIds: uniq(Array.isArray(e.linkedProfiles) ? e.linkedProfiles : []),
        href: sourceHref("event", e.id, profileId),
      },
      baseDate: clip(e.date),
      recurrence: e.recurrence || "none",
      recurrenceEnd: isISO(e.recurrenceEnd) ? clip(e.recurrenceEnd) : undefined,
      completedDates: meta.completedDates,
      skippedDates: meta.skippedDates,
      paused: meta.paused,
      archived: meta.archived,
      shadow,
    });
  }
  return out;
}

// ─── Obligations: bills, subscriptions, liability payments ───────────────────

/** Obligation `frequency` → the recurrence vocabulary the engine speaks. */
export function frequencyToRecurrence(frequency: unknown): string {
  switch (String(frequency ?? "").toLowerCase()) {
    case "daily": return "daily";
    case "weekly": return "weekly";
    case "biweekly": case "bi-weekly": return "biweekly";
    case "monthly": return "monthly";
    case "yearly": case "annual": case "annually": return "yearly";
    // The engine has no native quarterly step; a quarterly bill is expanded as
    // monthly and thinned by the caller, so we keep it explicit rather than
    // silently mislabelling it as monthly here.
    case "quarterly": return "quarterly";
    case "once": case "one-time": case "": return "none";
    default: return "monthly";
  }
}

export function seriesFromObligations(obligations: readonly any[]): CalendarSeries[] {
  const out: CalendarSeries[] = [];
  for (const o of obligations || []) {
    if (!o?.id || !isISO(o.nextDueDate)) continue;
    if (o.status === "cancelled") continue;
    const category = canonicalObligationCategory(o.category);
    const kind: OccurrenceKind =
      category === "subscription" ? "subscription"
        : category === "loan" ? "liability"
          : inferKindFromText(o.name, o.category) === "custom" ? "bill" : inferKindFromText(o.name, o.category);
    const profileId = Array.isArray(o.linkedProfiles) ? o.linkedProfiles[0] : undefined;
    const liabilityId = o.linkedLiabilityId || undefined;
    out.push({
      id: `obligation:${o.id}`,
      kind,
      title: o.name || "Bill",
      subtitle: category,
      source: {
        system: "obligation",
        id: o.id,
        // A bill backed by a liability profile navigates to that profile —
        // that's the record the user manages, not a list page.
        profileId: liabilityId || profileId,
        // Scope matches on the WHOLE chain: everyone the obligation is linked
        // to, plus the liability and asset it hangs off. Matching only the
        // navigation target hid every payment behind a person filter.
        ownerIds: uniq([
          ...(Array.isArray(o.linkedProfiles) ? o.linkedProfiles : []),
          liabilityId,
          o.linkedAssetId,
        ]),
        label: o.name,
        href: sourceHref("obligation", o.id, liabilityId || profileId),
        // The source-ID duplicate signal: this obligation IS that liability's
        // payment, so the two must share one identity and one occurrence per
        // due date. The link stays visible as metadata on the survivor.
        linkedRecordId: liabilityId || undefined,
        linkedLabel: liabilityId ? "Liability" : undefined,
      },
      baseDate: clip(o.nextDueDate),
      recurrence: frequencyToRecurrence(o.frequency),
      recurrenceEnd: isISO(o.recurrenceEnd) ? clip(o.recurrenceEnd) : undefined,
      amount: typeof o.amount === "number" ? o.amount : undefined,
      paused: o.status === "paused",
    });
  }
  return out;
}

// ─── Liability profiles ──────────────────────────────────────────────────────

/**
 * What KIND of thing is this liability-profile row, really?
 *
 * User report 2026-07-26: "Bills 8, Subs 5, and Liabilities 3 coexist, while
 * many rules describe liabilities as bills or subscriptions… The app is mixing
 * the financial profile type with the calendar display category."
 *
 * Exactly right, and the mixing was here. `seriesFromLiabilityProfiles` used to
 * hardcode `kind: "liability"` for every row, so a $20/month ChatGPT Pro
 * subscription and a $155/month insurance premium both landed under the
 * Liabilities chip and Subs read 0.
 *
 * `liability` is the STORAGE type — the table these live in. It is not what the
 * record IS. The rows already carry the answer: `type_key` ("subscription",
 * "bill", "auto_loan") and `fields.category` ("subscription", "insurance",
 * "housing", "loan_payment"). Both were being thrown away. This reads them.
 *
 * `liability` is reserved for genuine DEBT — something with a balance you are
 * paying down. A recurring charge for a service is a subscription; a recurring
 * charge for something you consume or must carry is a bill.
 */
export function kindForLiabilityProfile(p: any): OccurrenceKind {
  const f = p?.fields && typeof p.fields === "object" ? p.fields : {};
  const signals = [p?.type_key, p?.typeKey, f.category, f.type, f.kind]
    .map((s) => String(s ?? "").toLowerCase().replace(/[^a-z]+/g, "_"));

  const has = (...needles: string[]) =>
    signals.some((s) => s && needles.some((n) => s === n || s.includes(n)));

  // Genuine debt first — these keep the Liability kind.
  if (has("loan", "mortgage", "credit_card", "debt", "lease", "line_of_credit")) {
    return "liability";
  }
  if (has("subscription", "membership", "streaming", "software")) return "subscription";
  if (has("bill", "insurance", "utility", "utilities", "housing", "rent", "health", "investment")) {
    return "bill";
  }
  // No usable signal. A row with a balance being paid down is a debt; a plain
  // recurring charge is a bill. Never guess "subscription" — that would put a
  // mortgage under Subs, which is worse than the generic answer.
  const balance = Number(f.balance ?? f.currentBalance ?? f.amountOwed);
  const payoff = f.payoffDate ?? f.payoff_date;
  if (payoff || (Number.isFinite(balance) && balance > 0 && f.interestRate != null)) {
    return "liability";
  }
  return "bill";
}

/**
 * Liability profiles that carry their own payment schedule (a mortgage, an
 * auto loan) rather than an obligation row. `recurrenceEnd` comes from the
 * payoff date so the series genuinely ends instead of running forever.
 */
export function seriesFromLiabilityProfiles(profiles: readonly any[]): CalendarSeries[] {
  const out: CalendarSeries[] = [];
  for (const p of profiles || []) {
    if (!p?.id) continue;
    if (p.type !== "liability" && p.type !== "loan") continue;
    const f = p.fields && typeof p.fields === "object" ? p.fields : {};
    // `nextPayment` is the spelling the profile writer synthesizes from a
    // `dueDay`, and it was previously reached only by the server timeline's
    // per-type virtual-event ladder. That ladder is gone (the Date Rule pass
    // replaces it), so this list has to carry the spelling or a liability whose
    // date lives under it would silently leave the calendar.
    // Normalized on read, like every other date the rule engine touches. A row
    // written before the write-path fix holds "07/18/2026", and `isISO` said no
    // — so the liability's payments were absent from the calendar with nothing
    // to explain it. The engine's promise is that historical rows light up on
    // the first read; this is where that promise is kept for liabilities.
    const due = normalizeDateString(
      f.nextDueDate ?? f.next_due_date ?? f.dueDate ?? f.due_date
      ?? f.nextPayment ?? f.next_payment ?? f.nextPaymentDate,
    );
    if (!isISO(due)) continue;
    const amount = Number(f.monthlyPayment ?? f.monthly_payment ?? f.amount);
    const end = normalizeDateString(
      f.payoffDate ?? f.payoff_date ?? f.endDate ?? f.end_date ?? f.recurrenceEnd,
    );
    const kind = kindForLiabilityProfile(p);
    // Per-occurrence state lives in `fields.occurrences`, keyed by canonical
    // date. Reading it here is what puts THIS month's variable amount on the
    // calendar — and what keeps a paid or skipped month from rendering as still
    // due — without the series itself carrying anything month-specific.
    const occState = liabilityOccurrenceState(p, Number.isFinite(amount) && amount > 0 ? amount : 0);
    out.push({
      id: `liability:${p.id}`,
      kind,
      title: p.name || "Liability",
      subtitle: String(p.type_key ?? p.typeKey ?? kind).replace(/_/g, " "),
      source: {
        system: "liability",
        id: p.id,
        profileId: p.id,
        // A liability nested under a person belongs to that person too, so it
        // survives a filter on either.
        ownerIds: uniq([p.id, p.parentProfileId, ...(Array.isArray(p.linkedProfiles) ? p.linkedProfiles : [])]),
        label: p.name,
        href: sourceHref("liability", p.id, p.id),
        // A liability profile IS the financial record, so it anchors on
        // itself — that is what lets an obligation pointing at it collide.
        linkedRecordId: p.id,
        linkedLabel: "Liability",
      },
      baseDate: clip(due),
      recurrence: frequencyToRecurrence(f.frequency ?? "monthly"),
      recurrenceEnd: isISO(end) ? clip(end) : undefined,
      amount: Number.isFinite(amount) && amount > 0 ? amount : undefined,
      paused: f.paused === true,
      ...occState,
    });
  }
  return out;
}

/**
 * The per-occurrence state a liability profile carries in `fields.occurrences`,
 * shaped for a CalendarSeries.
 *
 * Every month with its own money — an estimate, a usage charge, a posted actual
 * — contributes ONE entry to `amountByDate`. Months with nothing of their own
 * are absent, so they fall through to the series amount. Editing one month
 * therefore cannot reach any other month, which is the guarantee the whole
 * variable-liability model rests on.
 */
function liabilityOccurrenceState(p: any, definitionAmount: number): Partial<CalendarSeries> {
  const billingModel = resolveBillingModel(p);
  const raw = p?.fields?.occurrences;
  if (!raw || typeof raw !== "object") return { billingModel };
  const amountByDate: Record<string, number> = {};
  const estimatedDates: string[] = [];
  const completedDates: string[] = [];
  const skippedDates: string[] = [];
  const movedDates: Record<string, string> = {};

  for (const [date, ov] of Object.entries(raw as Record<string, any>)) {
    if (!isISO(date) || !ov || typeof ov !== "object") continue;
    if (ov.status === "paid") completedDates.push(date);
    if (ov.status === "skipped") skippedDates.push(date);
    if (isISO(ov.movedTo)) movedDates[date] = clip(ov.movedTo);

    const money = resolveOccurrenceAmount(definitionAmount, ov, billingModel);
    // Only record an amount when this period genuinely says something of its
    // own; otherwise the series amount is the right answer and duplicating it
    // per-date would make every month look overridden.
    const hasOwnMoney = ov.amount != null || ov.estimatedAmount != null
      || ov.actualAmount != null || (Array.isArray(ov.charges) && ov.charges.length > 0);
    if (hasOwnMoney) {
      amountByDate[date] = money.current;
      if (money.isEstimate && ov.status !== "paid") estimatedDates.push(date);
    }
  }

  return {
    billingModel,
    ...(Object.keys(amountByDate).length ? { amountByDate } : {}),
    ...(estimatedDates.length ? { estimatedDates } : {}),
    ...(completedDates.length ? { completedDates } : {}),
    ...(skippedDates.length ? { skippedDates } : {}),
    ...(Object.keys(movedDates).length ? { movedDates } : {}),
  };
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

/**
 * Recurring tasks carry their rule in `tags` (see shared/recurrence) — but not
 * every repeating task has one.
 *
 * Reported 2026-08-04: the Recurring Dates screen read "Tasks 0" for an account
 * whose calendar showed "Refill Propranolol prescription (100mg) – August". The
 * refill schedule is six separate task rows (May…October, ~30 days apart,
 * identical tags) and NOT ONE of them carries a `recur:` tag, so every "does
 * this repeat?" question answered no. `groupMaterializedSeries` recognises that
 * shape at read time and emits ONE series for it — no migration, no writes.
 *
 * Rows belonging to a detected group are emitted once, as the group; every
 * other task keeps its existing per-row behaviour exactly.
 */
export function seriesFromTasks(tasks: readonly any[]): CalendarSeries[] {
  const out: CalendarSeries[] = [];

  // Only OPEN, dated tasks can form a live schedule. Completed rows still count
  // as evidence of the cadence (the May–July refills are done), so they are fed
  // to the detector but never emitted as their own series.
  const candidates = (tasks || [])
    .filter((t: any) => t?.id && isISO(t.dueDate))
    .map((t: any) => ({
      id: String(t.id),
      title: String(t.title ?? ""),
      date: clip(t.dueDate),
      ownerId: Array.isArray(t.linkedProfiles) ? t.linkedProfiles[0] ?? null : null,
      tags: Array.isArray(t.tags) ? t.tags.map(String) : [],
      row: t,
    }));

  const grouped = groupMaterializedSeries(candidates);
  const claimed = new Set<string>();
  for (const g of grouped) {
    const open = g.rows.filter((r) => r.row.status !== "done");
    // Every occurrence already done — the schedule has run out. Leave the rows
    // to the per-row loop (which drops completed tasks) rather than inventing a
    // live series with no future dates.
    if (open.length === 0) continue;
    for (const r of g.rows) claimed.add(r.id);
    const anchor = open[0];
    const t = anchor.row;
    const profileId = anchor.ownerId ?? undefined;

    // THE GENERATED DATES MUST BE THE REAL ROWS' DATES.
    //
    // A detected cadence is an approximation — the refills sit 30 days apart,
    // which is not the same as "monthly on day 8". Generating from the base
    // date alone produced Sep 8 while the actual task is due Sep 7, and dropped
    // Oct 7 for being past a Oct-7 end date. That would put a date on the
    // calendar that no record holds, which is worse than the miscount being
    // fixed. So: generate the canonical sequence, then pin each occurrence onto
    // the row it stands for with `movedDates` (canonical → actual), and let the
    // series run to the last CANONICAL date so nothing falls off the end.
    const openDates = open.map((r) => r.date);
    const canonical = expandRecurrenceDates(anchor.date, g.recurrence, {
      windowStart: anchor.date,
      windowEnd: addYearsISO(openDates[openDates.length - 1], 1),
      cap: Math.max(openDates.length * 3, 12),
    }).slice(0, openDates.length);
    const movedDates: Record<string, string> = {};
    canonical.forEach((canon, i) => {
      const actual = openDates[i];
      if (actual && canon !== actual) movedDates[canon] = actual;
    });

    out.push({
      id: `task:${anchor.id}`,
      kind: "task",
      title: humanizeTitle(g.stem, "Task"),
      subtitle: t.priority ? `${t.priority} priority` : undefined,
      source: {
        system: "task",
        id: anchor.id,
        profileId,
        ownerIds: uniq(Array.isArray(t.linkedProfiles) ? t.linkedProfiles : []),
        href: sourceHref("task", anchor.id, profileId),
      },
      baseDate: anchor.date,
      recurrence: g.recurrence,
      // The schedule genuinely stops at the last row that exists — this is a
      // finite set of generated tasks, not an endless series. The end is the
      // last CANONICAL date so every real row still gets an occurrence.
      recurrenceEnd: canonical[canonical.length - 1] || anchor.date,
      ...(Object.keys(movedDates).length > 0 ? { movedDates } : {}),
      materializedFrom: { seriesKey: g.seriesKey, rowIds: g.rows.map((r) => r.id) },
    });
  }

  for (const t of tasks || []) {
    if (!t?.id || !isISO(t.dueDate)) continue;
    if (t.status === "done") continue;
    if (claimed.has(String(t.id))) continue;
    const tags: string[] = Array.isArray(t.tags) ? t.tags : [];
    const recurTag = tags.find((x) => typeof x === "string" && x.startsWith("recur:"));
    const freq = recurTag ? recurTag.slice(6) : "";
    const profileId = Array.isArray(t.linkedProfiles) ? t.linkedProfiles[0] : undefined;
    out.push({
      id: `task:${t.id}`,
      kind: "task",
      title: humanizeTitle(t.title, "Task"),
      subtitle: t.priority ? `${t.priority} priority` : undefined,
      source: {
        system: "task",
        id: t.id,
        profileId,
        ownerIds: uniq(Array.isArray(t.linkedProfiles) ? t.linkedProfiles : []),
        href: sourceHref("task", t.id, profileId),
      },
      baseDate: clip(t.dueDate),
      recurrence: freq ? frequencyToRecurrence(freq) : "none",
      paused: tags.includes("rpaused"),
    });
  }
  return out;
}

// ─── Documents ───────────────────────────────────────────────────────────────

/** Document expirations — one-off dates that still belong on the calendar. */
export function seriesFromDocuments(documents: readonly any[]): CalendarSeries[] {
  const out: CalendarSeries[] = [];
  const KEYS = [
    "expiration_date", "expirationDate", "expiry", "expires", "exp_date",
    "expiration", "valid_until", "validUntil", "renewal_date", "renewalDate",
  ];
  for (const d of documents || []) {
    if (!d?.id) continue;
    const ed = d.extractedData && typeof d.extractedData === "object" ? d.extractedData : {};
    let found: string | null = null;
    for (const k of KEYS) {
      if (isISO(ed[k])) { found = clip(ed[k]); break; }
    }
    if (!found) continue;
    const profileId = Array.isArray(d.linkedProfiles) ? d.linkedProfiles[0] : undefined;
    out.push({
      id: `document:${d.id}`,
      kind: "document",
      title: humanizeTitle(d.name, "Document"),
      subtitle: d.type || undefined,
      source: {
        system: "document",
        id: d.id,
        profileId,
        ownerIds: uniq(Array.isArray(d.linkedProfiles) ? d.linkedProfiles : []),
        href: sourceHref("document", d.id, profileId),
      },
      baseDate: found,
      recurrence: "none",
    });
  }
  return out;
}

// ─── Recurring income ────────────────────────────────────────────────────────

/**
 * Paychecks and other recurring income.
 *
 * Income had no adapter at all, so "I get paid every other Friday" existed in
 * the finance tables and on no calendar surface. It is emitted as its own
 * `income` kind rather than as a payment: the payment kinds share a dedup and
 * cash-flow identity space that is about money going OUT, and a paycheck
 * landing in it would be netted against a bill of the same size.
 */
export function seriesFromIncomes(incomes: readonly any[]): CalendarSeries[] {
  const out: CalendarSeries[] = [];
  for (const i of incomes || []) {
    if (!i?.id || i.deletedAt) continue;
    if (!isISO(i.date)) continue;
    const profileId = Array.isArray(i.linkedProfiles) ? i.linkedProfiles[0] : undefined;
    out.push({
      id: `income:${i.id}`,
      kind: "income",
      title: i.description || "Income",
      subtitle: i.category || undefined,
      source: {
        system: "event",
        id: i.id,
        profileId,
        ownerIds: uniq(Array.isArray(i.linkedProfiles) ? i.linkedProfiles : []),
        label: i.description,
        href: "#/finance",
      },
      baseDate: clip(i.date),
      recurrence: frequencyToRecurrence(i.frequency),
      amount: typeof i.amount === "number" ? i.amount : undefined,
    });
  }
  return out;
}

// ─── The whole calendar ──────────────────────────────────────────────────────

export interface CalendarInputs {
  profiles?: readonly any[];
  events?: readonly any[];
  obligations?: readonly any[];
  tasks?: readonly any[];
  documents?: readonly any[];
  incomes?: readonly any[];
}

/**
 * Every date in the app, as one normalized series list.
 *
 * Order matters: profiles are adapted FIRST so their birthday/anniversary
 * ownership is known before events are adapted and can be flagged as shadows.
 */
export function seriesFromAll(input: CalendarInputs): CalendarSeries[] {
  // Profiles and documents no longer get a bespoke adapter each. Their dates
  // are whatever the Date Rule engine classifies as actionable
  // (shared/date-rules) — birthdays, anniversaries, licence/passport/
  // registration/warranty expirations, renewals, lease ends — so the calendar
  // sees exactly the same set the Upcoming feed and the Important Dates screen
  // see. The three used to disagree; that was the bug.
  const dateRules = rulesFromAll({ profiles: input.profiles || [], documents: input.documents || [] });
  const ruleSeries = seriesFromDateRules(dateRules);

  const knownBirthdayProfiles = new Set(
    dateRules.filter((r) => r.ruleType === "birthday").map((r) => r.profileId!).filter(Boolean),
  );
  const knownAnniversaryProfiles = new Set(
    dateRules.filter((r) => r.ruleType === "anniversary").map((r) => r.profileId!).filter(Boolean),
  );
  const ruledDocumentDates = new Set(
    dateRules.filter((r) => r.sourceEntityType === "document")
      .map((r) => `${r.sourceEntityId}@${r.date}`),
  );
  return [
    ...ruleSeries,
    ...seriesFromLiabilityProfiles(input.profiles || []),
    ...seriesFromEvents(input.events || [], { knownBirthdayProfiles, knownAnniversaryProfiles, ruledDocumentDates }),
    ...seriesFromObligations(input.obligations || []),
    ...seriesFromTasks(input.tasks || []),
    ...seriesFromIncomes(input.incomes || []),
  ];
}

/** Restrict a series list to the active profile selection. */
export function filterSeriesByProfiles(
  list: readonly CalendarSeries[],
  selectedIds: readonly string[] | null | undefined,
  opts: { selfIds?: ReadonlySet<string> } = {},
): CalendarSeries[] {
  if (!selectedIds || selectedIds.length === 0) return [...list];
  const allow = new Set(selectedIds);
  const selfIds = opts.selfIds ?? new Set<string>();
  return list.filter((s) => {
    // A record that lists only ITSELF as an owner is unowned. A liability
    // profile is its own source id, so `ownerCandidates` always returned at
    // least that one entry and the soft-orphan rule below could never fire —
    // an unparented Netflix or Spotify Premium matched no selection and
    // silently vanished the moment any profile filter was on. ("Why is there
    // only three things?" — there were five.)
    const owners = ownerCandidates(s).filter((id) => id !== s.source.id);
    if (owners.length === 0) {
      // Selecting the record itself still shows it.
      if (s.source.id && allow.has(s.source.id)) return true;
      // Unowned records follow the app-wide soft-orphan rule: they belong to
      // the primary person. Dropping them is what made "Reminders 0" — a
      // reminder with no profileId matched nothing at all.
      for (const id of allow) if (selfIds.has(id)) return true;
      return false;
    }
    return owners.some((id) => allow.has(id));
  });
}

/** Every profile id that can put a series in scope. */
export function ownerCandidates(series: CalendarSeries): string[] {
  return uniq([...(series.source.ownerIds || []), series.source.profileId]);
}
