// Trends: "am I improving, and compared with what?" One metric at a time
// (chips switch between the tracker's numeric fields), over a chosen range,
// against the previous period of the same length. A trend sentence is only
// written once there are enough logged days to support one.

import { useMemo, useState } from "react";
import { ArrowUpRight, ArrowDownRight, Minus, LineChart as LineIcon, Trophy, TrendingDown, CalendarRange } from "lucide-react";
import {
  dailySeries, dayModeFor, polarityFor, fieldLabel, fieldUnit, rangeStartDay, filterSeries,
  periodStats, trendVerdict, rollingMean, shiftDay, daysBetween, RANGE_DAYS, MIN_TREND_DAYS,
  MIN_MOVING_AVG_DAYS, type RangeKey,
} from "@shared/tracker-analytics";
import type { TrackerModel, Period } from "./model";
import { tone } from "./theme";
import {
  SectionTitle, Segmented, StatTile, CoverageNote, TrackerEmptyState, DeltaChip, withUnit, fmtNum,
} from "./primitives";
import { TrendChart } from "./TrendChart";

export function TrendsTab({ model, period }: { model: TrackerModel; period: Period }) {
  const { tracker, today, theme } = model;
  const fields = model.numericFields;
  const [field, setField] = useState<string>(model.field && fields.some((f) => f.name === model.field) ? model.field : fields[0]?.name ?? "");
  const range = period.key;

  const mode = field ? dayModeFor(tracker, field) : "sum";
  const unit = field ? fieldUnit(tracker, field) : "";
  const label = field ? fieldLabel(tracker, field) : "";
  const polarity = field ? polarityFor(tracker, field) : "neutral";
  const all = useMemo(() => (field ? dailySeries(model.entries, field, { mode, tz: model.tz }) : []), [model.entries, field, mode, model.tz]);

  if (!field || all.length === 0) {
    return <TrackerEmptyState icon={LineIcon} title="No numbers to chart yet" body="Trends appear once entries carry a number — a weight, an amount, minutes, calories." />;
  }

  const from = rangeStartDay(range, today);
  const pts = filterSeries(all, from, today);
  const cur = periodStats(all, from, today);
  const days = range === "all" ? null : RANGE_DAYS[range];
  const prevTo = from ? shiftDay(from, -1) : null;
  const prev = days && prevTo ? periodStats(all, shiftDay(prevTo, -(days - 1)), prevTo) : null;
  const compare = (s: typeof cur) => s.perDay;
  const changePct = prev && prev.loggedDays >= 2 && cur.loggedDays >= 2 && compare(prev) ? Math.round(((compare(cur)! - compare(prev)!) / Math.abs(compare(prev)!)) * 1000) / 10 : null;
  const good = changePct == null || polarity === "neutral" ? null : (changePct > 0) === (polarity === "higher");
  const verdict = trendVerdict(pts, polarity);
  const ma = pts.length >= MIN_MOVING_AVG_DAYS ? rollingMean(pts) : undefined;
  const isPrimary = field === model.field;
  const goal = isPrimary ? model.goal?.target ?? null : null;
  const rangeName = period.name;

  const VerdictIcon = verdict.status === "rising" ? ArrowUpRight : verdict.status === "falling" ? ArrowDownRight : Minus;
  const verdictHs = verdict.tone === "good" ? "152 65%" : verdict.tone === "bad" ? "350 78%" : theme.hs;

  return (
    <div className="space-y-4" data-testid="td-trends">
      {fields.length > 1 && (
        <Segmented label="Metric" value={field} onChange={setField} testId="td-metric-chips"
          options={fields.map((f) => ({ value: f.name, label: fieldLabel(tracker, f.name) }))} />
      )}

      {/* Verdict */}
      <section className="td-hero td-rise p-4" data-testid="td-verdict">
        <div className="relative z-[1] flex items-start gap-3">
          <span className="medallion medallion-sm" style={{ ["--accent-hsl" as any]: `${verdictHs} 50%` }} aria-hidden="true">
            <VerdictIcon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            {verdict.status === "insufficient" ? (
              <>
                <p className="text-sm font-semibold">Not enough days for a trend yet</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {label} has {verdict.loggedDays} logged {verdict.loggedDays === 1 ? "day" : "days"} in the {rangeName}. Log {verdict.needed} more {verdict.needed === 1 ? "day" : "days"} and a direction will appear here.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold">
                  {label} {verdict.status === "steady" ? "is holding steady" : verdict.status === "rising" ? "is trending up" : "is trending down"}
                  {verdict.status !== "steady" && <span style={{ color: tone(verdictHs) }}> {Math.abs(verdict.pct!)}%</span>}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Fitted across {verdict.loggedDays} logged days in the {rangeName}
                  {mode === "sum" ? ", using each day's total" : ", using each day's last reading"}.
                  {verdict.tone === "good" ? " That's the direction you want." : verdict.tone === "bad" ? " That's the opposite of the direction you want." : ""}
                </p>
              </>
            )}
          </div>
        </div>
      </section>

      {/* Chart */}
      <section className="bubble td-rise p-4" style={{ ["--i" as any]: 1 }}>
        <SectionTitle
          title={mode === "sum" ? `Daily ${label.toLowerCase()}` : label}
          hint={`${mode === "sum" ? "Total per day" : "Last reading per day"}${unit ? ` · ${unit}` : ""}${ma ? " · dashed line = 7-day average" : ""}`} />
        {pts.length > 0 ? (
          <TrendChart points={pts} mode={mode} unit={unit} fromDay={from} toDay={today} movingAvg={ma} goal={goal} height={240} />
        ) : (
          <CoverageNote>Nothing logged in the {rangeName}. Try a longer time frame.</CoverageNote>
        )}
        {pts.length > 0 && pts.length < MIN_TREND_DAYS && (
          <div className="mt-2"><CoverageNote>Showing individual days as dots — {MIN_TREND_DAYS} logged days are needed before a line is meaningful.</CoverageNote></div>
        )}
      </section>

      {/* Period comparison */}
      {prev && (
        <section className="bubble td-rise p-4" style={{ ["--i" as any]: 2 }} data-testid="td-compare">
          <SectionTitle title="Compared with the period before" hint={`${mode === "sum" ? "Average daily total" : "Average reading"} over logged days`}
            aside={changePct != null ? <DeltaChip pct={changePct} good={good} /> : undefined} />
          <div className="grid grid-cols-2 gap-3">
            {[{ s: cur, name: `Last ${days} days`, hs: theme.hs }, { s: prev, name: `${days} days before`, hs: "220 10%" }].map(({ s, name, hs }) => (
              <div key={name}>
                <p className="micro-label text-muted-foreground">{name}</p>
                <p className="text-2xl metric-value mt-1" style={{ color: tone(hs) }}>{withUnit(s.perDay, unit)}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{s.loggedDays} logged {s.loggedDays === 1 ? "day" : "days"}{mode === "sum" && s.total ? ` · ${withUnit(s.total, unit)} total` : ""}</p>
              </div>
            ))}
          </div>
          {changePct == null && (
            <div className="mt-3"><CoverageNote>Both periods need at least 2 logged days for a percentage change.</CoverageNote></div>
          )}
        </section>
      )}

      {/* Highs and lows */}
      {cur.high && cur.low && cur.loggedDays > 1 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 [&>*:last-child]:col-span-2 sm:[&>*:last-child]:col-span-1">
          <StatTile i={3} icon={Trophy} label={mode === "sum" ? "Highest day" : "Highest"} value={withUnit(cur.high.value, unit)} basis={cur.high.label} hs="40 92%" />
          <StatTile i={4} icon={TrendingDown} label={mode === "sum" ? "Lowest day" : "Lowest"} value={withUnit(cur.low.value, unit)} basis={cur.low.label} hs={theme.hs2} />
          <StatTile i={5} icon={CalendarRange} label="Coverage" value={`${cur.loggedDays}/${Math.min(period.days, daysBetween(all[0].day, today) + 1)}`}
            basis={period.days > daysBetween(all[0].day, today) + 1 ? `days logged since ${all[0].label}` : "days logged"} />
        </div>
      )}

      <CoverageNote>
        {cur.entries} {cur.entries === 1 ? "entry" : "entries"} on {cur.loggedDays} {cur.loggedDays === 1 ? "day" : "days"} in the {rangeName}
        {from && all[0].day > from ? ` · tracking began ${all[0].label} (${daysBetween(all[0].day, today) + 1} days ago)` : ""}
        {` · ${fmtNum(all.length)} logged days all time.`}
      </CoverageNote>
    </div>
  );
}
