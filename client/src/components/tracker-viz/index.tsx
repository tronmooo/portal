// Tracker micro-visualizations.
//
// Small, dependency-free SVG widgets the tracker cards render in place of a
// single bland "big number + sparkline" template. Each takes plain numbers + an
// accent color so they theme automatically (light/dark) and stay cheap. They
// mirror the style of the existing inline `Sparkline` in pages/trackers.tsx.

// Catmull-Rom → cubic-bezier smoothing so trend lines curve like the mockups
// instead of zig-zagging between points.
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
  }
  return d;
}

// ── AreaChart ─────────────────────────────────────────────────────────────────
// Lush gradient area trend (the dominant look in the mockups). Optional clinical
// `zones` paint translucent horizontal bands behind the line (HR/glucose trend).
export function AreaChart({
  values,
  color,
  height = 52,
  min,
  max,
  zones,
}: {
  values: number[];
  color: string;
  height?: number;
  min?: number;
  max?: number;
  zones?: GaugeZone[];
}) {
  if (!values || values.length < 2) return null;
  const w = 100, h = height;
  const lo = min ?? Math.min(...values);
  const hi = max ?? Math.max(...values);
  const rng = hi - lo || 1;
  const yFor = (v: number) => h - 2 - ((v - lo) / rng) * (h - 6);
  const pts = values.map((v, i) => ({ x: (i / (values.length - 1)) * w, y: yFor(v) }));
  const line = smoothPath(pts);
  const area = `${line} L ${w},${h} L 0,${h} Z`;
  const uid = `ac${color.replace(/[^a-z0-9]/gi, "")}${Math.round(h)}`;
  // Build zone bands (only when an explicit min/max range is supplied).
  let bands: { y0: number; y1: number; color: string }[] = [];
  if (zones && min != null && max != null) {
    let prev = min;
    bands = zones.map((z) => {
      const b = { y0: yFor(Math.min(z.to, max)), y1: yFor(Math.max(prev, min)), color: z.color };
      prev = z.to;
      return b;
    });
  }
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: "block" }}>
      <defs>
        <linearGradient id={uid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.5" />
          <stop offset="55%" stopColor={color} stopOpacity="0.14" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {bands.map((b, i) => (
        <rect key={i} x={0} y={Math.min(b.y0, b.y1)} width={w} height={Math.abs(b.y1 - b.y0)} fill={b.color} opacity={0.1} />
      ))}
      <path d={area} fill={`url(#${uid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// ── ZoneAreaChart ─────────────────────────────────────────────────────────────
// Activity-style chart: stacked translucent zone bands (Zone 1/2/3) with the
// trend line on top. Used for heart rate, sports, and other effort series.
export function ZoneAreaChart({
  values,
  color,
  height = 52,
  zoneColors = ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444"],
}: {
  values: number[];
  color: string;
  height?: number;
  zoneColors?: string[];
}) {
  if (!values || values.length < 2) {
    return values && values.length === 1 ? <div style={{ height }} /> : null;
  }
  const w = 100, h = height;
  const lo = Math.min(...values), hi = Math.max(...values);
  const rng = hi - lo || 1;
  const yFor = (v: number) => h - 2 - ((v - lo) / rng) * (h - 6);
  const pts = values.map((v, i) => ({ x: (i / (values.length - 1)) * w, y: yFor(v) }));
  const line = smoothPath(pts);
  const area = `${line} L ${w},${h} L 0,${h} Z`;
  const uid = `za${color.replace(/[^a-z0-9]/gi, "")}${Math.round(h)}`;
  const n = zoneColors.length;
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: "block" }}>
      <defs>
        <linearGradient id={uid} x1="0" y1="0" x2="0" y2="1">
          {zoneColors.map((c, i) => (
            <stop key={i} offset={`${(i / n) * 100}%`} stopColor={c} stopOpacity={0.32} />
          ))}
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${uid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// Personality accents — a faint oversized glyph per tracker kind, echoing the
// coffee-cup / heart / pill motifs in the design references.
export const KIND_EMOJI: Record<string, string> = {
  bp: "🩸", weight: "⚖️", sleep: "😴", run: "🏃", walk: "🚶", drop: "💧",
  flame: "🔥", music: "🎸", book: "📖", game: "🎮", brain: "🧠",
  dumbbell: "🏋️", activity: "❤️", bike: "🚴",
};

// ── RadialGauge ───────────────────────────────────────────────────────────────
// A 270° arc with the score in the center. Used for 0–10 / 0–100 "score" kinds
// (Wellness Index, Overall Health, Mood, Sleep Score).
export function RadialGauge({
  value,
  max,
  color,
  size = 76,
  unit,
}: {
  value: number;
  max: number;
  color: string;
  size?: number;
  unit?: string;
}) {
  const stroke = Math.max(5, Math.round(size * 0.09));
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  // 270° sweep starting at 135° (bottom-left), going clockwise.
  const startAngle = 135;
  const sweep = 270;
  const pct = Math.max(0, Math.min(1, max > 0 ? value / max : 0));
  const polar = (angleDeg: number) => {
    const a = (angleDeg * Math.PI) / 180;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  };
  const arcPath = (fromDeg: number, toDeg: number) => {
    const s = polar(fromDeg);
    const e = polar(toDeg);
    const large = toDeg - fromDeg > 180 ? 1 : 0;
    return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}`;
  };
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <path d={arcPath(startAngle, startAngle + sweep)} fill="none" stroke="hsl(var(--muted-foreground) / 0.14)" strokeWidth={stroke} strokeLinecap="round" />
        <path d={arcPath(startAngle, startAngle + sweep * pct)} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className="font-black tabular-nums" style={{ color, fontSize: size * 0.32 }}>
          {Number.isInteger(value) ? value : value.toFixed(1)}
        </span>
        {unit && <span className="text-muted-foreground" style={{ fontSize: size * 0.13 }}>{unit}</span>}
      </div>
    </div>
  );
}

