// Overview: the one screen that answers "where am I now?" for this tracker.
// Hero number chosen by metric kind, period-labelled tiles, a kind-specific
// card (macro rings, BP zones), consistency heatmap, a trend preview, the two
// most useful insights and the latest entries.

import { useState } from "react";
import {
  CalendarDays, CalendarCheck, Flame, Trophy, Gauge, Hash, ChevronRight, TrendingUp, Clock,
} from "lucide-react";
import {
  periodStats, shiftDay, filterSeries, currentStreak, longestStreak, macroSummary,
  readNumber, dayLabel, dayKeyOf, MIN_TREND_DAYS,
} from "@shared/tracker-analytics";
import { classifyBloodPressure } from "@shared/blood-pressure";
import type { TrackerModel } from "./model";
import { MACRO_HS, tone } from "./theme";
import {
  HeroMetric, StatTile, DeltaChip, SectionTitle, InsightCard, CoverageNote, RingStack,
  CalendarHeatmap, TrackerEmptyState, Segmented, fmtNum, withUnit,
} from "./primitives";
import { TrendChart } from "./TrendChart";
import { useTrackerInsights } from "./InsightsTab";

type PreviewRange = "7d" | "30d" | "90d";
const PREVIEW_DAYS: Record<PreviewRange, number> = { "7d": 7, "30d": 30, "90d": 90 };

