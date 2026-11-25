// The Journal app's tabs beside its page (owner request 2026-11-25):
// Past Entries, AI Insights, Trends, Guided Journaling and Personal Growth.
// (The Reflection Coach is the shared AiConversation.)
//
// Everything here READS the same entries the page writes. Trends are computed
// from them (shared/journal-feelings.ts): a day with nothing written is a gap
// in the chart, never a zero. The AI tabs ask on a tap, show which entries an
// observation stands on, and change nothing (W5). Nothing here diagnoses.
import { useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Compass, Feather, List, Loader2, Search, Sparkles, Sprout } from "lucide-react";
import type { JournalEntry } from "@shared/schema";
import {
  describeChange, emotionCounts, journalEmotions, levelLabel, trendSeries, writingStreaks, MIN_TREND_DAYS,
  type TrendMetric, type TrendSeries,
} from "@shared/journal-feelings";
import { journalLabels, journalPhotoIds } from "@shared/journal-photos";
import type { JournalInsights } from "@shared/workspace-intel";
import { apiRequest } from "@/lib/queryClient";
import { parseLocalDate } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { MOOD_CONFIG } from "@/pages/journal";
import { aiErrorText } from "./WorkspaceShell";
import { AiAccessLine, AiAccessPanel, SectionTitle, TabPage } from "./WorkspaceApp";

const ACCENT = "262 70% 62%";
const dayOf = (e: JournalEntry) => String(e.date).slice(0, 10);
const fmtDay = (day: string, opts: Intl.DateTimeFormatOptions) => (parseLocalDate(day) ?? new Date()).toLocaleDateString(undefined, opts);
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const newestFirst = (a: JournalEntry, b: JournalEntry) => dayOf(b).localeCompare(dayOf(a)) || String(b.createdAt).localeCompare(String(a.createdAt));

interface ListState { loading: boolean; failed: boolean; retry: () => void }
/** The loading or failed state of the list, or null when the list can be shown. (A function, not a
 *  component: its answer is tested with `??`, and an element is never null.) */
function listGate(list: ListState, count: number, what: string): React.ReactNode | null {
  if (list.loading) return <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading {what}…</p>;
  if (list.failed && count === 0) return <div className="text-xs" role="alert" data-testid="journal-tab-error"><p className="text-destructive">Couldn't load {what}.</p><button type="button" className="underline mt-1" onClick={list.retry}>Retry</button></div>;
  return null;
}

// ── Past entries ─────────────────────────────────────────────────────────────

