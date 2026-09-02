// ── useCalendarOccurrences ───────────────────────────────────────────────────
//
// The one hook every calendar surface reads. It fetches each system's records
// once, runs them through the adapters and the occurrence engine, and returns
// a single deduplicated, date-sorted occurrence stream.
//
// It also owns AUTO-EXTENSION: when a series' generated window is nearly
// exhausted, the horizon widens and everything regenerates, so a recurring
// date can never quietly fall off the end of the calendar.

import { useMemo, useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { seriesFromAll, filterSeriesByProfiles } from "@shared/calendar-adapters";
import { scopedKey } from "@shared/query-keys";
import { withFullLimit } from "@/lib/list-limit";
import { onlyRulesAndImportantDates } from "@shared/calendar-occurrences";
import {
  buildCalendarOccurrences,
  dedupeSeries,
  generateSeriesOccurrences,
  needsHorizonExtension,
  extendedHorizonFor,
  horizonDaysFor,
  type CalendarOccurrence,
  type CalendarSeries,
} from "@shared/calendar-occurrences";

const todayLocal = () => new Date().toLocaleDateString("en-CA");

export interface UseCalendarOccurrencesOptions {
  /** Active profile scope. Empty = everyone. */
  filterIds?: string[];
  filterMode?: "all" | "selected" | "everyone";
  /** Days of history to include. Default 62 so recent misses stay visible. */
  lookbackDays?: number;
  /**
   * Restrict to genuinely repeating rules.
   *
   * The Recurring Dates screen sets this. Without it the screen listed
   * driver-licence expirations, a raw `dateOfBirth` field, a House Viewing and
   * a Soccer Game — each captioned "Does not repeat" — because one-off dates
   * were being adapted into "rules". They still belong on the calendar grid;
   * they are just not recurrence rules to manage.
   */
  recurringOnly?: boolean;
}

export interface CalendarOccurrencesResult {
  /** Every occurrence, deduplicated and date-sorted — one-off dates included. */
  occurrences: CalendarOccurrence[];
  /** The series the RULES list manages (recurring only when `recurringOnly`). */
  series: CalendarSeries[];
  /** Every deduplicated series in scope, whether or not it repeats. */
  allSeries: CalendarSeries[];
  /** seriesId → the ids collapsed into it, for honest disclosure in the UI. */
  duplicatesBySeries: Map<string, string[]>;
  /** Every occurrence of one series, ascending. */
  occurrencesForSeries: (seriesId: string) => CalendarOccurrence[];
  /** The raw event row behind an event-sourced series (for tag mutations). */
  getEventRow: (eventId: string) => any | undefined;
  profileName: (profileId: string) => string | undefined;
  todayISO: string;
  isLoading: boolean;
}

const EMPTY_LIST: any[] = [];

export function useCalendarOccurrences(
  opts: UseCalendarOccurrencesOptions = {},
): CalendarOccurrencesResult {
  const { filterIds = [], filterMode = "everyone", lookbackDays = 62, recurringOnly = false } = opts;
  const scoped = filterMode === "selected" && filterIds.length > 0;
  const profileParam = scoped ? `?profileIds=${filterIds.join(",")}` : "";
  // [PERF 2026-07-31] Keys use the canonical scopedKey shape ([endpoint, mode,
  // ...ids] — shared/query-keys.ts) instead of the old ad-hoc [endpoint,
  // "id1,id2"|"all"] shape. The old shape matched NOTHING the dashboard
  // bootstrap seeds, so opening the Recurring tab always cold-fetched all six
  // datasets; the canonical slots are seeded on app open and this tab now
  // paints from cache.
  const mode: "everyone" | "selected" = scoped ? "selected" : "everyone";
  const kIds = scoped ? filterIds : [];

  const get = (url: string) =>
    apiRequest("GET", url).then((r) => r.json()).catch(() => []);

  // Events stay an UNSCOPED fetch: the series builder applies the client-side
  // soft-orphan scope rule itself (filterSeriesByProfiles below), which is not
  // identical to the server's per-profile isolation. Keyed under the canonical
  // unscoped slot so the common "everyone" scope hits the bootstrap seed.
  const events = useQuery<any[]>({
    queryKey: [...scopedKey("/api/events", "everyone", [])],
    queryFn: () => get(withFullLimit("/api/events")),
  });
  const profiles = useQuery<any>({ queryKey: ["/api/profiles"] });
  const obligations = useQuery<any[]>({
    queryKey: [...scopedKey("/api/obligations", mode, kIds)],
    queryFn: () => get(withFullLimit(`/api/obligations${profileParam}`)),
  });
  const tasks = useQuery<any[]>({
    queryKey: [...scopedKey("/api/tasks", mode, kIds)],
    queryFn: () => get(withFullLimit(`/api/tasks${profileParam}`)),
  });
  const documents = useQuery<any[]>({
    queryKey: [...scopedKey("/api/documents", mode, kIds)],
    // `limit` explicitly: the route defaults to 100 newest, so on a large
    // account the oldest documents derived no rules — their expirations never
    // reached this screen and their legacy extraction events stopped being
    // recognised as copies. (Same for events/obligations/tasks above — a series
    // whose source row fell off the first page simply never appeared.)
    queryFn: () => get(withFullLimit(`/api/documents${profileParam}`)),
  });
  // Recurring income. Without this the paycheck adapter existed and ran
  // nowhere: "I get paid every other Friday" was in the finance tables and on
  // no calendar surface at all.
  const incomes = useQuery<any[]>({
    queryKey: [...scopedKey("/api/incomes", mode, kIds)],
    queryFn: () => get(withFullLimit(`/api/incomes${profileParam}`)),
  });

  // Stable empty fallbacks: a fresh [] per render defeated every useMemo
  // downstream (allSeries, scopedSeries, ...) and regenerated years of
  // occurrences on each render while a query was still loading.
  const profileList: any[] = Array.isArray(profiles.data)
    ? profiles.data
    : (profiles.data?.data ?? EMPTY_LIST);
  const eventList: any[] = Array.isArray(events.data) ? events.data : EMPTY_LIST;

  const todayISO = todayLocal();

  // Extra horizon granted per kind by the auto-extend pass below.
  const [extendedKinds, setExtendedKinds] = useState<Record<string, number>>({});

  const allSeries = useMemo(
    () =>
      seriesFromAll({
        profiles: profileList,
        events: eventList,
        obligations: Array.isArray(obligations.data) ? obligations.data : [],
        tasks: Array.isArray(tasks.data) ? tasks.data : [],
        documents: Array.isArray(documents.data) ? documents.data : [],
        incomes: Array.isArray(incomes.data) ? incomes.data : [],
      }),
    [profileList, eventList, obligations.data, tasks.data, documents.data, incomes.data],
  );

  // Self ids drive the soft-orphan rule: an unassigned record belongs to the
  // primary person, the same convention finance and the dashboard use.
  const selfIds = useMemo(
    () => new Set(profileList.filter((p: any) => p?.type === "self").map((p: any) => p.id)),
    [profileList],
  );

  // Scope once. `recurringOnly` narrows only the RULES list — the occurrence
  // stream always covers every date so the Upcoming view and the calendar grid
  // show the same thing ("it should be connected to the Calendar view").
  const scopedSeries = useMemo(
    () => (scoped ? filterSeriesByProfiles(allSeries, filterIds, { selfIds }) : allSeries),
    [allSeries, scoped, filterIds.join(","), selfIds],
  );

  const deduped = useMemo(() => dedupeSeries(scopedSeries), [scopedSeries]);

  const duplicatesBySeries = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const d of deduped) if (d.duplicateIds.length) m.set(d.series.id, d.duplicateIds);
    return m;
  }, [deduped]);

  /** Every deduplicated series in scope — one-off dates included. */
  const survivingSeries = useMemo(() => deduped.map((d) => d.series), [deduped]);
  /** The subset the RULES list manages. */
  const ruleSeries = useMemo(
    // "Recurring only" now means "rules AND important one-off dates" — a
    // driver's licence expiration is not a recurrence, but it IS something the
    // Recurring & Important Dates screen manages. It keeps its one-time
    // semantics all the way through (`isImportantDate`, never `isRecurringRule`),
    // so nothing downstream treats it as repeating.
    () => (recurringOnly ? onlyRulesAndImportantDates(survivingSeries) : survivingSeries),
    [survivingSeries, recurringOnly],
  );

  // Per-series generation, so a kind whose horizon was extended regenerates
  // with the wider window while everything else stays cheap.
  const bySeries = useMemo(() => {
    const m = new Map<string, CalendarOccurrence[]>();
    for (const s of survivingSeries) {
      const horizonDays = extendedKinds[s.kind] ?? horizonDaysFor(s.kind);
      m.set(s.id, generateSeriesOccurrences(s, { todayISO, lookbackDays, horizonDays }));
    }
    return m;
  }, [survivingSeries, extendedKinds, todayISO, lookbackDays]);

  // AUTO-EXTEND. If any series is running out of future dates, widen that
  // kind's horizon once and let the memo above regenerate. Guarded by the
  // `extendedKinds` check so this can settle rather than loop.
  useEffect(() => {
    const grow: Record<string, number> = {};
    for (const s of survivingSeries) {
      if (extendedKinds[s.kind]) continue; // already widened for this kind
      const occ = bySeries.get(s.id) || [];
      if (needsHorizonExtension(s, occ, todayISO)) grow[s.kind] = extendedHorizonFor(s.kind);
    }
    if (Object.keys(grow).length > 0) setExtendedKinds((prev) => ({ ...prev, ...grow }));
  }, [survivingSeries, bySeries, extendedKinds, todayISO]);

  const occurrences = useMemo(() => {
    const out: CalendarOccurrence[] = [];
    const seen = new Set<string>();
    for (const s of survivingSeries) {
      for (const o of bySeries.get(s.id) || []) {
        const key = `${o.identityKey}@${o.date}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(o);
      }
    }
    out.sort((a, b) =>
      a.effectiveDate.localeCompare(b.effectiveDate) || a.title.localeCompare(b.title));
    return out;
  }, [survivingSeries, bySeries]);

  const eventsById = useMemo(() => {
    const m = new Map<string, any>();
    for (const e of eventList) if (e?.id) m.set(e.id, e);
    return m;
  }, [eventList]);

  const profilesById = useMemo(() => {
    const m = new Map<string, any>();
    for (const p of profileList) if (p?.id) m.set(p.id, p);
    return m;
  }, [profileList]);

  // PERF: these are consumed as useMemo/useEffect dependencies by the page.
  // Returning fresh arrow functions each render gave them a new identity every
  // time, so every downstream memo recomputed on every render — regenerating
  // the whole schedule (5 years of birthdays plus 12 months per payment) for
  // nothing. Stable identities keep the work proportional to real data changes.
  const occurrencesForSeries = useCallback(
    (seriesId: string) => bySeries.get(seriesId) || [],
    [bySeries],
  );
  const getEventRow = useCallback(
    (eventId: string) => eventsById.get(eventId),
    [eventsById],
  );
  const profileName = useCallback(
    (profileId: string) => profilesById.get(profileId)?.name,
    [profilesById],
  );

  return {
    occurrences,
    series: ruleSeries,
    allSeries: survivingSeries,
    duplicatesBySeries,
    occurrencesForSeries,
    getEventRow,
    profileName,
    todayISO,
    isLoading:
      events.isLoading || profiles.isLoading || obligations.isLoading ||
      tasks.isLoading || documents.isLoading || incomes.isLoading,
  };
}

/** Re-export so callers need one import. */
export { buildCalendarOccurrences };
