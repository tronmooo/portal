// Tracker micro-visualizations.
//
// Small, dependency-free SVG widgets the tracker cards render in place of a
// single bland "big number + sparkline" template. Each takes plain numbers + an
// accent color so they theme automatically (light/dark) and stay cheap. They
// mirror the style of the existing inline `Sparkline` in pages/trackers.tsx.

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
