// Customize Wellness — the dialog behind the Wellness tab's "Customize" button.
//
// Owner's design, 2026-11-23: Visible Sections (drag to reorder, a switch per
// section), Available Sections (tap to add), Display Options (default time
// range, card size, trend graphs, comparison %, last updated) — plus the
// dashboards strip and the three ways to make a card: a Widget Idea, the
// manual builder, the AI Builder.
//
// It is the Wellness face of the SAME system as Customize Executive
// (shared/dashboard-engine): everything edits a DRAFT. Opening writes nothing
// (Rule 3); Save Changes writes the one preference row (`wellness_card_prefs`,
// on the account, never browser storage); Cancel drops the draft. Removing a
// card or a dashboard takes two taps (Rule 8) and deletes no health record.
// The AI Builder proposes; the user adds (W5).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity, ChevronRight, Copy, Dumbbell, FlaskConical, GripVertical, HeartPulse, LayoutDashboard, LineChart, Link2, Moon,
  NotebookPen, Pill, Plus, RotateCcw, Settings, Smile, Sparkles, Star, Target, Trash2, TrendingUp, Utensils, Gauge, type LucideIcon,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { BubbleModal } from "@/components/ui/bubble-modal";
import { useToast } from "@/hooks/use-toast";
import { WIDGET_ICON } from "@/components/dashboard/ExecCustomize";
import { isWidgetCardId, widgetCardId } from "@shared/dashboard-engine";
import {
  MAX_DASHBOARDS, WELLNESS_PREFS_KEY, WELLNESS_TEMPLATES, activeWellnessBoard, addWellnessDashboard, addWellnessDashboardWithWidgets, addWellnessWidget,
  defaultWellnessBoards, duplicateWellnessWidget, hiddenWellnessCards, orderedWellnessCards, parseWellnessBoards, placeWellnessCard,
  removeWellnessBoard, removeWellnessWidget, renameWellnessBoard, resetWellnessLayout, serializeWellnessBoards, setActiveWellnessBoard,
  setWellnessCardSize, setWellnessCardVisible, setWellnessOptions, updateWellnessWidget, visibleWellnessCards, wellnessCardHint,
  wellnessCardSize, wellnessCardTitle,
  type WellnessBoards, type WellnessBuiltInCardId, type WellnessCardId,
} from "@shared/wellness-dashboards";
import { RANGE_LABEL, RANGE_WORDS, WELLNESS_RANGES, type WellnessRange } from "@shared/wellness-period";
import {
  MAX_WELLNESS_WIDGETS, WELLNESS_CALCS, WELLNESS_CALC_LABELS, WELLNESS_DISPLAYS, WELLNESS_DISPLAY_LABELS, WELLNESS_SOURCE_KINDS,
  WELLNESS_WIDGET_IDEAS, buildWellnessWidgetView, findTrackerByName, groundWellnessWidget, sanitizeWellnessWidget, suggestWellnessWidgets, trackerNumberFields,
  type ScorePart, type SeriesRef, type WellnessSourceData, type WellnessSourceKind, type WellnessWidget,
} from "@shared/wellness-widgets";
import { CANONICAL_METRICS } from "@shared/wellness-canon";
import { CardError, WidgetViewBody, type ListState } from "./WellnessCards";

const QUERY_KEY = [`/api/preferences/${WELLNESS_PREFS_KEY}`];
const PURPLE = "265 85% 66%";

/** The Wellness layout, on the account. The screen follows a change at once; the save follows behind it. */
export function useWellnessPrefs(enabled = true) {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery<WellnessBoards>({
    queryKey: QUERY_KEY,
    enabled,
    queryFn: () => apiRequest("GET", `/api/preferences/${WELLNESS_PREFS_KEY}`).then((r) => r.json()).then((d) => parseWellnessBoards(d?.value)),
    staleTime: 5 * 60_000,
  });
  const save = useMutation({
    mutationFn: async (next: WellnessBoards) => {
      await apiRequest("PUT", `/api/preferences/${WELLNESS_PREFS_KEY}`, { value: serializeWellnessBoards(next) });
      return next;
    },
    onError: () => { queryClient.invalidateQueries({ queryKey: QUERY_KEY }); },
  });
  const boards = useMemo(() => data ?? defaultWellnessBoards(), [data]);
  return {
    /** False only while the stored choice is on its way; a failed read settles too (the defaults apply). */
    loaded: !enabled || !isPending,
    boards,
    saving: save.isPending,
    setBoards: (next: WellnessBoards) => {
      queryClient.setQueryData(QUERY_KEY, next);
      return save.mutateAsync(next);
    },
  };
}

// ── Looks ────────────────────────────────────────────────────────────────────

export const WELLNESS_CARD_ICON: Record<WellnessBuiltInCardId, { icon: LucideIcon; hsl: string }> = {
  overview: { icon: Activity, hsl: "330 75% 62%" }, trends: { icon: TrendingUp, hsl: "262 70% 62%" },
  activity: { icon: Dumbbell, hsl: "38 96% 54%" }, sleep: { icon: Moon, hsl: "240 60% 65%" },
  nutrition: { icon: Utensils, hsl: "25 90% 58%" }, body: { icon: HeartPulse, hsl: "173 60% 44%" },
  labs: { icon: FlaskConical, hsl: "199 89% 60%" }, medications: { icon: Pill, hsl: "0 72% 58%" },
  sources: { icon: Link2, hsl: "213 90% 62%" }, insights: { icon: Sparkles, hsl: "262 70% 62%" },
  mood: { icon: Smile, hsl: "38 96% 54%" }, symptoms: { icon: NotebookPen, hsl: "25 90% 58%" },
  graphs: { icon: LineChart, hsl: "199 89% 60%" }, goals: { icon: Target, hsl: "155 65% 45%" }, score: { icon: Gauge, hsl: "330 75% 62%" },
};
export const wellnessCardIcon = (b: Pick<WellnessBoards, "widgets">, id: WellnessCardId): { icon: LucideIcon; hsl: string } => {
  if (isWidgetCardId(id)) {
    const w = b.widgets.find((x) => widgetCardId(x.id) === id);
    return { icon: w ? WIDGET_ICON[w.icon] : Star, hsl: PURPLE };
  }
  return WELLNESS_CARD_ICON[id];
};

