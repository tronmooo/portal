// Correlations: "does this move with anything else I track?" Compares this
// tracker's measures with each other and with the primary measure of every
// other tracker, day by day. Only pairs with enough matching days are shown;
// pairs that are arithmetically related (calories ↔ protein) are skipped; and
// the copy never claims a cause.

import { useMemo, useState } from "react";
import { ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ZAxis } from "recharts";
import { Link2, Unlink } from "lucide-react";
import type { Tracker } from "@shared/schema";
import {
  dailySeries, dayModeFor, fieldLabel, fieldUnit, pickPrimaryField, numericFieldsWithData,
  rankCorrelations, dayLabel, MIN_CORRELATION_DAYS, type SeriesSource, type CorrelationResult,
} from "@shared/tracker-analytics";
import { isAdherenceTracker } from "@shared/tracker-units";
import type { TrackerModel } from "./model";
import { tone } from "./theme";
import { SectionTitle, CoverageNote, TrackerEmptyState, withUnit } from "./primitives";

function sourcesFor(t: Tracker, tz: string, allFields: boolean): SeriesSource[] {
  if (isAdherenceTracker(t as any)) return [];
  const fields = allFields ? numericFieldsWithData(t).map((f) => f.name) : [pickPrimaryField(t)].filter(Boolean) as string[];
  return fields.map((f) => ({
    key: `${t.id}:${f}`,
    trackerId: t.id,
    label: allFields ? fieldLabel(t, f) : `${t.name}${numericFieldsWithData(t).length > 1 ? ` · ${fieldLabel(t, f)}` : ""}`,
    unit: fieldUnit(t, f),
    points: dailySeries(t.entries || [], f, { mode: dayModeFor(t, f), tz }),
  })).filter((s) => s.points.length >= 2);
}

/** Candidate correlation sources for this tracker: its own fields + others' primaries. */
export function correlationSources(model: TrackerModel, allTrackers: Tracker[]): { own: SeriesSource[]; others: SeriesSource[] } {
  const own = sourcesFor(model.tracker, model.tz, true);
  const others = allTrackers.filter((t) => t.id !== model.tracker.id).flatMap((t) => sourcesFor(t, model.tz, false));
  return { own, others };
}

