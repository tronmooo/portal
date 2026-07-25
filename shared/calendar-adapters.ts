// shared/calendar-adapters.ts — every system, one shape.
//
// The calendar is the single source of truth for every date in the app, which
// is only possible if every system's records arrive in ONE normalized form.
// Each adapter here converts one system's rows into `CalendarSeries`
// (shared/calendar-occurrences); nothing downstream ever touches a raw event,
// obligation, profile field, task or reminder again.
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
import { parseRecurringMeta } from "./recurring-dates";
import { canonicalObligationCategory } from "./category-canon";

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
  } = {},
): CalendarSeries[] {
  const out: CalendarSeries[] = [];
  const knownBirthdays = opts.knownBirthdayProfiles ?? new Set<string>();
  const knownAnniversaries = opts.knownAnniversaryProfiles ?? new Set<string>();

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
    const shadow =
      (kind === "birthday" && !!profileId && knownBirthdays.has(profileId)) ||
      (kind === "anniversary" && !!profileId && knownAnniversaries.has(profileId));

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
    const due = f.nextDueDate ?? f.next_due_date ?? f.dueDate ?? f.due_date;
    if (!isISO(due)) continue;
    const amount = Number(f.monthlyPayment ?? f.monthly_payment ?? f.amount);
    const end = f.payoffDate ?? f.payoff_date ?? f.endDate ?? f.end_date ?? f.recurrenceEnd;
    out.push({
      id: `liability:${p.id}`,
      kind: "liability",
      title: p.name || "Liability",
      subtitle: String(p.type_key ?? p.typeKey ?? "liability").replace(/_/g, " "),
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
    });
  }
  return out;
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

/** Recurring tasks carry their rule in `tags` (see shared/recurrence). */
export function seriesFromTasks(tasks: readonly any[]): CalendarSeries[] {
  const out: CalendarSeries[] = [];
  for (const t of tasks || []) {
    if (!t?.id || !isISO(t.dueDate)) continue;
    if (t.status === "done") continue;
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

// ─── Reminders ───────────────────────────────────────────────────────────────

/** One-shot reminder rows (`fireAt` is a UTC instant). */
export function seriesFromReminders(reminders: readonly any[]): CalendarSeries[] {
  const out: CalendarSeries[] = [];
  for (const r of reminders || []) {
    if (!r?.id || !r.fireAt) continue;
    const date = clip(String(r.fireAt));
    if (!isISO(date)) continue;
    out.push({
      id: `reminder:${r.id}`,
      kind: "reminder",
      title: humanizeTitle(r.title, "Reminder"),
      source: {
        system: "reminder",
        id: r.id,
        profileId: r.profileId || undefined,
        ownerIds: uniq([r.profileId]),
        href: sourceHref("reminder", r.id, r.profileId || undefined),
      },
      baseDate: date,
      recurrence: "none",
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

// ─── The whole calendar ──────────────────────────────────────────────────────

export interface CalendarInputs {
  profiles?: readonly any[];
  events?: readonly any[];
  obligations?: readonly any[];
  tasks?: readonly any[];
  reminders?: readonly any[];
  documents?: readonly any[];
}

/**
 * Every date in the app, as one normalized series list.
 *
 * Order matters: profiles are adapted FIRST so their birthday/anniversary
 * ownership is known before events are adapted and can be flagged as shadows.
 */
export function seriesFromAll(input: CalendarInputs): CalendarSeries[] {
  const profileSeries = seriesFromProfiles(input.profiles || []);
  const knownBirthdayProfiles = new Set(
    profileSeries.filter((s) => s.kind === "birthday").map((s) => s.source.profileId!).filter(Boolean),
  );
  const knownAnniversaryProfiles = new Set(
    profileSeries.filter((s) => s.kind === "anniversary").map((s) => s.source.profileId!).filter(Boolean),
  );
  return [
    ...profileSeries,
    ...seriesFromLiabilityProfiles(input.profiles || []),
    ...seriesFromEvents(input.events || [], { knownBirthdayProfiles, knownAnniversaryProfiles }),
    ...seriesFromObligations(input.obligations || []),
    ...seriesFromTasks(input.tasks || []),
    ...seriesFromReminders(input.reminders || []),
    ...seriesFromDocuments(input.documents || []),
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
    const owners = ownerCandidates(s);
    if (owners.length === 0) {
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