// ── RingProgress ──────────────────────────────────────────────────────────────
// Full circular ring for goal-based kinds (Calories, Hydration, Steps). Shows
// percent toward goal with the current value in the middle.
export function RingProgress({
  pct,
  color,
  size = 72,
  centerLabel,
  sublabel,
}: {
  pct: number;
  color: string;
  size?: number;
  centerLabel?: string;
  sublabel?: string;
}) {
  const stroke = Math.max(5, Math.round(size * 0.1));
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, pct / 100));
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--muted-foreground) / 0.12)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${p * circ} ${circ}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        {centerLabel && <span className="font-black tabular-nums" style={{ color, fontSize: size * 0.26 }}>{centerLabel}</span>}
        {sublabel && <span className="text-muted-foreground mt-0.5" style={{ fontSize: size * 0.12 }}>{sublabel}</span>}
      </div>
    </div>
  );
}

export interface GaugeZone { to: number; color: string; label: string }

// ── LinearZoneGauge ───────────────────────────────────────────────────────────
// Horizontal band split into colored clinical zones with a marker at the value
// and the active zone's label. Used for measurements with reference ranges
// (BMI, Glucose, Body Fat, Cholesterol, SpO2, vitals).
export function LinearZoneGauge({
  value,
  min,
  max,
  zones,
  height = 8,
}: {
  value: number;
  min: number;
  max: number;
  zones: GaugeZone[];
  height?: number;
}) {
  const span = max - min || 1;
  const clampPct = (v: number) => Math.max(0, Math.min(100, ((v - min) / span) * 100));
  const markerPct = clampPct(value);
  // Determine the active zone for the label.
  const active = zones.find((z) => value <= z.to) || zones[zones.length - 1];
  let prev = min;
  return (
    <div className="w-full">
      <div className="relative w-full" style={{ height }}>
        <div className="absolute inset-0 flex rounded-full overflow-hidden">
          {zones.map((z, i) => {
            const w = clampPct(z.to) - clampPct(prev);
            const seg = (
              <div key={i} style={{ width: `${Math.max(0, w)}%`, background: z.color, opacity: 0.85 }} />
            );
            prev = z.to;
            return seg;
          })}
        </div>
        {/* Value marker */}
        <div
          className="absolute -top-[3px] -bottom-[3px] flex items-center"
          style={{ left: `calc(${markerPct}% - 1px)` }}
        >
          <div className="w-[2px] rounded-full bg-foreground" style={{ height: height + 6, boxShadow: "0 0 0 2px hsl(var(--card))" }} />
        </div>
      </div>
      {active && (
        <div className="flex items-center justify-between mt-1">
          <span className="text-[10px] font-semibold" style={{ color: active.color }}>{active.label}</span>
        </div>
      )}
    </div>
  );
}

// ── ChecklistMini ─────────────────────────────────────────────────────────────
// Taken / due rows for medication, supplement, and vitamin trackers.
export function ChecklistMini({
  items,
  color,
}: {
  items: { label: string; done: boolean }[];
  color: string;
}) {
  return (
    <div className="w-full space-y-1">
      {items.slice(0, 3).map((it, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span
            className="inline-flex items-center justify-center rounded-[4px] shrink-0"
            style={{
              width: 14, height: 14,
              background: it.done ? color : "transparent",
              border: it.done ? `1px solid ${color}` : "1px solid hsl(var(--muted-foreground) / 0.4)",
              color: "#fff",
            }}
          >
            {it.done && (
              <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
            )}
          </span>
          <span className={`text-[11px] truncate ${it.done ? "text-foreground" : "text-muted-foreground"}`}>{it.label}</span>
        </div>
      ))}
    </div>
  );
}

export interface PanelMetric { label: string; value: number; min: number; max: number; zones: GaugeZone[] }

// ── MultiMetricBars ───────────────────────────────────────────────────────────
// Compact labeled zone bars for panel-style trackers (lipid HDL/LDL/triglycerides,
// nutrition macros) where several reference-ranged values matter at once.
export function MultiMetricBars({ metrics }: { metrics: PanelMetric[] }) {
  return (
    <div className="w-full space-y-1.5">
      {metrics.slice(0, 3).map((m, i) => {
        const span = m.max - m.min || 1;
        const pct = Math.max(0, Math.min(100, ((m.value - m.min) / span) * 100));
        const active = m.zones.find((z) => m.value <= z.to) || m.zones[m.zones.length - 1];
        return (
          <div key={i}>
            <div className="flex items-center justify-between leading-none mb-0.5">
              <span className="text-[9px] uppercase tracking-wide text-muted-foreground truncate">{m.label}</span>
              <span className="text-[10px] font-bold tabular-nums" style={{ color: active?.color }}>{Number.isInteger(m.value) ? m.value : m.value.toFixed(1)}</span>
            </div>
            <div className="relative h-1.5 rounded-full overflow-hidden bg-muted/30">
              <div className="absolute inset-y-0 rounded-full" style={{ width: `${pct}%`, background: active?.color, opacity: 0.9 }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