export function OverviewTab({ model, onNavigate }: { model: TrackerModel; onNavigate: (tab: string) => void }) {
  const { theme, points, today, unit, mode, polarity, field, goal, entries } = model;
  const [range, setRange] = useState<PreviewRange>("30d");

  const from30 = shiftDay(today, -29);
  const s30 = periodStats(points, from30, today);
  const s7 = periodStats(points, shiftDay(today, -6), today);
  const loggedDays = (field ? points : model.activityDays).map((p) => p.day);
  const streak = currentStreak(loggedDays, today);
  const best = longestStreak(loggedDays);
  const insights = useTrackerInsights(model);

  const last = points[points.length - 1] ?? null;
  const spark = filterSeries(points, shiftDay(today, -29), today).map((p) => p.value);

  // ── Hero ───────────────────────────────────────────────────────────────────
  let hero: JSX.Element;
  if (model.isDual) {
    const latest = [...entries].reverse().find((e) => readNumber(e, "systolic") != null && readNumber(e, "diastolic") != null);
    const sys = latest ? readNumber(latest, "systolic")! : null;
    const dia = latest ? readNumber(latest, "diastolic")! : null;
    const verdict = sys != null && dia != null ? classifyBloodPressure(sys, dia) : null;
    hero = (
      <HeroMetric icon={theme.icon}
        eyebrow={latest ? `Latest · ${dayLabel(dayKeyOf(latest.timestamp, model.tz), { month: "short", day: "numeric" })}` : "No readings yet"}
        display={sys != null && dia != null ? `${Math.round(sys)}/${Math.round(dia)}` : "—"}
        unit="mmHg"
        caption={verdict?.label}
        spark={spark} />
    );
  } else if (!field || points.length === 0) {
    hero = (
      <HeroMetric icon={theme.icon} eyebrow="Entries logged · all time" value={entries.length}
        caption={entries.length ? `Last logged ${dayLabel(dayKeyOf(entries[entries.length - 1].timestamp, model.tz))}` : "Tap + Add to log your first entry"} />
    );
  } else if (mode === "sum") {
    const isToday = last?.day === today;
    const heroVal = last?.value ?? null;
    const avg = s30.perDay;
    const pct = heroVal != null && avg && s30.loggedDays >= 3 ? Math.round(((heroVal - avg) / Math.abs(avg)) * 100) : null;
    const good = pct == null || polarity === "neutral" ? null : (pct > 0) === (polarity === "higher");
    const goalPct = goal && heroVal != null ? Math.round((heroVal / goal.target) * 100) : null;
    hero = (
      <HeroMetric icon={theme.icon}
        eyebrow={isToday ? `Today · ${model.label}` : last ? `Last logged · ${last.label}` : model.label}
        value={heroVal} unit={unit}
        delta={pct != null ? <DeltaChip pct={pct} good={good} label="vs 30-day avg" /> : undefined}
        caption={last ? `${last.entries} ${last.entries === 1 ? "entry" : "entries"}${avg != null && s30.loggedDays > 1 ? ` · avg ${withUnit(avg, unit)} per logged day` : ""}` : undefined}
        spark={spark}
        side={goalPct != null ? (
          <RingStack size={92} stroke={9} rings={[{ pct: Math.min(100, goalPct), hs: goal!.direction === "atMost" && goalPct > 100 ? "350 80%" : theme.hs, label: "Goal" }]}
            center={<><span className="text-base metric-value">{goalPct}%</span><span className="text-[11px] text-muted-foreground">of {goal!.direction === "atMost" ? "limit" : "goal"}</span></>} />
        ) : undefined} />
    );
  } else {
    // Body measurements are about change over time (weight lost since a month
    // ago); other readings — sleep, mood, glucose — about today vs normal.
    const first30 = filterSeries(points, from30, today)[0];
    const overTime = theme.identity === "body";
    const base = overTime ? (first30 && last && first30.day !== last.day ? first30.value : null) : (s30.loggedDays >= 3 ? s30.perDay : null);
    const change = last && base != null ? last.value - base : null;
    const pct = change != null && base ? Math.round((change / Math.abs(base)) * 1000) / 10 : null;
    const good = pct == null || polarity === "neutral"
      ? (goal && change != null ? (goal.direction === "atMost" ? change < 0 : change > 0) : null)
      : (pct > 0) === (polarity === "higher");
    const deltaLabel = change == null ? "" : overTime
      ? `${change > 0 ? "+" : change < 0 ? "−" : "±"}${withUnit(Math.abs(change), unit)} in 30 days`
      : "vs 30-day avg";
    hero = (
      <HeroMetric icon={theme.icon}
        eyebrow={last ? `Latest · ${last.label}` : model.label}
        value={last?.value ?? null} unit={unit}
        delta={pct != null ? <DeltaChip pct={pct} good={good} label={deltaLabel} /> : undefined}
        caption={goal ? `Goal ${withUnit(goal.target, unit)} · ${withUnit(Math.abs(goal.target - (last?.value ?? 0)), unit)} to go` : s30.loggedDays > 1 ? `30-day avg ${withUnit(s30.perDay, unit)}` : undefined}
        spark={spark} />
    );
  }

  // ── Tiles ──────────────────────────────────────────────────────────────────
  const tiles: JSX.Element[] = [];
  if (field && points.length > 0) {
    if (model.isDual) {
      const recent = entries.filter((e) => dayKeyOf(e.timestamp, model.tz) >= from30);
      const sysVals = recent.map((e) => readNumber(e, "systolic")).filter((v): v is number => v != null);
      const diaVals = recent.map((e) => readNumber(e, "diastolic")).filter((v): v is number => v != null);
      const avg = (xs: number[]) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
      const normal = recent.filter((e) => {
        const s = readNumber(e, "systolic"), d = readNumber(e, "diastolic");
        return s != null && d != null && classifyBloodPressure(s, d).category === "normal";
      }).length;
      tiles.push(
        <StatTile key="avg" i={0} icon={Gauge} label="Average" value={avg(sysVals) != null ? `${avg(sysVals)}/${avg(diaVals)}` : "—"} basis="mmHg · last 30 days" />,
        <StatTile key="normal" i={1} icon={CalendarCheck} label="In normal range" value={recent.length ? `${Math.round((normal / recent.length) * 100)}%` : "—"} basis={`${normal} of ${recent.length} readings · 30d`} hs="152 62%" />,
      );
    } else if (mode === "sum" && points.length <= 1) {
      tiles.push(
        <StatTile key="week" i={0} icon={CalendarDays} label="This week" value={withUnit(s7.total, unit)} basis={`total · ${s7.loggedDays} of 7 days logged`} />,
        <StatTile key="days" i={1} icon={Flame} label="Days logged" value={`${s30.loggedDays}/30`} basis="last 30 days" hs="15 88%" />,
      );
    } else if (mode === "sum") {
      tiles.push(
        <StatTile key="week" i={0} icon={CalendarDays} label="This week" value={withUnit(s7.total, unit)} basis={`total · ${s7.loggedDays} of 7 days logged`} />,
        <StatTile key="avg" i={1} icon={Gauge} label="Per logged day" value={withUnit(s30.perDay, unit)} basis={`average · last 30 days`} hs={theme.hs2} />,
        <StatTile key="best" i={2} icon={Trophy} label="Best day" value={withUnit(s30.high?.value, unit)} basis={s30.high ? `${s30.high.label} · last 30 days` : "last 30 days"} hs="40 92%" />,
        <StatTile key="days" i={3} icon={Flame} label="Days logged" value={`${s30.loggedDays}/30`} basis={streak > 1 ? `${streak}-day streak` : "last 30 days"} hs="15 88%" />,
      );
    } else {
      tiles.push(
        <StatTile key="avg" i={0} icon={Gauge} label="Average" value={withUnit(s30.perDay, unit)} basis="per reading day · 30d" />,
        <StatTile key="range" i={1} icon={TrendingUp} label="Range" value={s30.low && s30.high ? `${fmtNum(s30.low.value)}–${fmtNum(s30.high.value)}` : "—"} basis={`${unit ? `${unit} · ` : ""}low to high · 30d`} hs={theme.hs2} />,
        <StatTile key="n" i={2} icon={Hash} label="Readings" value={String(s30.entries)} basis={`on ${s30.loggedDays} days · 30d`} hs="40 92%" />,
        <StatTile key="streak" i={3} icon={Flame} label="Streak" value={`${streak} ${streak === 1 ? "day" : "days"}`} basis={`longest ${best} ${best === 1 ? "day" : "days"}`} hs="15 88%" />,
      );
    }
  } else if (entries.length > 0) {
    tiles.push(
      <StatTile key="days" i={0} icon={CalendarCheck} label="Days logged" value={`${filterSeries(model.activityDays, from30, today).length}/30`} basis="last 30 days" />,
      <StatTile key="streak" i={1} icon={Flame} label="Streak" value={`${streak} ${streak === 1 ? "day" : "days"}`} basis={`longest ${best} ${best === 1 ? "day" : "days"}`} hs="15 88%" />,
    );
  }

  // ── Nutrition macros ───────────────────────────────────────────────────────
  const macros = model.isNutrition ? macroSummary(entries, model.tz, from30, today) : null;

  const previewFrom = shiftDay(today, -(PREVIEW_DAYS[range] - 1));
  const preview = filterSeries(points, previewFrom, today);
  const recent = [...entries].slice(-4).reverse();

  return (
    <div className="space-y-4" data-testid="td-overview">
      {hero}

      {tiles.length > 0 && (
        <div className={`grid gap-2.5 ${tiles.length === 4 ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-2"}`}>{tiles}</div>
      )}

      {macros && macros.energyShare && (
        <section className="bubble td-rise p-4" style={{ ["--i" as any]: 2 }} data-testid="td-macros">
          <SectionTitle title="Macro balance" hint={`Share of energy · per logged day · last 30 days (${macros.loggedDays} ${macros.loggedDays === 1 ? "day" : "days"})`} />
          <div className="flex items-center gap-5">
            <RingStack
              rings={[
                { pct: macros.energyShare.protein, hs: MACRO_HS.protein, label: "Protein" },
                { pct: macros.energyShare.carbs, hs: MACRO_HS.carbs, label: "Carbs" },
                { pct: macros.energyShare.fat, hs: MACRO_HS.fat, label: "Fat" },
              ]}
              center={macros.perDay.calories != null ? (
                <><span className="text-lg metric-value">{fmtNum(macros.perDay.calories)}</span><span className="text-[11px] text-muted-foreground">kcal/day</span></>
              ) : undefined} />
            <div className="flex-1 min-w-0 space-y-2.5">
              {(["protein", "carbs", "fat"] as const).map((k) => (
                <div key={k} className="flex items-center gap-2.5">
                  <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: tone(MACRO_HS[k]) }} />
                  <span className="text-sm capitalize flex-1">{k}</span>
                  <span className="text-sm tabular-nums font-semibold">{fmtNum(macros.perDay[k])} g</span>
                  <span className="text-xs tabular-nums text-muted-foreground w-9 text-right">{macros.energyShare![k]}%</span>
                </div>
              ))}
            </div>
          </div>
          {macros.singleEntryDays / Math.max(1, macros.loggedDays) >= 0.6 && (
            <div className="mt-3"><CoverageNote>Most days have one meal logged, so per-day numbers likely cover part of the day.</CoverageNote></div>
          )}
        </section>
      )}

      {field && points.length > 1 && !model.isDual && (
        <section className="bubble td-rise p-4" style={{ ["--i" as any]: 3 }}>
          <SectionTitle
            title={mode === "sum" ? `Daily ${model.label.toLowerCase()}` : model.label}
            hint={mode === "sum" ? "Total per day — days with nothing logged are left blank" : "Last reading each day"}
            aside={<Segmented label="Preview range" value={range} onChange={setRange}
              options={[{ value: "7d", label: "7D" }, { value: "30d", label: "30D" }, { value: "90d", label: "90D" }]} />} />
          {preview.length > 0 ? (
            <TrendChart points={preview} mode={mode} unit={unit} fromDay={previewFrom} toDay={today} height={180}
              goal={goal?.target ?? null} />
          ) : (
            <CoverageNote>Nothing logged in the last {PREVIEW_DAYS[range]} days. Last entry: {last?.label}.</CoverageNote>
          )}
          {points.length >= MIN_TREND_DAYS && (
            <button type="button" onClick={() => onNavigate("trends")} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold" style={{ color: tone("var(--td-hs)") }}>
              Full trends <ChevronRight className="h-3.5 w-3.5" />
            </button>
          )}
        </section>
      )}

      {(field ? points : model.activityDays).length > 0 && (
        <section className="bubble td-rise p-4" style={{ ["--i" as any]: 4 }} data-testid="td-consistency">
          <SectionTitle title="Consistency" hint={`${filterSeries(field ? points : model.activityDays, shiftDay(today, -111), today).length} logged days in the last 16 weeks`} />
          <CalendarHeatmap points={field ? points : model.activityDays} today={today} unit={field ? unit : "entries"} />
        </section>
      )}

      {insights.length > 0 && (
        <section className="space-y-2.5">
          <SectionTitle title="Highlights"
            aside={insights.length > 2 ? (
              <button type="button" onClick={() => onNavigate("insights")} className="inline-flex items-center gap-1 text-xs font-semibold" style={{ color: tone("var(--td-hs)") }}>
                All insights <ChevronRight className="h-3.5 w-3.5" />
              </button>
            ) : undefined} />
          {insights.slice(0, 2).map((ins, i) => <InsightCard key={ins.id} insight={ins} i={i} />)}
        </section>
      )}

      {recent.length > 0 ? (
        <section className="bubble td-rise p-4" style={{ ["--i" as any]: 5 }}>
          <SectionTitle title="Recent entries"
            aside={<button type="button" onClick={() => onNavigate("history")} className="inline-flex items-center gap-1 text-xs font-semibold" style={{ color: tone("var(--td-hs)") }}>
              History <ChevronRight className="h-3.5 w-3.5" />
            </button>} />
          <ul className="space-y-1.5">
            {recent.map((e) => {
              const v = model.isDual
                ? (readNumber(e, "systolic") != null ? `${readNumber(e, "systolic")}/${readNumber(e, "diastolic") ?? "—"}` : null)
                : field ? (readNumber(e, field) != null ? withUnit(readNumber(e, field), unit) : null) : null;
              const text = [e.values?.meal, e.values?.item, e.values?.food, e.values?.activityType, e.values?.type, e.values?.category,
                e.values?.feeling, e.values?.quality, e.values?.description, e.notes]
                .find((x) => typeof x === "string" && x.trim()) as string | undefined;
              const when = new Date(e.timestamp);
              return (
                <li key={e.id}>
                  <button type="button" onClick={() => onNavigate("history")} className="bubble-row w-full flex items-center gap-3 px-3 py-2 text-left">
                    <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm truncate">{text || (model.isDual ? "Reading" : model.label)}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {when.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · {when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                      </span>
                    </span>
                    <span className="text-sm font-semibold tabular-nums shrink-0" style={{ color: v ? tone("var(--td-hs)") : undefined }}>{v ?? <span className="text-muted-foreground font-normal text-xs">no {model.label.toLowerCase()}</span>}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <TrackerEmptyState icon={theme.icon} title="Nothing logged yet" body="Tap + Add, or tell the chat what you did — it lands here automatically." />
      )}
    </div>
  );
}