export function CorrelationsTab({ model, allTrackers }: { model: TrackerModel; allTrackers: Tracker[] }) {
  const { results, near, tested } = useMemo(() => {
    const { own, others } = correlationSources(model, allTrackers);
    const ownKeys = new Set(own.map((s) => s.key));
    const ranked = rankCorrelations([...own, ...others]);
    const mine = (x: { a: SeriesSource; b: SeriesSource }) => ownKeys.has(x.a.key) || ownKeys.has(x.b.key);
    // Each other measure appears once, with whichever of this tracker's
    // measures it moves with most — four macro rows against the same sleep
    // tracker say one thing four times.
    const seen = new Set<string>();
    const oriented = ranked.results.filter(mine)
      .map((r) => (ownKeys.has(r.a.key) ? r : { ...r, a: r.b, b: r.a, pairs: r.pairs.map((p) => ({ day: p.day, x: p.y, y: p.x })) }))
      .filter((r) => (ownKeys.has(r.b.key) ? true : seen.has(r.b.key) ? false : (seen.add(r.b.key), true)));
    return { results: oriented, near: ranked.near.filter(mine).slice(0, 4), tested: ranked.tested };
  }, [model, allTrackers]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = results.find((r) => `${r.a.key}|${r.b.key}` === selectedKey) ?? results.find((r) => r.strength !== "none") ?? null;

  if (results.length === 0) {
    return (
      <div className="space-y-3" data-testid="td-correlations">
        <TrackerEmptyState icon={Unlink} title="No relationships to show yet"
          body={tested > 0
            ? `Checked ${tested} ${tested === 1 ? "pairing" : "pairings"} with ${MIN_CORRELATION_DAYS}+ matching days — none moved together more than chance would explain.${near.length ? " Closest to unlocking:" : ""}`
            : `A relationship needs at least ${MIN_CORRELATION_DAYS} days where both measures were logged. ${near.length ? "These are the closest:" : "Keep logging this alongside your other trackers — sleep, weight, workouts — and links will appear here."}`} />
        {near.map((n) => (
          <div key={`${n.a.key}|${n.b.key}`} className="bubble-row px-3.5 py-2.5">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate">{n.a.label} <span className="text-muted-foreground">vs</span> {n.b.label}</span>
              <span className="text-xs tabular-nums text-muted-foreground shrink-0">{n.n}/{MIN_CORRELATION_DAYS} days</span>
            </div>
            <div className="td-meter mt-2"><span style={{ width: `${(n.n / MIN_CORRELATION_DAYS) * 100}%`, background: tone("var(--td-hs)") }} /></div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="td-correlations">
      <div className="space-y-2.5">
        {results.slice(0, 6).map((r, i) => (
          <CorrelationCard key={`${r.a.key}|${r.b.key}`} r={r} i={i}
            selected={selected === r} onSelect={() => setSelectedKey(`${r.a.key}|${r.b.key}`)} />
        ))}
      </div>

      {selected && (
        <section className="bubble td-rise p-4" data-testid="td-scatter">
          <SectionTitle title={`${selected.a.label} vs ${selected.b.label}`} hint={`One dot per day both were logged · ${selected.n} days`} />
          <div className="h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 8, right: 12, bottom: 18, left: -4 }}>
                <CartesianGrid strokeDasharray="2 6" stroke="hsl(var(--border))" />
                <XAxis type="number" dataKey="x" name={selected.a.label} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false}
                  domain={["auto", "auto"]} label={{ value: `${selected.a.label}${selected.a.unit ? ` (${selected.a.unit})` : ""}`, position: "insideBottom", offset: -10, fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                <YAxis type="number" dataKey="y" name={selected.b.label} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} width={44} domain={["auto", "auto"]} />
                <ZAxis range={[70, 70]} />
                <Tooltip cursor={{ strokeDasharray: "3 3" }} content={({ active, payload }: any) => {
                  if (!active || !payload?.length) return null;
                  const p = payload[0].payload;
                  return (
                    <div className="surface-panel bg-popover px-3 py-2 text-xs">
                      <p className="font-semibold">{dayLabel(p.day, { weekday: "short", month: "short", day: "numeric" })}</p>
                      <p>{selected.a.label}: <b>{withUnit(p.x, selected.a.unit)}</b></p>
                      <p>{selected.b.label}: <b>{withUnit(p.y, selected.b.unit)}</b></p>
                    </div>
                  );
                }} />
                <Scatter data={selected.pairs} fill={tone("var(--td-hs)", 0.8)} stroke={tone("var(--td-hs2)")} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      <CoverageNote>
        Correlation shows two things moving together on the same days — not that one causes the other. Pearson's r (−1 to 1) over {MIN_CORRELATION_DAYS}+ matching days; of {tested} pairings checked, only links unlikely to be chance are shown.
      </CoverageNote>
    </div>
  );
}

function CorrelationCard({ r, i, selected, onSelect }: { r: CorrelationResult; i: number; selected: boolean; onSelect: () => void }) {
  const hs = r.strength === "none" ? "220 10%" : r.direction === "positive" ? "152 62%" : "265 72%";
  const width = Math.abs(r.r) * 50;
  return (
    <button type="button" onClick={onSelect} aria-pressed={selected}
      className="bubble bubble-interactive pressable td-rise w-full text-left p-3.5"
      style={{ ["--i" as any]: i, ["--accent-hsl" as any]: `${hs} 50%` }}>
      <div className="flex items-start gap-3">
        <span className="medallion medallion-sm" aria-hidden="true"><Link2 className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold truncate">{r.a.label} <span className="text-muted-foreground font-normal">&</span> {r.b.label}</p>
            <span className="text-xs font-bold tabular-nums shrink-0" style={{ color: tone(hs) }}>r = {r.r.toFixed(2)}</span>
          </div>
          {/* −1 … 0 … +1 gauge */}
          <div className="relative mt-2 h-1.5 rounded-full bg-muted">
            <span className="absolute top-0 h-full w-px bg-foreground/30" style={{ left: "50%" }} />
            <span className="absolute top-0 h-full rounded-full" style={{ left: r.r >= 0 ? "50%" : `${50 - width}%`, width: `${width}%`, background: tone(hs) }} />
          </div>
          <p className="text-xs text-muted-foreground mt-2 leading-relaxed">{r.sentence}</p>
        </div>
      </div>
    </button>
  );
}