function EntryRow({ e, onOpen, ownerName }: { e: JournalEntry; onOpen: (e: JournalEntry) => void; ownerName: string | null }) {
  const cfg = MOOD_CONFIG[e.mood] || MOOD_CONFIG.neutral;
  const emotions = journalEmotions(e.tags);
  const photos = journalPhotoIds(e.tags).length;
  return (
    <li>
      <button type="button" onClick={() => onOpen(e)} className="w-full text-left bubble px-3 py-2.5 hover:bg-muted/60" data-testid={`past-entry-${e.id}`}>
        <span className="flex items-baseline gap-2">
          <span className="text-xs font-bold tabular-nums">{fmtDay(dayOf(e), { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</span>
          <span className="text-[11px]" style={{ color: cfg.color }}>{cfg.label}</span>
          {photos > 0 && <span className="text-[11px] text-muted-foreground ml-auto">{photos} {photos === 1 ? "photo" : "photos"}</span>}
        </span>
        <span className="text-sm font-medium truncate block mt-0.5">{e.title || String(e.content || "").split("\n")[0].slice(0, 70) || "Untitled"}</span>
        <span className="text-xs text-muted-foreground line-clamp-2 block">{String(e.content || "").replace(/\s+/g, " ").slice(0, 200)}</span>
        {(emotions.length > 0 || ownerName) && (
          <span className="flex flex-wrap gap-1 mt-1">
            {ownerName && <span className="text-[11px] text-muted-foreground">{ownerName}'s journal</span>}
            {emotions.map((emo) => <span key={emo} className="text-[11px] rounded-full bg-muted px-1.5 py-0.5">{emo}</span>)}
          </span>
        )}
      </button>
    </li>
  );
}

/**
 * Every entry, as a list (newest first, searchable) or a month calendar.
 * `scopeNotice` is the page's own line about the profile filter (Rule 4).
 */
export function PastEntries({
  entries, list, today, onOpen, ownerOf, scopeNotice,
}: {
  entries: JournalEntry[];
  list: ListState;
  today: string;
  onOpen: (e: JournalEntry) => void;
  ownerOf: (e: JournalEntry) => string | null;
  scopeNotice?: React.ReactNode;
}) {
  const [view, setView] = useState<"list" | "calendar">("list");
  const [search, setSearch] = useState("");
  const [month, setMonth] = useState(today.slice(0, 7));
  const [picked, setPicked] = useState<string | null>(null);
  const sorted = useMemo(() => [...entries].sort(newestFirst), [entries]);
  const q = search.trim().toLowerCase();
  const found = q ? sorted.filter((e) => `${e.title || ""} ${e.content || ""} ${journalLabels(e.tags).join(" ")} ${journalEmotions(e.tags).join(" ")}`.toLowerCase().includes(q)) : sorted;
  const byDay = useMemo(() => {
    const m = new Map<string, JournalEntry[]>();
    for (const e of sorted) { const d = dayOf(e); m.set(d, [...(m.get(d) || []), e]); }
    return m;
  }, [sorted]);

  const [y, mo] = month.split("-").map(Number);
  const first = new Date(y, mo - 1, 1);
  const cells: Array<string | null> = [
    ...Array.from({ length: first.getDay() }, () => null),
    ...Array.from({ length: new Date(y, mo, 0).getDate() }, (_, i) => iso(new Date(y, mo - 1, i + 1))),
  ];
  const shift = (by: number) => { const d = new Date(y, mo - 1 + by, 1); setMonth(iso(d).slice(0, 7)); setPicked(null); };
  const gate = listGate(list, entries.length, "your journal");
  const pill = "h-8 px-3 rounded-full text-xs font-medium flex items-center gap-1.5 aria-pressed:bg-foreground aria-pressed:text-background text-muted-foreground";

  return (
    <TabPage testId="journal-past">
      <div className="flex items-center gap-2">
        <div className="flex rounded-full border border-border p-0.5 shrink-0" role="group" aria-label="How to show past entries">
          <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")} className={pill} data-testid="button-past-list"><List className="h-3.5 w-3.5" /> List</button>
          <button type="button" aria-pressed={view === "calendar"} onClick={() => setView("calendar")} className={pill} data-testid="button-past-calendar"><CalendarDays className="h-3.5 w-3.5" /> Calendar</button>
        </div>
        {view === "list" && (
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search every entry" aria-label="Search every entry"
              className="ws-title w-full h-9 rounded-full border border-border bg-background pl-9 pr-3 text-sm outline-none" data-testid="input-past-search" />
          </div>
        )}
      </div>
      {scopeNotice && <div className="mt-2">{scopeNotice}</div>}
      <div className="mt-3">
        {gate ?? (view === "list" ? (
          found.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="past-empty">{q ? `No entry matches “${search.trim()}”.` : "No entries yet. Write the first on the New Entry tab."}</p>
          ) : (
            <>
              <p className="text-[11px] text-muted-foreground mb-1.5" data-testid="past-count">{found.length} {found.length === 1 ? "entry" : "entries"}{q ? ` of ${sorted.length}` : ""}</p>
              <ul className="space-y-1.5">{found.map((e) => <EntryRow key={e.id} e={e} onOpen={onOpen} ownerName={ownerOf(e)} />)}</ul>
            </>
          )
        ) : (
          <div data-testid="past-calendar">
            <div className="flex items-center gap-2 mb-2">
              <button type="button" onClick={() => shift(-1)} aria-label="Previous month" className="h-8 w-8 rounded-full hover:bg-muted flex items-center justify-center"><ChevronLeft className="h-4 w-4" /></button>
              <p className="text-sm font-semibold flex-1 text-center" data-testid="past-calendar-month">{first.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</p>
              <button type="button" onClick={() => shift(1)} disabled={month >= today.slice(0, 7)} aria-label="Next month" className="h-8 w-8 rounded-full hover:bg-muted flex items-center justify-center disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
            </div>
            <div className="grid grid-cols-7 gap-1 text-center">
              {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <span key={i} className="text-[11px] text-muted-foreground">{d}</span>)}
              {cells.map((day, i) => {
                if (!day) return <span key={`pad${i}`} />;
                const rows = byDay.get(day) || [];
                const cfg = rows[0] ? MOOD_CONFIG[rows[0].mood] || MOOD_CONFIG.neutral : null;
                return (
                  <button key={day} type="button" disabled={rows.length === 0} onClick={() => setPicked(day)} aria-pressed={picked === day}
                    aria-label={`${fmtDay(day, { month: "long", day: "numeric" })}: ${rows.length === 0 ? "nothing written" : `${rows.length} ${rows.length === 1 ? "entry" : "entries"}`}`}
                    className={`aspect-square rounded-lg text-xs flex flex-col items-center justify-center gap-0.5 border ${picked === day ? "border-foreground" : "border-transparent"} ${rows.length ? "hover:bg-muted" : "text-muted-foreground/50"} ${day === today ? "font-bold" : ""}`}
                    data-testid={`calendar-day-${day}`}>
                    {Number(day.slice(8))}
                    <span className="h-1.5 w-1.5 rounded-full" style={cfg ? { background: cfg.color } : undefined} />
                  </button>
                );
              })}
            </div>
            <div className="mt-3">
              {!picked ? <p className="text-xs text-muted-foreground">A dot marks a day with an entry, coloured by its mood. Tap a day to read it.</p>
                : <ul className="space-y-1.5">{(byDay.get(picked) || []).map((e) => <EntryRow key={e.id} e={e} onOpen={onOpen} ownerName={ownerOf(e)} />)}</ul>}
            </div>
          </div>
        ))}
      </div>
    </TabPage>
  );
}

// ── Trends ───────────────────────────────────────────────────────────────────

export const TREND_RANGES = [{ id: "30", label: "30 days", days: 30 }, { id: "90", label: "90 days", days: 90 }, { id: "365", label: "1 year", days: 365 }, { id: "all", label: "All", days: 0 }] as const;
const METRIC_META: Record<TrendMetric, { label: string; color: string; low: string; high: string; none: string }> = {
  mood: { label: "Mood", color: "#4F98A3", low: "Terrible", high: "Amazing", none: "No entries in this range." },
  energy: { label: "Energy", color: "#D19A2E", low: "Very low", high: "Very high", none: "No entry in this range has an energy level. Set one on the New Entry tab." },
  stress: { label: "Stress", color: "#BB653B", low: "Very low", high: "Very high", none: "No entry in this range has a stress level. Set one on the New Entry tab." },
};

/** A line over real dates, 1–5. Days without a reading are gaps in time, not points. */
function TrendChart({ series }: { series: TrendSeries }) {
  const meta = METRIC_META[series.metric];
  const pts = series.points;
  if (pts.length === 0) return <p className="text-xs text-muted-foreground" data-testid={`trend-${series.metric}-empty`}>{meta.none}</p>;
  const W = 600, H = 120, PAD = 8;
  const t0 = Date.parse(`${pts[0].date}T12:00:00Z`);
  const t1 = Date.parse(`${pts[pts.length - 1].date}T12:00:00Z`);
  const x = (d: string) => (t1 === t0 ? W / 2 : PAD + ((Date.parse(`${d}T12:00:00Z`) - t0) / (t1 - t0)) * (W - PAD * 2));
  const yOf = (v: number) => H - PAD - ((v - 1) / 4) * (H - PAD * 2);
  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(p.date).toFixed(1)},${yOf(p.value).toFixed(1)}`).join(" ");
  return (
    <figure data-testid={`trend-${series.metric}-chart`}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-28" role="img"
        aria-label={`${meta.label} from ${fmtDay(pts[0].date, { month: "short", day: "numeric" })} to ${fmtDay(pts[pts.length - 1].date, { month: "short", day: "numeric" })}, average ${series.average} of 5`}>
        {[1, 3, 5].map((v) => <line key={v} x1={PAD} x2={W - PAD} y1={yOf(v)} y2={yOf(v)} stroke="currentColor" strokeOpacity={0.12} strokeDasharray={v === 3 ? "4 4" : undefined} />)}
        {pts.length > 1 && <path d={path} fill="none" stroke={meta.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
        {pts.map((p) => <circle key={p.date} cx={x(p.date)} cy={yOf(p.value)} r={pts.length > 60 ? 1.5 : 3} fill={meta.color}><title>{`${fmtDay(p.date, { month: "short", day: "numeric", year: "numeric" })}: ${p.value} of 5`}</title></circle>)}
      </svg>
      <figcaption className="flex justify-between text-[11px] text-muted-foreground">
        <span>{fmtDay(pts[0].date, { month: "short", day: "numeric", year: "numeric" })}</span>
        <span>{meta.low} (1) to {meta.high} (5)</span>
        <span>{fmtDay(pts[pts.length - 1].date, { month: "short", day: "numeric", year: "numeric" })}</span>
      </figcaption>
    </figure>
  );
}

export function JournalTrends({ entries, list, today }: { entries: JournalEntry[]; list: ListState; today: string }) {
  // A VIEW over the entries: never stored; the range names what it leaves out (Rule 4).
  const [rangeId, setRangeId] = useState<(typeof TREND_RANGES)[number]["id"]>("90");
  const range = TREND_RANGES.find((r) => r.id === rangeId)!;
  const from = useMemo(() => {
    if (!range.days) return undefined;
    const d = parseLocalDate(today) ?? new Date();
    d.setDate(d.getDate() - (range.days - 1));
    return iso(d);
  }, [range.days, today]);
  const inRange = useMemo(() => entries.filter((e) => !from || dayOf(e) >= from), [entries, from]);
  const series = useMemo(() => (["mood", "energy", "stress"] as TrendMetric[]).map((m) => trendSeries(entries, m, { from, to: today })), [entries, from, today]);
  const emotions = useMemo(() => emotionCounts(entries, { from, to: today }), [entries, from, today]);
  const streaks = useMemo(() => writingStreaks(entries, today), [entries, today]);
  const gate = listGate(list, entries.length, "your journal");
  const maxEmotion = emotions[0]?.entries || 1;
  const hiddenByRange = entries.length - inRange.length;

  return (
    <TabPage testId="journal-trends">
      <div className="flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none]" data-swipe-ignore role="group" aria-label="Time range">
        {TREND_RANGES.map((r) => (
          <button key={r.id} type="button" aria-pressed={rangeId === r.id} onClick={() => setRangeId(r.id)}
            className="shrink-0 h-7 px-3 rounded-full border border-border text-xs aria-pressed:bg-foreground aria-pressed:text-background" data-testid={`trend-range-${r.id}`}>{r.label}</button>
        ))}
      </div>
      {gate ?? (entries.length === 0 ? (
        <p className="text-sm text-muted-foreground mt-3" data-testid="trends-empty">Trends appear once you have written a few entries.</p>
      ) : (
        <>
          <p className="text-[11px] text-muted-foreground mt-2" data-testid="trends-range-note">
            {inRange.length} {inRange.length === 1 ? "entry" : "entries"} in this range{hiddenByRange > 0 ? ` — ${hiddenByRange} older ${hiddenByRange === 1 ? "entry is" : "entries are"} outside it` : ""}.
            {" "}Written on {streaks.daysWritten} {streaks.daysWritten === 1 ? "day" : "days"} in all; longest run {streaks.longest} {streaks.longest === 1 ? "day" : "days"}{streaks.current > 1 ? `, ${streaks.current} in a row now` : ""}.
          </p>
          <div className="mt-3 space-y-4">
            {series.map((s) => {
              const meta = METRIC_META[s.metric];
              return (
                <section key={s.metric} className="bubble p-3" data-testid={`trend-${s.metric}`}>
                  <div className="flex items-baseline gap-2 mb-1">
                    <h3 className="text-sm font-semibold flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: meta.color }} />{meta.label}</h3>
                    {s.average != null && <span className="text-xs text-muted-foreground">average {s.average} of 5{s.metric !== "mood" ? ` (${levelLabel(s.average)})` : ""} over {s.days} {s.days === 1 ? "day" : "days"}</span>}
                    {s.days > 0 && <span className="text-xs ml-auto" data-testid={`trend-${s.metric}-change`}>{s.days < MIN_TREND_DAYS ? `${MIN_TREND_DAYS - s.days} more ${MIN_TREND_DAYS - s.days === 1 ? "day" : "days"} to show a direction` : describeChange(s.change)}</span>}
                  </div>
                  <TrendChart series={s} />
                </section>
              );
            })}
            <section className="bubble p-3" data-testid="trend-emotions">
              <h3 className="text-sm font-semibold mb-2">Emotions named</h3>
              {emotions.length === 0 ? (
                <p className="text-xs text-muted-foreground">No entry in this range names an emotion. Pick some on the New Entry tab.</p>
              ) : (
                <ul className="space-y-1">
                  {emotions.slice(0, 12).map((e) => (
                    <li key={e.emotion} className="flex items-center gap-2 text-xs">
                      <span className="w-24 shrink-0 capitalize">{e.emotion}</span>
                      <span className="flex-1 h-2 rounded-full bg-muted overflow-hidden"><span className="block h-full rounded-full" style={{ width: `${Math.max(6, (e.entries / maxEmotion) * 100)}%`, background: e.hard ? "#BB653B" : "#4F98A3" }} /></span>
                      <span className="w-16 text-right tabular-nums text-muted-foreground">{e.entries} {e.entries === 1 ? "entry" : "entries"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
          <p className="text-[11px] text-muted-foreground mt-3">Counted from your entries: a day's figure is the average of that day's entries, and a day with nothing written is a gap, not a low. A pattern here is a description, not a diagnosis.</p>
        </>
      ))}
    </TabPage>
  );
}

// ── AI Insights and Personal Growth ──────────────────────────────────────────

const FOCUS_COPY = {
  insights: { title: "Patterns in your journal", button: "Find patterns", icon: Compass, blurb: "The AI reads your entries and describes emotional patterns, concerns that keep returning, what has changed and where you have made progress." },
  growth: { title: "Personal growth", button: "Reflect on my growth", icon: Sprout, blurb: "The AI reads your entries and names the challenges that recur, what you have accomplished — including what you did not give yourself credit for — and gentle things you could try." },
} as const;

/**
 * AI Insights (`focus="insights"`) and Personal Growth (`focus="growth"`).
 * Each observation lists the days it is based on; a day opens that entry.
 */
export function JournalInsightsTab({
  focus, entries, list, onOpenDay, boundary,
}: {
  focus: "insights" | "growth";
  entries: JournalEntry[];
  list: ListState;
  onOpenDay: (day: string) => void;
  boundary: string;
}) {
  const { toast } = useToast();
  const copy = FOCUS_COPY[focus];
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ insights: JournalInsights; entriesRead: number; entriesTotal: number; usedWellness: boolean } | null>(null);
  const [accessOpen, setAccessOpen] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await apiRequest("POST", "/api/workspace/journal/insights", { focus });
      const j = await r.json();
      if (!j?.insights || !Array.isArray(j.insights.sections)) throw new Error("The AI returned nothing usable.");
      setResult({ insights: j.insights, entriesRead: Number(j.entriesRead) || 0, entriesTotal: Number(j.entriesTotal) || 0, usedWellness: !!j.usedWellness });
    } catch (err) {
      toast({ title: "AI couldn't read your journal", description: aiErrorText(err), variant: "destructive" });
    } finally { setBusy(false); }
  };
  const gate = listGate(list, entries.length, "your journal");
  return (
    <TabPage testId={`journal-${focus}`}>
      <SectionTitle icon={copy.icon} aside={
        <button type="button" disabled={busy || entries.length < 3} onClick={() => void run()} title={entries.length < 3 ? "Write at least three entries first" : undefined}
          className="h-8 px-3 rounded-full text-white text-xs font-semibold flex items-center gap-1 disabled:opacity-50" style={{ background: `hsl(${ACCENT})` }} data-testid={`button-journal-${focus}`}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} {result ? "Look again" : copy.button}
        </button>
      }>{copy.title}</SectionTitle>
      <p className="text-[11px] rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-muted-foreground mb-2">{boundary}</p>
      <AiAccessLine app="journal" onChange={() => setAccessOpen((v) => !v)} />
      {accessOpen && <div className="mt-2"><AiAccessPanel app="journal" onClose={() => setAccessOpen(false)} /></div>}
      <div className="mt-3">
        {gate ?? (!result ? (
          <p className="text-sm text-muted-foreground">
            {busy ? "Reading your entries…" : entries.length < 3 ? "There is not enough written yet to see a pattern. This opens up after three entries." : `${copy.blurb} It changes nothing.`}
          </p>
        ) : (
          <div className="space-y-4" data-testid={`journal-${focus}-result`}>
            <p className="text-[11px] text-muted-foreground">
              Read {result.entriesRead} of {result.entriesTotal} entries{result.usedWellness ? ", with your tracker readings" : ""}. An AI's reading of your words — you are the judge of whether it fits.
            </p>
            {result.insights.sections.map((s) => (
              <section key={s.key} data-testid={`journal-section-${s.key}`}>
                <h3 className="text-xs font-semibold mb-1.5">{s.label}</h3>
                {s.items.length === 0 ? <p className="text-xs text-muted-foreground">Nothing stood out here.</p> : (
                  <ul className="space-y-1.5">
                    {s.items.map((it, i) => (
                      <li key={i} className="bubble px-3 py-2">
                        <p className="text-sm font-medium">{it.title}</p>
                        <p className="text-sm text-muted-foreground mt-0.5">{it.detail}</p>
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {it.days.slice(0, 8).map((d) => (
                            <button key={d} type="button" onClick={() => onOpenDay(d)} className="h-6 px-2 rounded-full bg-muted text-[11px] hover:bg-muted/70" title="Open this day's entry" data-testid={`insight-day-${d}`}>
                              {fmtDay(d, { month: "short", day: "numeric" })}
                            </button>
                          ))}
                          {it.days.length > 8 && <span className="text-[11px] text-muted-foreground self-center">and {it.days.length - 8} more days</span>}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        ))}
      </div>
    </TabPage>
  );
}

// ── Guided journaling ────────────────────────────────────────────────────────

/** Fixed exercises. A prompt is put on a new page for the writer to answer. */
export const GUIDED_EXERCISES: Array<{ id: string; title: string; about: string; prompts: string[] }> = [
  { id: "day", title: "Close the day", about: "A short look back before the day ends.", prompts: ["What went well today?", "What was hard today, and what did I learn from it?", "What do I want tomorrow to look like?"] },
  { id: "gratitude", title: "Gratitude", about: "Name what is good, specifically.", prompts: ["What am I grateful for?", "Who made today easier, and how?", "What small thing did I enjoy that I usually overlook?"] },
  { id: "worry", title: "Untangle a worry", about: "Get it out of your head and onto the page.", prompts: ["What is on my mind right now?", "What part of this is in my control, and what part is not?", "What would I say to a friend who had this worry?"] },
  { id: "relationships", title: "Relationships", about: "The people around you.", prompts: ["Which conversation has stayed with me, and why?", "Who do I want to spend more time with?", "Is there something I have left unsaid?"] },
  { id: "growth", title: "Looking back to look ahead", about: "Where you have been and where you are going.", prompts: ["What have I got better at this year?", "What am I avoiding, and what is one small step toward it?", "What matters most to me right now?"] },
];

export function GuidedJournaling({ hasEntries, onUsePrompt }: { hasEntries: boolean; onUsePrompt: (prompt: string) => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [personal, setPersonal] = useState<string[] | null>(null);
  const [accessOpen, setAccessOpen] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await apiRequest("POST", "/api/workspace/journal/prompts", {});
      const j = await r.json();
      if (!Array.isArray(j?.prompts) || j.prompts.length === 0) throw new Error("The AI returned no prompts.");
      setPersonal(j.prompts.map(String));
    } catch (err) {
      toast({ title: "Couldn't write personal prompts", description: aiErrorText(err), variant: "destructive" });
    } finally { setBusy(false); }
  };
  const chip = "text-left text-sm rounded-xl border px-3 py-2 w-full hover:bg-muted/60";
  return (
    <TabPage testId="journal-guided">
      <SectionTitle icon={Sparkles} aside={
        <button type="button" disabled={busy || !hasEntries} onClick={() => void run()} title={hasEntries ? undefined : "Personal prompts come from what you have written"}
          className="h-8 px-3 rounded-full text-white text-xs font-semibold flex items-center gap-1 disabled:opacity-50" style={{ background: `hsl(${ACCENT})` }} data-testid="button-personal-prompts">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} {personal ? "New prompts" : "Write prompts for me"}
        </button>
      }>Prompts from your own journal</SectionTitle>
      <AiAccessLine app="journal" onChange={() => setAccessOpen((v) => !v)} />
      {accessOpen && <div className="mt-2"><AiAccessPanel app="journal" onClose={() => setAccessOpen(false)} /></div>}
      {personal ? (
        <ul className="mt-2 space-y-1.5" data-testid="personal-prompts">
          {personal.map((p) => <li key={p}><button type="button" onClick={() => onUsePrompt(p)} className={`${chip} border-[hsl(262_70%_62%/0.4)]`} data-testid="personal-prompt">{p}</button></li>)}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground mt-2">{busy ? "Reading your recent entries…" : hasEntries ? "The AI reads your recent entries and writes five questions that pick up where you left off." : "Once you have written an entry, the AI can write prompts that follow from it. Until then, the exercises below are a good start."}</p>
      )}
      <div className="mt-5 space-y-4" data-testid="guided-exercises">
        {GUIDED_EXERCISES.map((ex) => (
          <section key={ex.id}>
            <h3 className="text-sm font-semibold flex items-center gap-1.5"><Feather className="h-3.5 w-3.5 text-muted-foreground" />{ex.title}</h3>
            <p className="text-xs text-muted-foreground mb-1.5">{ex.about}</p>
            <ul className="space-y-1.5">
              {ex.prompts.map((p) => <li key={p}><button type="button" onClick={() => onUsePrompt(p)} className={`${chip} border-border`} data-testid="guided-prompt">{p}</button></li>)}
            </ul>
          </section>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground mt-4">Tapping a prompt puts it on a new page for you to answer. Nothing is saved until you write.</p>
    </TabPage>
  );
}
