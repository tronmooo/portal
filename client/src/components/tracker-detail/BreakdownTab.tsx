// Breakdown: "what is this made of?" Every number names its basis (per logged
// day, per reading, share of total) and its period. Nutrition gets macro
// energy split with tap-to-drill top foods; blood pressure gets category
// zones; sleep gets duration bands; fitness and any tracker with a category
// field get a ranked breakdown; everyone with enough days gets a weekday
// pattern.

import { useMemo, useState } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";
import { Flame, Beef, Wheat, Droplet, Leaf, Candy, PieChart as PieIcon } from "lucide-react";
import {
  dailySeries, filterSeries, macroSummary, topContributors, readNumber, dayKeyOf, shiftDay,
  fieldLabel, fieldUnit, dayModeFor, periodStats, mean, dayLabel, type AnalyticsEntry, type DayPoint,
} from "@shared/tracker-analytics";
import { classifyBloodPressure, type BloodPressureCategory } from "@shared/blood-pressure";
import type { TrackerModel, Period } from "./model";
import { MACRO_HS, tone } from "./theme";
import {
  SectionTitle, Segmented, StatTile, CoverageNote, MeterRow, TrackerEmptyState, fmtNum, withUnit,
} from "./primitives";
import { TrendChart } from "./TrendChart";


const TEXT_LABEL_KEYS = ["meal", "item", "food", "name", "description", "activityType", "activity", "exercise", "workout", "type", "category", "merchant"];