function Switch({ on, onChange, label, testId }: { on: boolean; onChange: (v: boolean) => void; label: string; testId: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} data-testid={testId}
      className={`touch-hit relative shrink-0 h-6 w-11 rounded-full transition-colors ${on ? "bg-violet-500" : "bg-muted-foreground/30"}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

const field = "h-8 rounded-lg border border-border bg-background/60 px-2 text-[13px]";
const chip = (on: boolean) => `rounded-full px-2.5 py-1 text-[12px] font-semibold ${on ? "text-foreground" : "border border-border text-muted-foreground hover:bg-muted"}`;
const chipStyle = (on: boolean) => (on ? { background: `hsl(${PURPLE} / 0.35)`, boxShadow: `inset 0 0 0 1px hsl(${PURPLE} / 0.7)` } : undefined);

// ── A widget, drawn from the records (card and preview share this) ───────────

export interface WellnessLists { journal: ListState; expenses: ListState }

export function WellnessWidgetCardBody({ widget, data, lists, range, todayISO, showWorking = true }: {
  widget: WellnessWidget; data: WellnessSourceData; lists: WellnessLists; range: WellnessRange; todayISO: string; showWorking?: boolean;
}) {
  const view = buildWellnessWidgetView(widget, data, range, todayISO);
  if (!view) {
    // A list the widget reads has not arrived: loading, or failed (Rule 7).
    const failed = [lists.journal, lists.expenses].filter((l) => l.error);
    if (failed.length) return <CardError onRetry={() => failed.forEach((l) => l.retry?.())} testId={`wellness-widget-error-${widget.id}`} />;
    return <p className="text-xs text-muted-foreground" data-testid={`wellness-widget-loading-${widget.id}`}>Loading…</p>;
  }
  return <WidgetViewBody id={widget.id} view={view} showWorking={showWorking} />;
}

// ── Picking a source ─────────────────────────────────────────────────────────

const SOURCE_NAME: Record<WellnessSourceKind, string> = { metric: "Health measurement", tracker: "Tracker", workouts: "Workouts", mood: "Journal mood", spending: "Health spending" };

function SourcePicker({ value, onChange, data, label, testId }: {
  value: SeriesRef; onChange: (next: SeriesRef) => void; data: WellnessSourceData; label: string; testId: string;
}) {
  const withData = CANONICAL_METRICS.filter((m) => data.metrics.get(m.id)?.latest);
  const rest = CANONICAL_METRICS.filter((m) => !data.metrics.get(m.id)?.latest);
  const trackers = data.trackers.filter((t) => t?.name);
  const tracker = value.kind === "tracker" ? findTrackerByName(trackers, value.key || "") : null;
  const setKind = (kind: WellnessSourceKind) => onChange(
    kind === "metric" ? { kind, key: (withData[0] ?? CANONICAL_METRICS[0]).id }
      : kind === "tracker" ? { kind, key: trackers[0]?.name ?? "" }
      : { kind });
  return (
    <div className="space-y-1.5" data-testid={testId}>
      <label className="block text-[11px] text-muted-foreground">{label}</label>
      <div className="flex flex-wrap gap-1.5">
        <select value={value.kind} onChange={(e) => setKind(e.target.value as WellnessSourceKind)} aria-label={`${label}: data source`}
          className={`${field} flex-1 min-w-[130px]`} data-testid={`${testId}-kind`}>
          {WELLNESS_SOURCE_KINDS.map((k) => <option key={k} value={k}>{SOURCE_NAME[k]}</option>)}
        </select>
        {value.kind === "metric" && (
          <select value={value.key} onChange={(e) => onChange({ kind: "metric", key: e.target.value })} aria-label={`${label}: measurement`}
            className={`${field} flex-1 min-w-[130px]`} data-testid={`${testId}-metric`}>
            {withData.length > 0 && <optgroup label="With data">{withData.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</optgroup>}
            <optgroup label="Not recorded yet">{rest.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</optgroup>
          </select>
        )}
        {value.kind === "tracker" && (
          trackers.length === 0 ? <span className="text-[12px] text-muted-foreground self-center">No trackers yet.</span> : (
            <>
              <select value={tracker?.name ?? ""} onChange={(e) => onChange({ kind: "tracker", key: e.target.value })} aria-label={`${label}: tracker`}
                className={`${field} flex-1 min-w-[130px]`} data-testid={`${testId}-tracker`}>
                {trackers.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
              </select>
              <select value={value.field ?? ""} onChange={(e) => onChange({ kind: "tracker", key: value.key, ...(e.target.value ? { field: e.target.value } : {}) })}
                aria-label={`${label}: field`} className={`${field} flex-1 min-w-[110px]`} data-testid={`${testId}-field`}>
                <option value="">Count entries</option>
                {(tracker ? trackerNumberFields(tracker) : []).map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </>
          )
        )}
        {(value.kind === "workouts" || value.kind === "spending") && (
          <input value={value.key ?? ""} onChange={(e) => onChange({ kind: value.kind, ...(e.target.value ? { key: e.target.value } : {}) })}
            placeholder={value.kind === "workouts" ? "All workouts, or a word: run" : "All health spending, or a word: pharmacy"}
            aria-label={`${label}: containing`} maxLength={40} className={`${field} flex-1 min-w-[130px]`} data-testid={`${testId}-match`} />
        )}
      </div>
    </div>
  );
}

// ── The manual builder / editor ──────────────────────────────────────────────

type Raw = Record<string, any>;
const firstMetric = (data: WellnessSourceData): SeriesRef => ({ kind: "metric", key: (CANONICAL_METRICS.find((m) => data.metrics.get(m.id)?.latest) ?? CANONICAL_METRICS.find((m) => m.id === "sleep_hours")!).id });
export const blankWidget = (data: WellnessSourceData): Raw => ({ title: "", icon: "heart", kind: "metric", source: firstMetric(data), calc: "average", display: "line", by: "manual" });

/**
 * Every part of a card is editable: what it reads, the calculation, how it is
 * drawn, its own time range. The form holds the raw text being typed; the
 * caller receives a widget only when it passes `sanitizeWellnessWidget`.
 */
export function WellnessWidgetForm({ initial, id, onValid, data, testId = "wellness-widget-form" }: {
  initial: Raw; id: string; onValid: (w: WellnessWidget | null) => void; data: WellnessSourceData; testId?: string;
}) {
  const [raw, setRaw] = useState<Raw>(initial);
  const set = (patch: Raw) => {
    const next = { ...raw, ...patch };
    setRaw(next);
    onValid(sanitizeWellnessWidget({ ...next, id }, id));
  };
  const setKind = (kind: string) => set({
    kind,
    source: raw.source ?? firstMetric(data),
    ...(kind === "compare" && !raw.other ? { other: { kind: "workouts" } } : {}),
    ...(kind === "score" && !(raw.parts || []).length ? { parts: [{ source: raw.source ?? firstMetric(data), weight: 5, target: 8, better: "higher" }] } : {}),
  });
  const parts: ScorePart[] = Array.isArray(raw.parts) ? raw.parts : [];
  const setPart = (i: number, patch: Partial<ScorePart>) => set({ parts: parts.map((p, k) => (k === i ? { ...p, ...patch } : p)) });
  return (
    <div className="space-y-2.5" data-testid={testId}>
      <div>
        <label className="block text-[11px] text-muted-foreground" htmlFor={`${testId}-title`}>Widget name</label>
        <input id={`${testId}-title`} value={raw.title ?? ""} onChange={(e) => set({ title: e.target.value })} maxLength={40}
          placeholder="Exercise consistency" className={`${field} w-full font-semibold`} data-testid={`${testId}-title`} />
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Kind of widget">
        {([["metric", "One measure"], ["compare", "Compare two"], ["score", "Custom score"]] as const).map(([k, name]) => (
          <button key={k} type="button" aria-pressed={raw.kind === k} onClick={() => setKind(k)} className={chip(raw.kind === k)} style={chipStyle(raw.kind === k)}
            data-testid={`${testId}-kind-${k}`}>{name}</button>
        ))}
      </div>

      {raw.kind === "metric" && (
        <>
          <SourcePicker label="Data source" value={raw.source} onChange={(source) => set({ source })} data={data} testId={`${testId}-source`} />
          <div>
            <label className="block text-[11px] text-muted-foreground" htmlFor={`${testId}-calc`}>Calculation</label>
            <select id={`${testId}-calc`} value={raw.calc} onChange={(e) => set({ calc: e.target.value })} className={`${field} w-full`} data-testid={`${testId}-calc`}>
              {WELLNESS_CALCS.map((c) => <option key={c} value={c}>{WELLNESS_CALC_LABELS[c]}</option>)}
            </select>
          </div>
          <div>
            <p className="text-[11px] text-muted-foreground mb-1">Display type</p>
            <div className="grid grid-cols-2 gap-1.5">
              {WELLNESS_DISPLAYS.map((d) => (
                <button key={d} type="button" aria-pressed={raw.display === d} onClick={() => set({ display: d })}
                  className={`${chip(raw.display === d)} !rounded-lg py-1.5`} style={chipStyle(raw.display === d)} data-testid={`${testId}-display-${d}`}>{WELLNESS_DISPLAY_LABELS[d]}</button>
              ))}
            </div>
          </div>
        </>
      )}

      {raw.kind === "compare" && (
        <>
          <SourcePicker label="Group the days by" value={raw.source} onChange={(source) => set({ source })} data={data} testId={`${testId}-source`} />
          <div className="flex flex-wrap gap-1.5 items-end">
            <div className="flex-1 min-w-[120px]">
              <label className="block text-[11px] text-muted-foreground" htmlFor={`${testId}-threshold`}>At or above (blank = the middle value)</label>
              <input id={`${testId}-threshold`} type="number" inputMode="decimal" value={raw.threshold ?? ""} placeholder="8"
                onChange={(e) => set({ threshold: e.target.value === "" ? undefined : Number(e.target.value) })} className={`${field} w-full`} data-testid={`${testId}-threshold`} />
            </div>
            <select value={raw.lag === 1 ? "1" : "0"} onChange={(e) => set({ lag: Number(e.target.value) })} aria-label="Which day is compared"
              className={`${field} flex-1 min-w-[120px]`} data-testid={`${testId}-lag`}>
              <option value="0">Compare the same day</option>
              <option value="1">Compare the day after</option>
            </select>
          </div>
          <SourcePicker label="Compare" value={raw.other ?? { kind: "workouts" }} onChange={(other) => set({ other })} data={data} testId={`${testId}-other`} />
        </>
      )}

      {raw.kind === "score" && (
        <div className="space-y-2">
          {parts.map((p, i) => (
            <div key={i} className="rounded-lg border border-border/60 p-2 space-y-1.5" data-testid={`${testId}-part-${i}`}>
              <SourcePicker label={`Part ${i + 1}`} value={p.source} onChange={(source) => setPart(i, { source })} data={data} testId={`${testId}-part-${i}-source`} />
              <div className="flex flex-wrap gap-1.5 items-end">
                <label className="text-[11px] text-muted-foreground flex-1 min-w-[84px]">Target per day
                  <input type="number" inputMode="decimal" value={p.target ?? ""} onChange={(e) => setPart(i, { target: Number(e.target.value) })}
                    className={`${field} w-full`} data-testid={`${testId}-part-${i}-target`} />
                </label>
                <label className="text-[11px] text-muted-foreground w-[70px]">Weight
                  <input type="number" min={1} max={10} value={p.weight ?? 1} onChange={(e) => setPart(i, { weight: Number(e.target.value) })}
                    className={`${field} w-full`} data-testid={`${testId}-part-${i}-weight`} />
                </label>
                <select value={p.better} onChange={(e) => setPart(i, { better: e.target.value as ScorePart["better"] })} aria-label={`Part ${i + 1}: which way is better`}
                  className={`${field} flex-1 min-w-[110px]`}>
                  <option value="higher">Higher is better</option>
                  <option value="lower">Lower is better</option>
                </select>
                {parts.length > 1 && (
                  <button type="button" onClick={() => set({ parts: parts.filter((_, k) => k !== i) })} aria-label={`Remove part ${i + 1}`}
                    className="touch-hit rounded-md p-1.5 text-muted-foreground hover:text-foreground"><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
                )}
              </div>
            </div>
          ))}
          {parts.length < 6 && (
            <button type="button" onClick={() => set({ parts: [...parts, { source: { kind: "workouts" }, weight: 3, target: 0.5, better: "higher" }] })}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-1 text-[12px] font-semibold text-muted-foreground hover:bg-muted"
              data-testid={`${testId}-part-add`}><Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add a part</button>
          )}
        </div>
      )}

      <div>
        <p className="text-[11px] text-muted-foreground mb-1">Time range</p>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" aria-pressed={!raw.range} onClick={() => set({ range: undefined })} className={chip(!raw.range)} style={chipStyle(!raw.range)}
            data-testid={`${testId}-range-inherit`}>Follow the tab</button>
          {WELLNESS_RANGES.map((r) => (
            <button key={r} type="button" aria-pressed={raw.range === r} onClick={() => set({ range: r })} className={chip(raw.range === r)} style={chipStyle(raw.range === r)}
              data-testid={`${testId}-range-${r}`}>{RANGE_LABEL[r]}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── The dialog ───────────────────────────────────────────────────────────────

export function WellnessCustomizeDialog({ open, onClose, data, lists, range, todayISO }: {
  open: boolean; onClose: () => void;
  /** The subject's records, so a preview reads exactly what its card will. */
  data: WellnessSourceData; lists: WellnessLists;
  /** The range the tab is showing (a preview with no range of its own follows it). */
  range: WellnessRange; todayISO: string;
}) {
  const { boards, setBoards, saving } = useWellnessPrefs(open);
  const { toast } = useToast();
  const [draft, setDraft] = useState<WellnessBoards>(boards);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [newBoardOpen, setNewBoardOpen] = useState(false);
  const [builder, setBuilder] = useState<null | "manual" | "ai">(null);
  const [building, setBuilding] = useState<WellnessWidget | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [proposal, setProposal] = useState<{ widgets: WellnessWidget[]; by: "ai" | "rules"; name?: string; dropped: number } | null>(null);
  const touched = useRef(false);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      touched.current = false;
      setDraft(boards); setExpanded(null); setArmed(null); setNewBoardOpen(false); setBuilder(null); setBuilding(null); setPrompt(""); setProposal(null);
    }
    wasOpen.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // The stored choice can land after the dialog is open: adopt it if nothing was touched yet.
  useEffect(() => {
    if (open && !touched.current) setDraft(boards);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boards]);
  const edit = (next: WellnessBoards) => { touched.current = true; setDraft(next); };
  const board = activeWellnessBoard(draft);
  const visible = visibleWellnessCards(draft);
  const hidden = hiddenWellnessCards(draft);
  const dirty = serializeWellnessBoards(draft) !== serializeWellnessBoards(boards);
  const arm = (key: string, run: () => void) => {
    if (armed !== key) { setArmed(key); setTimeout(() => setArmed((k) => (k === key ? null : k)), 4000); return; }
    setArmed(null); run();
  };

  const suggest = useMutation({
    mutationFn: async (text: string) => {
      const r = await apiRequest("GET", `/api/wellness-widgets/suggest?prompt=${encodeURIComponent(text)}`);
      const body = await r.json();
      const raw: unknown[] = Array.isArray(body?.widgets) ? body.widgets : [body?.widget];
      const widgets: WellnessWidget[] = [];
      let dropped = 0;
      raw.forEach((x, i) => {
        const clean = sanitizeWellnessWidget(x, `widget-${i + 1}`);
        // Held to THIS person's trackers: a card over a tracker they do not
        // have could only ever say "nothing recorded".
        const ok = clean ? groundWellnessWidget(clean, data.trackers) : null;
        if (ok) widgets.push({ ...ok, id: `proposal-${widgets.length + 1}` }); else dropped++;
      });
      if (!widgets.length) throw new Error("Unexpected response");
      const name = typeof body?.name === "string" ? body.name.replace(/\s+/g, " ").trim().slice(0, 24) : "";
      return { widgets, by: body?.by === "ai" ? "ai" as const : "rules" as const, dropped, ...(name ? { name } : {}) };
    },
    onSuccess: (p) => setProposal(p),
  });
  // Cards offered from what this person actually tracks (shared/wellness-widgets).
  const fromTrackers = useMemo(() => suggestWellnessWidgets(data, draft.widgets), [data, draft.widgets]);
  const dropProposal = (id: string) => setProposal((p) => {
    if (!p) return p;
    const widgets = p.widgets.filter((w) => w.id !== id);
    return widgets.length ? { ...p, widgets } : null;
  });

  // ── Reorder: drag the handle (pointer or touch), or arrow keys on it ───────
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const [dragId, setDragId] = useState<string | null>(null);
  const moveWithin = (id: WellnessCardId, dir: -1 | 1) => {
    const neighbour = visible[visible.indexOf(id) + dir];
    if (neighbour) edit(placeWellnessCard(draft, id, orderedWellnessCards(draft).indexOf(neighbour)));
  };
  const dragOver = (id: WellnessCardId, clientY: number) => {
    const full = orderedWellnessCards(draft);
    const me = full.indexOf(id);
    for (const other of visible) {
      if (other === id) continue;
      const r = rowRefs.current.get(other)?.getBoundingClientRect();
      if (!r) continue;
      const mid = r.top + r.height / 2;
      const at = full.indexOf(other);
      if ((me < at && clientY > mid) || (me > at && clientY < mid)) { edit(placeWellnessCard(draft, id, at)); return; }
    }
  };

  const add = (base: Omit<WellnessWidget, "id">, said = "added") => {
    const { boards: next, widget } = addWellnessWidget(draft, base);
    if (!widget) {
      toast({ title: draft.widgets.length >= MAX_WELLNESS_WIDGETS ? `You can keep ${MAX_WELLNESS_WIDGETS} custom cards` : "That card is not complete yet", variant: "destructive" });
      return false;
    }
    edit(next);
    toast({ title: `${widget.title} ${said}`, description: "Press Save Changes to put it on your Wellness tab." });
    return true;
  };

  const save = async () => {
    try {
      await setBoards(draft);
      toast({ title: "Wellness tab updated" });
      onClose();
    } catch {
      toast({ title: "Couldn't save your changes", description: "Nothing was changed. Try again.", variant: "destructive" });
    }
  };

  const row = (id: WellnessCardId, on: boolean) => {
    const title = wellnessCardTitle(draft, id);
    const { icon: Icon, hsl } = wellnessCardIcon(draft, id);
    const isOpen = expanded === id;
    const widget = isWidgetCardId(id) ? draft.widgets.find((w) => widgetCardId(w.id) === id) : undefined;
    return (
      <li key={id} ref={(el) => { if (el) rowRefs.current.set(id, el); else rowRefs.current.delete(id); }}
        className={`rounded-xl border border-border/70 bg-background/40 ${dragId === id ? "ring-1 ring-primary/60" : ""}`} data-testid={`wellness-customize-row-${id}`}>
        <div className="flex items-center gap-2 px-2 py-2 min-w-0">
          {on ? (
            <button type="button" aria-label={`Reorder ${title}. Drag, or use the arrow keys.`} data-testid={`wellness-customize-drag-${id}`} data-swipe-ignore
              className={`touch-hit shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing ${dragId === id ? "text-foreground" : ""}`}
              style={{ touchAction: "none" }}
              onPointerDown={(e) => { e.preventDefault(); try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* jsdom */ } setDragId(id); }}
              onPointerMove={(e) => { if (dragId === id) dragOver(id, e.clientY); }}
              onPointerUp={() => setDragId(null)} onPointerCancel={() => setDragId(null)}
              onKeyDown={(e) => {
                if (e.key === "ArrowUp") { e.preventDefault(); moveWithin(id, -1); }
                if (e.key === "ArrowDown") { e.preventDefault(); moveWithin(id, 1); }
              }}>
              <GripVertical className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground/40 mx-1" aria-hidden="true" />}
          <Icon className="h-5 w-5 shrink-0" style={{ color: `hsl(${hsl})` }} aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <p className={`text-[14px] font-semibold leading-tight truncate ${on ? "" : "text-muted-foreground"}`}>{title}</p>
            {(!on || widget) && <p className="text-[11px] text-muted-foreground leading-tight line-clamp-2 mt-0.5">{wellnessCardHint(draft, id)}</p>}
          </div>
          <Switch on={on} onChange={(v) => edit(setWellnessCardVisible(draft, id, v))} label={`Show ${title}`} testId={`wellness-customize-show-${id}`} />
          {on ? (
            <button type="button" onClick={() => setExpanded(isOpen ? null : id)} aria-expanded={isOpen} aria-label={`Details of ${title}`}
              className="touch-hit shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground" data-testid={`wellness-customize-more-${id}`}>
              <ChevronRight className={`h-4 w-4 transition-transform ${isOpen ? "rotate-90" : ""}`} aria-hidden="true" />
            </button>
          ) : (
            <button type="button" onClick={() => edit(setWellnessCardVisible(draft, id, true))} aria-label={`Add ${title}`}
              className="touch-hit shrink-0 rounded-full border border-border p-1 text-muted-foreground hover:text-foreground" data-testid={`wellness-customize-add-${id}`}>
              <Plus className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
        {on && isOpen && (
          <div className="px-3 pb-3 pt-2 border-t border-border/50 space-y-2.5" data-testid={`wellness-customize-details-${id}`}>
            {!widget && <p className="text-[12px] text-muted-foreground">{wellnessCardHint(draft, id)}</p>}
            <div className="flex items-center gap-2">
              <label className="text-[12px] text-muted-foreground" htmlFor={`wellness-size-${id}`}>Size</label>
              <select id={`wellness-size-${id}`} value={wellnessCardSize(draft, id)} onChange={(e) => edit(setWellnessCardSize(draft, id, e.target.value as "large" | "medium"))}
                className={`${field} w-[150px]`} data-testid={`wellness-customize-size-${id}`}>
                <option value="large">Full width</option>
                <option value="medium">Half width</option>
              </select>
            </div>
            {widget && (
              <>
                <WellnessWidgetForm key={widget.id} initial={widget} id={widget.id} data={data} testId={`wellness-edit-${widget.id}`}
                  onValid={(w) => { if (w) edit(updateWellnessWidget(draft, w)); }} />
                <p className="micro-label text-muted-foreground">Preview, from your records</p>
                <div className="rounded-lg border border-border/60 p-2">
                  <WellnessWidgetCardBody widget={widget} data={data} lists={lists} range={range} todayISO={todayISO} />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button type="button" onClick={() => { const r = duplicateWellnessWidget(draft, widget.id); if (r.widget) edit(r.boards); }}
                    className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[12px] font-semibold text-muted-foreground hover:bg-muted"
                    data-testid={`wellness-customize-duplicate-${widget.id}`}><Copy className="h-3.5 w-3.5" aria-hidden="true" /> Duplicate</button>
                  <button type="button" onClick={() => arm(`w:${widget.id}`, () => { edit(removeWellnessWidget(draft, widget.id)); setExpanded(null); })}
                    title="Removes this card from every dashboard. Your health records are not touched."
                    className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] font-semibold ${armed === `w:${widget.id}` ? "border-red-500/50 bg-red-500/15 text-red-500" : "border-border text-muted-foreground hover:bg-muted"}`}
                    data-testid={`wellness-customize-remove-${widget.id}`}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> {armed === `w:${widget.id}` ? "Tap again to remove" : "Remove this card"}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </li>
    );
  };

  const panel = (title: string, aside: ReactNode, children: ReactNode, testId: string) => (
    <div className="rounded-xl border border-border/70 px-3 py-2.5" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <p className="text-[15px] font-bold leading-tight">{title}</p>
        <span className="text-[11px] text-muted-foreground">{aside}</span>
      </div>
      {children}
    </div>
  );
  const option = (label: string, key: "trends" | "comparison" | "updated") => (
    <div className="flex items-center justify-between gap-3 py-2 border-t border-border/50">
      <span className="text-[14px]">{label}</span>
      <Switch on={draft.options[key]} onChange={(v) => edit(setWellnessOptions(draft, { [key]: v }))} label={label} testId={`wellness-option-${key}`} />
    </div>
  );

  return (
    <BubbleModal open={open} onClose={onClose} testId="wellness-customize" width="lg" tall
      title="Customize Wellness" subtitle="Choose what to show, reorder sections, and set your defaults."
      icon={Settings} accent={PURPLE}
      footer={
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => edit(resetWellnessLayout(draft))}
            title="Back to the built-in sections, order and display options for this dashboard. Cards you built are kept."
            className="inline-flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-[13px] font-semibold text-muted-foreground hover:bg-muted"
            data-testid="wellness-customize-reset"><RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Reset</button>
          <span className="flex-1" />
          <button type="button" onClick={onClose} className="rounded-xl border border-border px-3.5 py-2 text-[13px] font-semibold hover:bg-muted" data-testid="wellness-customize-cancel">Cancel</button>
          <button type="button" onClick={save} disabled={!dirty || saving} className="rounded-xl px-3.5 py-2 text-[13px] font-bold text-white disabled:opacity-50"
            style={{ background: `hsl(${PURPLE})` }} data-testid="wellness-customize-save">{saving ? "Saving…" : "Save Changes"}</button>
        </div>
      }>
      {/* Dashboards: each is its own layout over the same cards. */}
      <div className="rounded-xl border border-border/70 px-3 py-2.5 space-y-2" data-testid="wellness-customize-boards">
        <div className="flex items-center gap-2">
          <LayoutDashboard className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <p className="text-[14px] font-bold leading-tight">My Wellness dashboards</p>
            <p className="text-[12px] text-muted-foreground leading-tight">Each has its own sections, order and sizes. You are editing the highlighted one.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {draft.dashboards.map((d) => (
            <button key={d.id} type="button" aria-pressed={d.id === board.id} onClick={() => { edit(setActiveWellnessBoard(draft, d.id)); setExpanded(null); }}
              data-testid={`wellness-customize-board-${d.id}`} className={chip(d.id === board.id)} style={chipStyle(d.id === board.id)}>{d.name}</button>
          ))}
          {draft.dashboards.length < MAX_DASHBOARDS && (
            <button type="button" onClick={() => setNewBoardOpen((o) => !o)} aria-expanded={newBoardOpen}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-3 py-1 text-[12px] font-semibold text-muted-foreground hover:bg-muted"
              data-testid="wellness-customize-board-new"><Plus className="h-3.5 w-3.5" aria-hidden="true" /> New</button>
          )}
        </div>
        {newBoardOpen ? (
          <div className="grid grid-cols-2 gap-1.5" data-testid="wellness-customize-templates">
            {WELLNESS_TEMPLATES.map((t) => (
              <button key={t.key} type="button" onClick={() => { edit(addWellnessDashboard(draft, t.name, t.key)); setNewBoardOpen(false); setExpanded(null); }}
                className="rounded-lg border border-border/70 px-2.5 py-2 text-left hover:bg-muted" data-testid={`wellness-customize-template-${t.key}`}>
                <span className="block text-[13px] font-semibold">{t.name}</span>
                <span className="block text-[11px] text-muted-foreground leading-tight">{t.hint}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-muted-foreground shrink-0" htmlFor="wellness-board-name">Name</label>
            <input id="wellness-board-name" key={board.id} defaultValue={board.name} maxLength={24}
              onChange={(e) => { if (e.target.value.trim()) edit(renameWellnessBoard(draft, board.id, e.target.value)); }}
              className={`${field} flex-1 min-w-0 font-semibold`} data-testid="wellness-customize-board-name" />
            {draft.dashboards.length > 1 && (
              <button type="button" onClick={() => arm(`board:${board.id}`, () => { edit(removeWellnessBoard(draft, board.id)); setExpanded(null); })}
                title="Deletes this dashboard's layout. The cards themselves are kept."
                className={`shrink-0 inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] font-semibold ${armed === `board:${board.id}` ? "border-red-500/50 bg-red-500/15 text-red-500" : "border-border text-muted-foreground hover:bg-muted"}`}
                data-testid="wellness-customize-board-delete">
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> {armed === `board:${board.id}` ? "Tap again to delete" : "Delete"}
              </button>
            )}
          </div>
        )}
      </div>

      {panel("Visible Sections", "drag to reorder", visible.length === 0
        ? <p className="text-[12px] text-muted-foreground" data-testid="wellness-customize-none-visible">Nothing is switched on. Add a section below.</p>
        : <ul className="space-y-1.5" data-testid="wellness-customize-visible">{visible.map((id) => row(id, true))}</ul>, "wellness-customize-visible-panel")}

      {hidden.length > 0 && panel("Available Sections", "tap to add",
        <ul className="space-y-1.5" data-testid="wellness-customize-available">{hidden.map((id) => row(id, false))}</ul>, "wellness-customize-available-panel")}

      {panel("Build Your Own", `${draft.widgets.length} of ${MAX_WELLNESS_WIDGETS}`, (
        <div className="space-y-2.5">
          {fromTrackers.length > 0 && (
            <div data-testid="wellness-customize-from-trackers">
              <p className="text-[12px] text-muted-foreground mb-1.5">From your trackers — each one already has data to show.</p>
              <div className="grid grid-cols-2 gap-1.5">
                {fromTrackers.map((sg) => (
                  <button key={sg.key} type="button" onClick={() => add({ ...sg.widget, by: "manual" })}
                    className="rounded-lg border border-border/70 px-2.5 py-1.5 text-left hover:bg-muted min-w-0" data-testid={`wellness-customize-suggest-${sg.key}`}>
                    <span className="flex items-center gap-1 text-[12px] font-semibold"><Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span className="truncate">{sg.widget.title}</span></span>
                    <span className="block text-[11px] text-muted-foreground leading-tight truncate">{sg.hint}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            <p className="text-[12px] text-muted-foreground mb-1.5">Widget ideas — one tap, then change anything about them.</p>
            <div className="flex flex-wrap gap-1.5" data-testid="wellness-customize-ideas">
              {WELLNESS_WIDGET_IDEAS.map((i) => {
                const have = draft.widgets.some((w) => w.title === i.widget.title);
                return (
                  <button key={i.key} type="button" disabled={have} title={i.hint} onClick={() => add(i.widget)}
                    className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[12px] font-semibold hover:bg-muted disabled:opacity-50"
                    data-testid={`wellness-customize-idea-${i.key}`}>
                    {!have && <Plus className="h-3.5 w-3.5" aria-hidden="true" />} {i.widget.title}{have ? " · added" : ""}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" aria-expanded={builder === "manual"} onClick={() => { setBuilder(builder === "manual" ? null : "manual"); setBuilding(null); setFormKey((k) => k + 1); }}
              className={chip(builder === "manual")} style={chipStyle(builder === "manual")} data-testid="wellness-customize-builder-manual">Build one yourself</button>
            <button type="button" aria-expanded={builder === "ai"} onClick={() => setBuilder(builder === "ai" ? null : "ai")}
              className={chip(builder === "ai")} style={chipStyle(builder === "ai")} data-testid="wellness-customize-builder-ai">
              <Sparkles className="inline h-3.5 w-3.5 mr-1" aria-hidden="true" />Describe it to AI
            </button>
          </div>

          {builder === "manual" && (
            <div className="rounded-lg border border-border/60 p-2.5 space-y-2.5" data-testid="wellness-builder-manual">
              <WellnessWidgetForm key={formKey} initial={blankWidget(data)} id="new-widget" data={data} onValid={setBuilding} />
              <p className="micro-label text-muted-foreground">Preview, from your records</p>
              <div className="rounded-lg border border-border/60 p-2" data-testid="wellness-builder-preview">
                {building
                  ? <WellnessWidgetCardBody widget={building} data={data} lists={lists} range={range} todayISO={todayISO} />
                  : <p className="text-xs text-muted-foreground">Give the widget a name to see it.</p>}
              </div>
              <button type="button" disabled={!building}
                onClick={() => { if (building && add({ ...building, by: "manual" })) { setBuilder(null); setBuilding(null); } }}
                className="rounded-xl px-3.5 py-2 text-[13px] font-bold text-white disabled:opacity-50" style={{ background: `hsl(${PURPLE})` }}
                data-testid="wellness-builder-add">Add this widget</button>
            </div>
          )}

          {builder === "ai" && (
            <div className="rounded-lg border border-border/60 p-2.5 space-y-2" data-testid="wellness-builder-ai">
              <label className="block text-[12px] text-muted-foreground" htmlFor="wellness-ai-prompt">
                Say what you want to see — one card, or a whole dashboard. Portol builds it from your own trackers and the data it can draw; it never writes its own queries.
              </label>
              <textarea id="wellness-ai-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={400} rows={3}
                placeholder="My running distance, weekly sleep average, weight trend, and whether I exercise more after sleeping eight hours"
                className="w-full rounded-lg border border-border bg-background/60 px-2 py-1.5 text-[13px]" data-testid="wellness-ai-prompt" />
              <button type="button" disabled={prompt.trim().length < 3 || suggest.isPending} onClick={() => { setProposal(null); suggest.mutate(prompt.trim()); }}
                className="rounded-xl px-3.5 py-2 text-[13px] font-bold text-white disabled:opacity-50" style={{ background: `hsl(${PURPLE})` }}
                data-testid="wellness-ai-build">{suggest.isPending ? "Building…" : "Build with AI"}</button>
              {suggest.isError && !suggest.isPending && <p className="text-[12px] text-destructive" data-testid="wellness-ai-error">Couldn't build that from your data. Try again, or build it yourself above.</p>}
              {proposal && (
                <div className="space-y-2" data-testid="wellness-ai-proposals">
                  <p className="text-[12px] text-muted-foreground" data-testid="wellness-ai-summary">
                    {proposal.by === "ai" ? "Proposed by AI" : "Read by fixed rules"} · {proposal.widgets.length} card{proposal.widgets.length === 1 ? "" : "s"}, drawn from your records. Nothing is added until you say so.
                    {proposal.dropped > 0 ? ` ${proposal.dropped} could not be built: you have no tracker for ${proposal.dropped === 1 ? "it" : "them"}.` : ""}
                  </p>
                  {proposal.widgets.map((w, i) => (
                    <div key={w.id} className="rounded-lg border border-border/60 p-2 space-y-2" data-testid={`wellness-ai-proposal-${i}`}>
                      <p className="text-[13px] font-semibold">{w.title}</p>
                      <WellnessWidgetCardBody widget={w} data={data} lists={lists} range={range} todayISO={todayISO} />
                      <div className="flex gap-1.5">
                        <button type="button" onClick={() => { if (add(w)) dropProposal(w.id); }}
                          className="rounded-full px-3 py-1 text-[12px] font-bold text-white" style={{ background: `hsl(${PURPLE})` }} data-testid={`wellness-ai-use-${i}`}>Add this widget</button>
                        <button type="button" onClick={() => dropProposal(w.id)} className="rounded-full border border-border px-3 py-1 text-[12px] font-semibold hover:bg-muted"
                          data-testid={`wellness-ai-discard-${i}`}>Discard</button>
                      </div>
                    </div>
                  ))}
                  {proposal.widgets.length > 1 && (
                    <div className="flex flex-wrap gap-1.5" data-testid="wellness-ai-bulk">
                      <button type="button"
                        onClick={() => {
                          let next = draft; let n = 0;
                          for (const w of proposal.widgets) { const r = addWellnessWidget(next, w); if (r.widget) { next = r.boards; n++; } }
                          if (n) { edit(next); setProposal(null); setPrompt(""); toast({ title: `${n} cards added to ${board.name}`, description: "Press Save Changes to keep them." }); }
                        }}
                        className="rounded-full px-3 py-1.5 text-[12px] font-bold text-white" style={{ background: `hsl(${PURPLE})` }} data-testid="wellness-ai-add-all">
                        Add all to {board.name}
                      </button>
                      {draft.dashboards.length < MAX_DASHBOARDS && (
                        <button type="button"
                          onClick={() => {
                            const next = addWellnessDashboardWithWidgets(draft, proposal.name || "My Dashboard", proposal.widgets);
                            if (next !== draft) { edit(next); setExpanded(null); setProposal(null); setPrompt(""); toast({ title: "New dashboard made from these cards", description: "Press Save Changes to keep it." }); }
                          }}
                          className="rounded-full border border-border px-3 py-1.5 text-[12px] font-semibold hover:bg-muted" data-testid="wellness-ai-new-dashboard">
                          Make a new dashboard{proposal.name ? `: ${proposal.name}` : ""}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      ), "wellness-customize-build-panel")}

      {panel("Display Options", "", (
        <div>
          <div className="flex items-center justify-between gap-3 py-2">
            <label className="text-[14px]" htmlFor="wellness-option-range">Default Time Range</label>
            <select id="wellness-option-range" value={draft.options.range} onChange={(e) => edit(setWellnessOptions(draft, { range: e.target.value as WellnessRange }))}
              className={`${field} w-[130px]`} data-testid="wellness-option-range">
              {WELLNESS_RANGES.map((r) => <option key={r} value={r}>{r === "all" ? "All time" : RANGE_WORDS[r][0].toUpperCase() + RANGE_WORDS[r].slice(1)}</option>)}
            </select>
          </div>
          <div className="flex items-center justify-between gap-3 py-2 border-t border-border/50">
            <label className="text-[14px]" htmlFor="wellness-option-density">Card Size</label>
            <select id="wellness-option-density" value={draft.options.density} onChange={(e) => edit(setWellnessOptions(draft, { density: e.target.value as "compact" | "comfortable" }))}
              className={`${field} w-[130px]`} data-testid="wellness-option-density">
              <option value="compact">Compact</option>
              <option value="comfortable">Comfortable</option>
            </select>
          </div>
          {option("Show Trend Graphs", "trends")}
          {option("Show Comparison Change (%)", "comparison")}
          {option("Show Last Updated Date", "updated")}
        </div>
      ), "wellness-customize-options-panel")}
    </BubbleModal>
  );
}

export default WellnessCustomizeDialog;
