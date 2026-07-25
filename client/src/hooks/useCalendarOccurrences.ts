// ── useCalendarOccurrences ───────────────────────────────────────────────────
//
// The one hook every calendar surface reads. It fetches each system's records
// once, runs them through the adapters and the occurrence engine, and returns
// a single deduplicated, date-sorted occurrence stream.
//
// It also owns AUTO-EXTENSION: when a series' generated window is nearly
// exhausted, the horizon widens and everything regenerates, so a recurring
// date can never quietly fall off the end of the calendar.

import { useMemo, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { seriesFromAll, filterSeriesByProfiles } from "@shared/calendar-adapters";
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
}

export interface CalendarOccurrencesResult {
  /** Every occurrence, deduplicated and date-sorted. */
  occurrences: CalendarOccurrence[];
  /** The surviving series after dedup. */
  series: CalendarSeries[];
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

export function useCalendarOccurrences(
  opts: UseCalendarOccurrencesOptions = {},
): CalendarOccurrencesResult {
  const { filterIds = [], filterMode = "everyone", lookbackDays = 62 } = opts;
  const scoped = filterMode === "selected" && filterIds.length > 0;
  const profileParam = scoped ? `?profileIds=${filterIds.join(",")}` : "";
  const scopeKey = scoped ? filterIds.join(",") : "all";

  const get = (url: string) =>
    apiRequest("GET", url).then((r) => r.json()).catch(() => []);

  const events = useQuery<any[]>({
    queryKey: ["/api/events"],
    queryFn: () => get("/api/events"),
  });
  const profiles = useQuery<any>({ queryKey: ["/api/profiles"] });
  const obligations = useQuery<any[]>({
    queryKey: ["/api/obligations", scopeKey],
    queryFn: () => get(`/api/obligations${profileParam}`),
  });
  const tasks = useQuery<any[]>({
    queryKey: ["/api/tasks", scopeKey],
    queryFn: () => get(`/api/tasks${profileParam}`),
  });
  const reminders = useQuery<any[]>({
    queryKey: ["/api/reminders", scopeKey],
    queryFn: () => get(`/api/reminders${profileParam}`),
  });
  const documents = useQuery<any[]>({
    queryKey: ["/api/documents", scopeKey],
    queryFn: () => get(`/api/documents${profileParam}`),
  });

  const profileList: any[] = Array.isArray(profiles.data)
    ? profiles.data
    : (profiles.data?.data ?? []);
  const eventList: any[] = Array.isArray(events.data) ? events.data : [];

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
        reminders: Array.isArray(reminders.data) ? reminders.data : [],
        documents: Array.isArray(documents.data) ? documents.data : [],
      }),
    [profileList, eventList, obligations.data, tasks.data, reminders.data, documents.data],
  );

  const scopedSeries = useMemo(
    () => (scoped ? filterSeriesByProfiles(allSeries, filterIds) : allSeries),
    [allSeries, scoped, filterIds.join(",")],
  );

  const deduped = useMemo(() => dedupeSeries(scopedSeries), [scopedSeries]);

  const duplicatesBySeries = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const d of deduped) if (d.duplicateIds.length) m.set(d.series.id, d.duplicateIds);
    return m;
  }, [deduped]);

  const survivingSeries = useMemo(() => deduped.map((d) => d.series), [deduped]);

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

  return {
    occurrences,
    series: survivingSeries,
    duplicatesBySeries,
    occurrencesForSeries: (seriesId: string) => bySeries.get(seriesId) || [],
    getEventRow: (eventId: string) => eventsById.get(eventId),
    profileName: (profileId: string) => profilesById.get(profileId)?.name,
    todayISO,
    isLoading:
      events.isLoading || profiles.isLoading || obligations.isLoading ||
      tasks.isLoading || reminders.isLoading || documents.isLoading,
  };
}

/** Re-export so callers need one import. */
export { buildCalendarOccurrences };