function entryText(e: AnalyticsEntry): string | null {
  for (const k of TEXT_LABEL_KEYS) {
    const v = e.values?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** First text/select field whose values repeat — a real category, not free text. */
function categoryField(model: TrackerModel, entries: AnalyticsEntry[]): string | null {
  const candidates = (model.tracker.fields || []).filter((f) => (f.type === "text" || f.type === "select") && !/^(_?notes?|description)$/i.test(f.name));
  for (const f of candidates) {
    const vals = entries.map((e) => e.values?.[f.name]).filter((v): v is string => typeof v === "string" && v.trim() !== "");
    const distinct = new Set(vals.map((v) => v.trim().toLowerCase()));
    if (vals.length >= 3 && distinct.size >= 2 && distinct.size <= Math.max(3, vals.length * 0.7)) return f.name;
  }
  return null;
}

export function BreakdownTab({ model, period }: { model: TrackerModel; period: Period }) {
  const { today, theme, tracker } = model;
  const lastDay = model.activityDays[model.activityDays.length - 1]?.day;
  const from = period.from;
  const rangeName = period.name;
  const entries = useMemo(
    () => model.entries.filter((e) => !from || dayKeyOf(e.timestamp, model.tz) >= from),
    [model.entries, from, model.tz],
  );

  const body: JSX.Element[] = [];

  if (entries.length === 0) {
    body.push(<CoverageNote key="none">Nothing logged in the {rangeName}{lastDay ? ` — last entry ${dayLabel(lastDay)}` : ""}. Try a longer time frame.</CoverageNote>);
  } else if (model.isNutrition) {
    body.push(<NutritionBreakdown key="nut" model={model} entries={entries} from={from} rangeName={rangeName} />);
  } else if (model.isDual) {
    body.push(<BloodPressureBreakdown key="bp" entries={entries} rangeName={rangeName} />);
  } else if (theme.identity === "sleep" && model.field) {
    body.push(<SleepBreakdown key="sleep" model={model} from={from} rangeName={rangeName} />);
  }

  if (entries.length > 0 && !model.isNutrition) {
    const cat = categoryField(model, entries);
    if (cat) body.push(<CategoryBreakdown key="cat" model={model} entries={entries} field={cat} rangeName={rangeName} />);
    if (model.numericFields.length >= 2 && !model.isDual) body.push(<FieldSummaries key="fields" model={model} from={from} rangeName={rangeName} />);
  }

  const series = model.field ? filterSeries(model.points, from, today) : filterSeries(model.activityDays, from, today);
  if (series.length >= 7) {
    body.push(<WeekdayPattern key="wd" model={model} points={series} rangeName={rangeName} isCount={!model.field} />);
  }

  return (
    <div className="space-y-4" data-testid="td-breakdown">
      {body.length > 0 ? body : (
        <TrackerEmptyState icon={PieIcon} title="Not much to break down yet"
          body={`Breakdowns appear when ${tracker.name} has categories (like a type or meal) or several numbers per entry, or after a week of logging.`}
          progress={{ have: series.length, need: 7 }} />
      )}
    </div>
  );
}

// ── Nutrition ────────────────────────────────────────────────────────────────

const MACROS = [
  { key: "protein", label: "Protein", icon: Beef, kcal: 4 },
  { key: "carbs", label: "Carbs", icon: Wheat, kcal: 4 },
  { key: "fat", label: "Fat", icon: Droplet, kcal: 9 },
] as const;

function NutritionBreakdown({ model, entries, from, rangeName }: { model: TrackerModel; entries: AnalyticsEntry[]; from: string | null; rangeName: string }) {
  const [selected, setSelected] = useState<"protein" | "carbs" | "fat" | null>(null);
  const m = macroSummary(entries, model.tz, from, model.today);
  const calPoints = dailySeries(entries, "calories", { mode: "sum", tz: model.tz });
  const basis = `per logged day · ${rangeName}`;
  const pie = m.energyShare ? MACROS.map((k) => ({ key: k.key, name: k.label, value: m.energyShare![k.key], hs: MACRO_HS[k.key] })).filter((d) => d.value > 0) : [];
  const drillField = selected ?? "calories";
  const top = topContributors(entries, drillField, entryText, 5);
  const topMax = top[0]?.value || 1;
  const goal = model.field === "calories" ? model.goal : null;

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5" data-testid="td-nutrition-tiles">
        <StatTile i={0} icon={Flame} label="Calories" value={m.perDay.calories != null ? `${fmtNum(m.perDay.calories)} kcal` : "—"} basis={basis} hs={model.theme.hs} />
        {MACROS.map((k, i) => (
          <StatTile key={k.key} i={i + 1} icon={k.icon} label={k.label} value={`${fmtNum(m.perDay[k.key])} g`} basis={basis} hs={MACRO_HS[k.key]} />
        ))}
        {m.perDay.fiber != null && <StatTile i={4} icon={Leaf} label="Fiber" value={`${fmtNum(m.perDay.fiber)} g`} basis={basis} hs={MACRO_HS.fiber} />}
        {m.perDay.sugar != null && <StatTile i={5} icon={Candy} label="Sugar" value={`${fmtNum(m.perDay.sugar)} g`} basis={basis} hs={MACRO_HS.sugar} />}
      </div>

      {pie.length > 0 && (
        <section className="bubble td-rise p-4" style={{ ["--i" as any]: 2 }} data-testid="td-macro-donut">
          <SectionTitle title="Where your energy comes from" hint="Share of calories · protein & carbs 4 kcal/g, fat 9 kcal/g · tap a macro" />
          <div className="flex flex-col sm:flex-row items-center gap-4">
            <div className="relative h-[180px] w-[180px] shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pie} dataKey="value" innerRadius={58} outerRadius={84} paddingAngle={3} stroke="none"
                    startAngle={90} endAngle={-270} isAnimationActive
                    onClick={(d: any) => setSelected((cur) => (cur === d.key ? null : d.key))}>
                    {pie.map((d) => (
                      <Cell key={d.key} fill={tone(d.hs)} opacity={selected && selected !== d.key ? 0.3 : 1} style={{ cursor: "pointer", outline: "none" }} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
                {selected ? (
                  <>
                    <span className="text-2xl metric-value" style={{ color: tone(MACRO_HS[selected]) }}>{m.energyShare![selected]}%</span>
                    <span className="text-[11px] text-muted-foreground capitalize">{selected}</span>
                  </>
                ) : (
                  <>
                    <span className="text-xl metric-value">{m.perDay.calories != null ? fmtNum(m.perDay.calories) : "—"}</span>
                    <span className="text-[11px] text-muted-foreground">kcal / day</span>
                  </>
                )}
              </div>
            </div>
            <div className="w-full flex-1 space-y-2">
              {MACROS.map((k) => (
                <button key={k.key} type="button" aria-pressed={selected === k.key}
                  onClick={() => setSelected((cur) => (cur === k.key ? null : k.key))}
                  className="bubble-row w-full flex items-center gap-2.5 px-3 py-2 text-left"
                  style={selected === k.key ? { boxShadow: `inset 0 0 0 1px ${tone(MACRO_HS[k.key], 0.6)}` } : undefined}>
                  <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: tone(MACRO_HS[k.key]) }} />
                  <span className="text-sm flex-1">{k.label}</span>
                  <span className="text-sm font-semibold tabular-nums">{fmtNum(m.perDay[k.key])} g</span>
                  <span className="text-xs text-muted-foreground tabular-nums w-10 text-right">{m.energyShare?.[k.key] ?? 0}%</span>
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      {top.length > 0 && (
        <section className="bubble td-rise p-4" style={{ ["--i" as any]: 3 }} data-testid="td-top-foods">
          <SectionTitle title={selected ? `Top sources of ${selected}` : "Top foods by calories"} hint={`Summed over the ${rangeName}`} />
          <div className="space-y-3">
            {top.map((t) => (
              <MeterRow key={t.label} label={t.label} value={selected ? `${fmtNum(t.value)} g` : `${fmtNum(t.value)} kcal`}
                pct={(t.value / topMax) * 100} hs={selected ? MACRO_HS[selected] : model.theme.hs}
                sub={`${t.share}% of total · ${t.count} ${t.count === 1 ? "entry" : "entries"}`} />
            ))}
          </div>
        </section>
      )}

      {calPoints.length > 0 && (
        <section className="bubble td-rise p-4" style={{ ["--i" as any]: 4 }}>
          <SectionTitle title="Calories by day" hint={`Total logged per day${goal ? ` · ${goal.direction === "atMost" ? "bars over your limit are red" : `goal ${fmtNum(goal.target)} kcal`}` : ""} · blank days had nothing logged`} />
          <TrendChart points={calPoints} mode="sum" unit="kcal" fromDay={from ?? undefined} toDay={model.today} height={190}
            goal={goal?.target ?? null} overGoalHs={goal?.direction === "atMost" ? "350 80%" : undefined} />
        </section>
      )}

      <div className="space-y-1.5">
        {m.missingCalories > 0 && <CoverageNote>{m.missingCalories} of {m.entries} entries in the {rangeName} have no calories, so totals leave them out.</CoverageNote>}
        {m.loggedDays > 0 && m.singleEntryDays / m.loggedDays >= 0.6 && (
          <CoverageNote>{m.singleEntryDays} of {m.loggedDays} days have a single entry — per-day numbers likely reflect one meal, not a full day.</CoverageNote>
        )}
      </div>
    </>
  );
}

// ── Blood pressure ───────────────────────────────────────────────────────────

const BP_ORDER: BloodPressureCategory[] = ["low", "normal", "elevated", "high_stage1", "high_stage2", "crisis"];
const BP_STYLE: Record<BloodPressureCategory, { label: string; hs: string }> = {
  low: { label: "Low", hs: "205 80%" },
  normal: { label: "Normal", hs: "152 62%" },
  elevated: { label: "Elevated", hs: "45 92%" },
  high_stage1: { label: "High · stage 1", hs: "25 92%" },
  high_stage2: { label: "High · stage 2", hs: "355 80%" },
  crisis: { label: "Crisis", hs: "330 85%" },
};

function BloodPressureBreakdown({ entries, rangeName }: { entries: AnalyticsEntry[]; rangeName: string }) {
  const readings = entries.map((e) => ({ e, s: readNumber(e, "systolic"), d: readNumber(e, "diastolic") }))
    .filter((r): r is { e: AnalyticsEntry; s: number; d: number } => r.s != null && r.d != null);
  if (readings.length === 0) return <CoverageNote>No complete systolic/diastolic readings in the {rangeName}.</CoverageNote>;
  const counts = new Map<BloodPressureCategory, number>();
  for (const r of readings) {
    const c = classifyBloodPressure(r.s, r.d).category;
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  const slots = [
    { name: "Morning", test: (h: number) => h >= 4 && h < 12 },
    { name: "Afternoon", test: (h: number) => h >= 12 && h < 18 },
    { name: "Evening", test: (h: number) => h >= 18 || h < 4 },
  ].map((slot) => {
    const rs = readings.filter((r) => slot.test(new Date(r.e.timestamp).getHours()));
    return { ...slot, n: rs.length, s: rs.length ? Math.round(mean(rs.map((r) => r.s))) : null, d: rs.length ? Math.round(mean(rs.map((r) => r.d))) : null };
  }).filter((x) => x.n > 0);

  return (
    <>
      <section className="bubble td-rise p-4" data-testid="td-bp-zones">
        <SectionTitle title="Readings by category" hint={`${readings.length} readings · ${rangeName} · AHA categories`} />
        <div className="flex h-3 w-full overflow-hidden rounded-full mb-4">
          {BP_ORDER.filter((c) => counts.get(c)).map((c) => (
            <span key={c} style={{ width: `${(counts.get(c)! / readings.length) * 100}%`, background: tone(BP_STYLE[c].hs) }} />
          ))}
        </div>
        <div className="space-y-3">
          {BP_ORDER.filter((c) => counts.get(c)).map((c) => (
            <MeterRow key={c} label={BP_STYLE[c].label} value={`${Math.round((counts.get(c)! / readings.length) * 100)}%`}
              pct={(counts.get(c)! / readings.length) * 100} hs={BP_STYLE[c].hs} sub={`${counts.get(c)} ${counts.get(c) === 1 ? "reading" : "readings"}`} />
          ))}
        </div>
      </section>
      {slots.length > 1 && (
        <section className="bubble td-rise p-4" style={{ ["--i" as any]: 1 }}>
          <SectionTitle title="By time of day" hint="Average reading in each part of the day" />
          <div className="grid grid-cols-3 gap-2.5">
            {slots.map((s) => (
              <div key={s.name} className="bubble-row p-3 text-center">
                <p className="micro-label text-muted-foreground">{s.name}</p>
                <p className="text-lg metric-value mt-1">{s.s}/{s.d}</p>
                <p className="text-[11px] text-muted-foreground">{s.n} {s.n === 1 ? "reading" : "readings"}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

// ── Sleep ────────────────────────────────────────────────────────────────────

function SleepBreakdown({ model, from, rangeName }: { model: TrackerModel; from: string | null; rangeName: string }) {
  const pts = filterSeries(model.points, from, model.today);
  const unit = model.unit || "hours";
  const isHours = /hour|hr|^h$/i.test(unit) || pts.every((p) => p.value <= 16);
  if (!isHours || pts.length === 0) return null;
  const bands = [
    { name: "Under 6h", test: (v: number) => v < 6, hs: "355 78%" },
    { name: "6–7h", test: (v: number) => v >= 6 && v < 7, hs: "35 92%" },
    { name: "7–9h", test: (v: number) => v >= 7 && v <= 9, hs: "152 62%" },
    { name: "Over 9h", test: (v: number) => v > 9, hs: "248 70%" },
  ].map((b) => ({ ...b, n: pts.filter((p) => b.test(p.value)).length }));
  return (
    <section className="bubble td-rise p-4" data-testid="td-sleep-bands">
      <SectionTitle title="How long you slept" hint={`${pts.length} nights · ${rangeName} · 7–9 hours is the adult guideline`} />
      <div className="space-y-3">
        {bands.map((b) => (
          <MeterRow key={b.name} label={b.name} value={`${b.n} ${b.n === 1 ? "night" : "nights"}`} pct={(b.n / pts.length) * 100} hs={b.hs}
            sub={`${Math.round((b.n / pts.length) * 100)}% of nights`} />
        ))}
      </div>
    </section>
  );
}

// ── Category ─────────────────────────────────────────────────────────────────

function CategoryBreakdown({ model, entries, field, rangeName }: { model: TrackerModel; entries: AnalyticsEntry[]; field: string; rangeName: string }) {
  const weightField = model.field && model.mode === "sum" ? model.field : null;
  const groups = new Map<string, { label: string; n: number; sum: number }>();
  for (const e of entries) {
    const raw = e.values?.[field];
    if (typeof raw !== "string" || !raw.trim()) continue;
    const key = raw.trim().toLowerCase();
    const g = groups.get(key) || { label: raw.trim(), n: 0, sum: 0 };
    g.n++;
    if (weightField) g.sum += readNumber(e, weightField) ?? 0;
    groups.set(key, g);
  }
  const list = [...groups.values()].sort((a, b) => (weightField ? b.sum - a.sum : b.n - a.n)).slice(0, 8);
  const total = list.reduce((s, g) => s + (weightField ? g.sum : g.n), 0) || 1;
  const max = Math.max(...list.map((g) => (weightField ? g.sum : g.n)), 1);
  const palette = model.theme.palette;
  return (
    <section className="bubble td-rise p-4" style={{ ["--i" as any]: 1 }} data-testid="td-category">
      <SectionTitle title={`By ${fieldLabel(model.tracker, field).toLowerCase()}`}
        hint={weightField ? `Share of total ${model.label.toLowerCase()} · ${rangeName}` : `Share of entries · ${rangeName}`} />
      <div className="flex h-3 w-full overflow-hidden rounded-full mb-4">
        {list.map((g, i) => (
          <span key={g.label} style={{ width: `${((weightField ? g.sum : g.n) / total) * 100}%`, background: tone(palette[i % palette.length]) }} />
        ))}
      </div>
      <div className="space-y-3">
        {list.map((g, i) => (
          <MeterRow key={g.label} label={g.label}
            value={weightField ? withUnit(g.sum, model.unit) : `${g.n}`}
            pct={((weightField ? g.sum : g.n) / max) * 100} hs={palette[i % palette.length]}
            sub={`${Math.round(((weightField ? g.sum : g.n) / total) * 100)}% · ${g.n} ${g.n === 1 ? "entry" : "entries"}`} />
        ))}
      </div>
    </section>
  );
}

// ── Field summaries ──────────────────────────────────────────────────────────

function FieldSummaries({ model, from, rangeName }: { model: TrackerModel; from: string | null; rangeName: string }) {
  const rows = model.numericFields.map((f, i) => {
    const mode = dayModeFor(model.tracker, f.name);
    const pts = dailySeries(model.entries, f.name, { mode, tz: model.tz, fromDay: from ?? undefined });
    const s = periodStats(pts, from, model.today);
    return { f, mode, s, unit: fieldUnit(model.tracker, f.name), hs: model.theme.palette[i % model.theme.palette.length] };
  }).filter((r) => r.s.loggedDays > 0);
  if (rows.length < 2) return null;
  return (
    <section className="bubble td-rise p-4" style={{ ["--i" as any]: 2 }}>
      <SectionTitle title="Every measure" hint={`${rangeName} · totals average per logged day, readings average per day`} />
      <div className="grid grid-cols-2 gap-2.5">
        {rows.map((r) => (
          <div key={r.f.name} className="bubble-row p-3 min-w-0">
            <p className="micro-label text-muted-foreground truncate">{fieldLabel(model.tracker, r.f.name)}</p>
            <p className="text-lg metric-value mt-1 truncate" style={{ color: tone(r.hs) }}>{withUnit(r.s.perDay, r.unit)}</p>
            <p className="text-[11px] text-muted-foreground truncate">
              {r.mode === "sum" ? "per logged day" : "average"} · {fmtNum(r.s.low?.value)}–{fmtNum(r.s.high?.value)}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Weekday pattern ──────────────────────────────────────────────────────────

const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function WeekdayPattern({ model, points, rangeName, isCount }: { model: TrackerModel; points: DayPoint[]; rangeName: string; isCount: boolean }) {
  const buckets: number[][] = [[], [], [], [], [], [], []];
  for (const p of points) {
    const [y, m, d] = p.day.split("-").map(Number);
    buckets[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7].push(p.value);
  }
  const avgs = buckets.map((b) => (b.length ? mean(b) : null));
  const max = Math.max(...avgs.map((v) => v ?? 0), 1);
  const top = avgs.indexOf(Math.max(...avgs.map((v) => v ?? -Infinity)));
  const unit = isCount ? "entries" : model.unit;
  return (
    <section className="bubble td-rise p-4" style={{ ["--i" as any]: 3 }} data-testid="td-weekday">
      <SectionTitle title="Your week" hint={`${isCount ? "Average entries" : model.mode === "sum" ? "Average daily total" : "Average reading"} by weekday · ${rangeName} · logged days only`} />
      <div className="flex items-end gap-2 h-32">
        {avgs.map((v, i) => (
          <div key={WD[i]} className="flex-1 flex flex-col items-center justify-end h-full gap-1 min-w-0">
            <span className="text-[11px] tabular-nums text-muted-foreground truncate">{v != null ? (unit === "$" ? withUnit(v, unit) : fmtNum(v)) : ""}</span>
            <div className="w-full rounded-t-md rounded-b-sm bar-rise"
              style={{
                ["--i" as any]: i,
                height: v != null ? `${Math.max(6, (v / max) * 100)}%` : "4px",
                background: v == null ? "hsl(var(--muted))" : i === top ? `linear-gradient(180deg, ${tone("var(--td-hs)")}, ${tone("var(--td-hs2)")})` : tone("var(--td-hs)", 0.35),
              }} />
            <span className={`text-[11px] ${i === top ? "font-semibold" : "text-muted-foreground"}`}>{WD[i]}</span>
          </div>
        ))}
      </div>
      {avgs[top] != null && (
        <p className="text-xs text-muted-foreground mt-3">
          {WD[top]} is your {model.mode === "sum" || isCount ? "biggest" : "highest"} day on average ({withUnit(avgs[top]!, unit)}, {buckets[top].length} {buckets[top].length === 1 ? "day" : "days"}).
        </p>
      )}
    </section>
  );
}
