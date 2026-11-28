// Every part of a custom AI Mode, editable (shared/ai-modes.ts).
//
// A controlled DRAFT: it writes nothing (Rule 3); the page that holds it saves
// it with one route call, and the server passes it through `sanitizeAiMode`.
// Removing a tab, a card or a suggested conversation takes two taps (Rule 8).
import { useState } from "react";
import { ArrowDown, ArrowUp, Bell, Brain, GripVertical, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useDragReorder } from "./useDragReorder";
import { describeWellnessWidget, sanitizeWellnessWidget, type SeriesRef } from "@shared/wellness-widgets";
import { useConfirmArm } from "@/hooks/useConfirmArm";
import { describeWidget, inferWidgetFromText, newWidgetId } from "@shared/exec-widgets";
import {
  MAX_LOG_FIELDS, MAX_MODE_CHECKINS, MAX_MODE_PROMPTS, MAX_MODE_REMINDERS, MAX_MODE_TABS, MAX_TAB_GRAPHS, MAX_TAB_WIDGETS, REMINDER_FREQS, MODE_COLOR_NAMES, MODE_ICONS, MODE_SOURCES, MODE_SOURCE_LABELS, MODE_TAB_KINDS, MODE_TAB_KIND_LABELS,
  type AiMode, type ModeCheckin, type ModeReminder, type ModeSource, type ModeTab, type ModeTabKind,
} from "@shared/ai-modes";

const GRAPH_SOURCES: Array<{ key: string; label: string; ref: SeriesRef; calc: "average" | "total" | "count" | "latest" }> = [
  { key: "sleep", label: "Sleep", ref: { kind: "metric", key: "sleep_hours" }, calc: "average" },
  { key: "steps", label: "Steps", ref: { kind: "metric", key: "steps" }, calc: "total" },
  { key: "weight", label: "Weight", ref: { kind: "metric", key: "weight" }, calc: "latest" },
  { key: "hr", label: "Heart rate", ref: { kind: "metric", key: "heart_rate" }, calc: "average" },
  { key: "workouts", label: "Workouts", ref: { kind: "workouts" }, calc: "count" },
  { key: "mood", label: "Mood (journal)", ref: { kind: "mood" }, calc: "average" },
  { key: "tracker", label: "One of my trackers…", ref: { kind: "tracker", key: "" }, calc: "average" },
];
import { MODE_ICON_COMPONENTS, modeHsl } from "./ModeIcon";

const field = "ws-title w-full min-w-0 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary/60";
const label = "block text-[11px] font-semibold text-muted-foreground mb-1";

export function Switch({ on, onChange, label: aria, testId, disabled }: { on: boolean; onChange: (next: boolean) => void; label: string; testId?: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={aria} disabled={disabled} onClick={() => onChange(!on)}
      className={`mt-0.5 h-5 w-9 rounded-full shrink-0 relative transition-colors ${on ? "bg-primary" : "bg-muted-foreground/30"}`} data-testid={testId}>
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}

let tabSeq = 0;
const freshTabId = (tabs: ModeTab[], title: string) => {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || `tab-${++tabSeq}`;
  let id = base;
  for (let n = 2; tabs.some((t) => t.id === id); n++) id = `${base}-${n}`;
  return id;
};

/** What the mode may read: the switches (the server enforces them on every call). */
export function AccessSwitches({ mode, onChange, suggestJournal }: { mode: AiMode; onChange: (access: ModeSource[]) => void; suggestJournal?: boolean }) {
  const toggle = (s: ModeSource, on: boolean) => onChange(on ? [...mode.access, s] : mode.access.filter((x) => x !== s));
  return (
    <ul className="space-y-1.5" data-testid="mode-access">
      {MODE_SOURCES.map((s) => {
        const on = mode.access.includes(s);
        return (
          <li key={s} className="flex items-start gap-2.5">
            <Switch on={on} onChange={(v) => toggle(s, v)} label={MODE_SOURCE_LABELS[s].label} testId={`mode-access-${s}`} />
            <span className="min-w-0">
              <span className="text-sm block leading-tight">
                {MODE_SOURCE_LABELS[s].label}
                {s === "journal" && suggestJournal && !on && <span className="ml-1.5 text-[11px] font-semibold rounded-full px-1.5 py-0.5 bg-primary/15 text-primary" data-testid="mode-journal-suggested">Suggested</span>}
              </span>
              <span className="text-[11px] text-muted-foreground block">{MODE_SOURCE_LABELS[s].detail}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function ModeEditor({ value, onChange, suggestJournal }: { value: AiMode; onChange: (next: AiMode) => void; suggestJournal?: boolean }) {
  const { confirm, isArmed } = useConfirmArm();
  const [cardText, setCardText] = useState<Record<string, string>>({});
  const [newPrompt, setNewPrompt] = useState("");
  const [graphPick, setGraphPick] = useState<Record<string, { source: string; tracker: string; field: string; display: "line" | "bar" }>>({});
  const [newField, setNewField] = useState<Record<string, string>>({});
  const [newReminder, setNewReminder] = useState("");
  // Drag the non-chat tabs; Chat stays last.
  const chatTab = value.tabs.find((t) => t.kind === "chat");
  const movable = value.tabs.filter((t) => t.kind !== "chat");
  const drag = useDragReorder(movable.map((t) => t.id), (ids) => {
    const byId = new Map(value.tabs.map((t) => [t.id, t]));
    onChange({ ...value, tabs: [...ids.map((id) => byId.get(id)!).filter(Boolean), ...(chatTab ? [chatTab] : [])] });
  });
  const shownTabs = [...drag.order.map((id) => movable.find((t) => t.id === id)!).filter(Boolean), ...(chatTab ? [chatTab] : [])];
  const addGraph = (t: ModeTab) => {
    const pick = graphPick[t.id] ?? { source: "sleep", tracker: "", field: "", display: "line" as const };
    const src = GRAPH_SOURCES.find((g) => g.key === pick.source) ?? GRAPH_SOURCES[0];
    const ref: SeriesRef = src.key === "tracker" ? { kind: "tracker", key: pick.tracker.trim(), ...(pick.field.trim() ? { field: pick.field.trim() } : {}) } : src.ref;
    if (ref.kind === "tracker" && !ref.key) return;
    const title = src.key === "tracker" ? `${pick.tracker.trim()}${pick.field.trim() ? ` · ${pick.field.trim()}` : ""}` : src.label;
    const graphs = t.graphs ?? [];
    const g = sanitizeWellnessWidget({ title, kind: "metric", source: ref, calc: src.key === "tracker" && !pick.field.trim() ? "count" : src.calc, display: pick.display, by: "manual" }, `g${Date.now().toString(36)}`);
    if (!g || graphs.length >= MAX_TAB_GRAPHS) return;
    patchTab(t.id, { graphs: [...graphs, g] });
  };
  const setReminders = (reminders: ModeReminder[]) => set({ reminders });
  const checkinFor = (tabId: string) => value.checkins.find((c) => c.tabId === tabId);
  const setCheckin = (tabId: string, freq: "off" | "daily" | "weekly") => {
    const rest = value.checkins.filter((c) => c.tabId !== tabId);
    if (freq === "off") return set({ checkins: rest });
    if (rest.length >= MAX_MODE_CHECKINS) return;
    const c: ModeCheckin = { id: `checkin-${tabId}`, tabId, freq, enabled: true };
    set({ checkins: [...rest, c] });
  };
  const set = (patch: Partial<AiMode>) => onChange({ ...value, ...patch });
  const setTabs = (tabs: ModeTab[]) => set({ tabs });
  const patchTab = (id: string, patch: Partial<ModeTab>) => setTabs(value.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const move = (i: number, d: -1 | 1) => {
    const tabs = value.tabs.slice();
    const j = i + d;
    if (j < 0 || j >= tabs.length) return;
    [tabs[i], tabs[j]] = [tabs[j], tabs[i]];
    setTabs(tabs);
  };
  const addTab = () => {
    if (value.tabs.length >= MAX_MODE_TABS) return;
    const title = "New tab";
    const tab: ModeTab = { id: freshTabId(value.tabs, title), title, kind: "insights", focus: "" };
    const chatAt = value.tabs.findIndex((t) => t.kind === "chat");
    const at = chatAt < 0 ? value.tabs.length : chatAt;
    setTabs([...value.tabs.slice(0, at), tab, ...value.tabs.slice(at)]);
  };
  const setKind = (t: ModeTab, kind: ModeTabKind) => {
    const next: ModeTab = { id: t.id, title: t.title, kind };
    if (kind === "insights") next.focus = t.focus ?? "";
    if (kind === "widgets" || kind === "overview") next.widgets = t.widgets ?? [];
    if (kind === "charts") { next.graphs = t.graphs ?? []; next.range = t.range ?? "30d"; }
    if (kind === "log") next.tracker = t.tracker ?? { name: t.title, fields: [{ key: "value", label: "Value", type: "number" }] };
    setTabs(value.tabs.map((x) => (x.id === t.id ? next : x)));
  };
  const addCard = (t: ModeTab) => {
    const said = (cardText[t.id] || "").trim();
    if (said.length < 3) return;
    const widgets = t.widgets ?? [];
    if (widgets.length >= MAX_TAB_WIDGETS) return;
    const card = inferWidgetFromText(said, newWidgetId(widgets, said));
    patchTab(t.id, { widgets: [...widgets, card] });
    setCardText((m) => ({ ...m, [t.id]: "" }));
  };

  return (
    <div className="space-y-4" data-testid="mode-editor">
      <section className="space-y-2">
        <div>
          <label className={label} htmlFor="mode-name">Name</label>
          <input id="mode-name" value={value.name} maxLength={40} onChange={(e) => set({ name: e.target.value })} className={field} data-testid="mode-name" />
        </div>
        <div>
          <label className={label} htmlFor="mode-tagline">One line about it</label>
          <input id="mode-tagline" value={value.tagline} maxLength={120} onChange={(e) => set({ tagline: e.target.value })} className={field} data-testid="mode-tagline" />
        </div>
        <div>
          <span className={label}>Icon</span>
          <div className="flex flex-wrap gap-1.5" data-swipe-ignore>
            {MODE_ICONS.map((ic) => {
              const Icon = MODE_ICON_COMPONENTS[ic];
              const on = value.icon === ic;
              return (
                <button key={ic} type="button" aria-label={`Icon ${ic}`} aria-pressed={on} onClick={() => set({ icon: ic })}
                  className={`h-8 w-8 rounded-lg flex items-center justify-center border ${on ? "border-primary bg-primary/15 text-primary" : "border-border text-muted-foreground"}`}>
                  <Icon className="h-4 w-4" />
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <span className={label}>Color</span>
          <div className="flex flex-wrap gap-2">
            {MODE_COLOR_NAMES.map((c) => (
              <button key={c} type="button" aria-label={`Color ${c}`} aria-pressed={value.color === c} onClick={() => set({ color: c })}
                className={`h-7 w-7 rounded-full ${value.color === c ? "ring-2 ring-offset-2 ring-offset-background ring-foreground" : ""}`}
                style={{ background: `hsl(${modeHsl(c)})` }} />
            ))}
          </div>
        </div>
      </section>

      <section className="space-y-2">
        <div>
          <label className={label} htmlFor="mode-personality">Personality — how it talks</label>
          <input id="mode-personality" value={value.personality} maxLength={200} onChange={(e) => set({ personality: e.target.value })} className={field} data-testid="mode-personality" />
        </div>
        <div>
          <label className={label} htmlFor="mode-instructions">Instructions — what it does for you</label>
          <textarea id="mode-instructions" value={value.instructions} maxLength={2000} rows={5} onChange={(e) => set({ instructions: e.target.value })}
            className={`${field} resize-y`} data-testid="mode-instructions" />
          <p className="text-[11px] text-muted-foreground mt-1">Whatever you write here, it still never invents a fact about you, changes nothing in the app, and gives general information — not medical, financial or legal advice.</p>
        </div>
      </section>

      <section>
        <p className="text-sm font-semibold flex items-center gap-1.5 mb-1"><ShieldCheck className="h-4 w-4 text-primary" /> What it may read</p>
        <p className="text-[11px] text-muted-foreground mb-2">A switch that is off means that information is never sent to this mode's AI. Passwords, ID and card numbers are never sent. Your journal stays private unless you turn it on.</p>
        <AccessSwitches mode={value} onChange={(access) => set({ access })} suggestJournal={suggestJournal} />
        <div className="flex items-start gap-2.5 mt-3">
          <Switch on={value.remember} onChange={(remember) => set({ remember })} label="Remember our conversations" testId="mode-remember" />
          <span className="min-w-0">
            <span className="text-sm block leading-tight flex items-center gap-1"><Brain className="h-3.5 w-3.5" /> Remember our conversations</span>
            <span className="text-[11px] text-muted-foreground block">Keeps the chat and what you tell it, on your account, for this mode only. You can read and remove everything it keeps.</span>
          </span>
        </div>
      </section>

      <section>
        <p className="text-sm font-semibold mb-1">Tabs · {value.tabs.length}</p>
        <p className="text-[11px] text-muted-foreground mb-2">Five by default, up to {MAX_MODE_TABS}. Chat is always there.</p>
        <ol className="space-y-2" data-testid="mode-tabs-editor">
          {shownTabs.map((t) => { const i = value.tabs.findIndex((x) => x.id === t.id); return (
            <li key={t.id} ref={t.kind === "chat" ? undefined : drag.itemRef(t.id)}
              className={`rounded-xl border p-2.5 space-y-2 ${drag.dragging === t.id ? "border-primary bg-primary/5" : "border-border"}`} data-testid={`mode-tab-edit-${t.id}`}>
              <div className="flex items-center gap-1.5">
                {t.kind !== "chat" && (
                  <span {...drag.handleProps(t.id)} className="h-8 w-6 flex items-center justify-center text-muted-foreground shrink-0" data-testid={`mode-tab-drag-${t.id}`}>
                    <GripVertical className="h-4 w-4" />
                  </span>
                )}
                <input value={t.title} maxLength={24} onChange={(e) => patchTab(t.id, { title: e.target.value })} aria-label="Tab title" className={`${field} flex-1`} />
                <button type="button" aria-label="Move up" disabled={i === 0 || t.kind === "chat"} onClick={() => move(i, -1)} className="h-8 w-8 rounded-lg border border-border flex items-center justify-center disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" /></button>
                <button type="button" aria-label="Move down" disabled={t.kind === "chat" || i >= value.tabs.length - 2} onClick={() => move(i, 1)} className="h-8 w-8 rounded-lg border border-border flex items-center justify-center disabled:opacity-30"><ArrowDown className="h-3.5 w-3.5" /></button>
                {t.kind !== "chat" && (
                  <button type="button" onClick={() => confirm(`tab:${t.id}`, () => setTabs(value.tabs.filter((x) => x.id !== t.id)))}
                    aria-label={isArmed(`tab:${t.id}`) ? "Tap again to remove this tab" : "Remove this tab"}
                    className={`h-8 px-2 rounded-lg flex items-center justify-center text-[11px] ${isArmed(`tab:${t.id}`) ? "bg-destructive text-destructive-foreground" : "border border-border text-muted-foreground"}`}
                    data-testid={`mode-tab-remove-${t.id}`}>
                    {isArmed(`tab:${t.id}`) ? "Tap again" : <Trash2 className="h-3.5 w-3.5" />}
                  </button>
                )}
              </div>
              {t.kind === "chat" ? (
                <p className="text-[11px] text-muted-foreground">{MODE_TAB_KIND_LABELS.chat}</p>
              ) : (
                <select value={t.kind} onChange={(e) => setKind(t, e.target.value as ModeTabKind)} aria-label="What this tab does" className={field}>
                  {MODE_TAB_KINDS.filter((k) => k !== "chat").map((k) => <option key={k} value={k}>{MODE_TAB_KIND_LABELS[k]}</option>)}
                </select>
              )}
              {t.kind === "insights" && (
                <textarea value={t.focus ?? ""} maxLength={300} rows={2} onChange={(e) => patchTab(t.id, { focus: e.target.value })}
                  placeholder="What should it look at? e.g. Compare my sleep against my workout performance"
                  aria-label="What this tab analyzes" className={`${field} resize-y`} />
              )}
              {(t.kind === "widgets" || t.kind === "overview") && (
                <div className="space-y-1.5">
                  {(t.widgets ?? []).map((w) => (
                    <div key={w.id} className="flex items-start gap-2 text-[12px]">
                      <span className="flex-1 min-w-0"><span className="font-semibold">{w.title}</span> — <span className="text-muted-foreground">{describeWidget(w)}</span></span>
                      <button type="button" onClick={() => confirm(`card:${t.id}:${w.id}`, () => patchTab(t.id, { widgets: (t.widgets ?? []).filter((x) => x.id !== w.id) }))}
                        className={`h-6 px-2 rounded-full text-[11px] shrink-0 ${isArmed(`card:${t.id}:${w.id}`) ? "bg-destructive text-destructive-foreground" : "border border-border text-muted-foreground"}`}>
                        {isArmed(`card:${t.id}:${w.id}`) ? "Tap again" : "Remove"}
                      </button>
                    </div>
                  ))}
                  {(t.widgets ?? []).length < MAX_TAB_WIDGETS && (
                    <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); addCard(t); }}>
                      <input value={cardText[t.id] ?? ""} onChange={(e) => setCardText((m) => ({ ...m, [t.id]: e.target.value }))} maxLength={120}
                        placeholder="Add a card: e.g. my sleep tracker, spending on groceries" aria-label="Describe a card to add" className={`${field} flex-1`} />
                      <button type="submit" className="h-8 px-2.5 rounded-lg border border-border text-xs font-semibold shrink-0">Add</button>
                    </form>
                  )}
                </div>
              )}
              {t.kind === "charts" && (
                <div className="space-y-1.5">
                  {(t.graphs ?? []).map((g) => (
                    <div key={g.id} className="flex items-start gap-2 text-[12px]">
                      <span className="flex-1 min-w-0"><span className="font-semibold">{g.title}</span> — <span className="text-muted-foreground">{describeWellnessWidget(g)}</span></span>
                      <button type="button" onClick={() => confirm(`graph:${t.id}:${g.id}`, () => patchTab(t.id, { graphs: (t.graphs ?? []).filter((x) => x.id !== g.id) }))}
                        className={`h-6 px-2 rounded-full text-[11px] shrink-0 ${isArmed(`graph:${t.id}:${g.id}`) ? "bg-destructive text-destructive-foreground" : "border border-border text-muted-foreground"}`}>
                        {isArmed(`graph:${t.id}:${g.id}`) ? "Tap again" : "Remove"}
                      </button>
                    </div>
                  ))}
                  {(t.graphs ?? []).length < MAX_TAB_GRAPHS && (() => {
                    const pick = graphPick[t.id] ?? { source: "sleep", tracker: "", field: "", display: "line" as const };
                    const setPick = (p: Partial<typeof pick>) => setGraphPick((m) => ({ ...m, [t.id]: { ...pick, ...p } }));
                    return (
                      <div className="flex flex-wrap gap-1.5" data-testid={`mode-graph-add-${t.id}`}>
                        <select value={pick.source} onChange={(e) => setPick({ source: e.target.value })} aria-label="Graph of" className={`${field} flex-1 min-w-[130px]`}>
                          {GRAPH_SOURCES.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
                        </select>
                        {pick.source === "tracker" && (
                          <>
                            <input value={pick.tracker} onChange={(e) => setPick({ tracker: e.target.value })} placeholder="Tracker name" aria-label="Tracker name" className={`${field} flex-1 min-w-[110px]`} />
                            <input value={pick.field} onChange={(e) => setPick({ field: e.target.value })} placeholder="Field (blank = count)" aria-label="Field" className={`${field} flex-1 min-w-[110px]`} />
                          </>
                        )}
                        <select value={pick.display} onChange={(e) => setPick({ display: e.target.value as "line" | "bar" })} aria-label="Drawn as" className={`${field} w-24`}>
                          <option value="line">Line</option><option value="bar">Bars</option>
                        </select>
                        <button type="button" onClick={() => addGraph(t)} className="h-8 px-2.5 rounded-lg border border-border text-xs font-semibold" data-testid={`mode-graph-add-button-${t.id}`}>Add graph</button>
                      </div>
                    );
                  })()}
                </div>
              )}
              {t.kind === "log" && t.tracker && (
                <div className="space-y-1.5">
                  <div className="flex gap-1.5">
                    <input value={t.tracker.name} maxLength={40} onChange={(e) => patchTab(t.id, { tracker: { ...t.tracker!, name: e.target.value } })} aria-label="Tracker it saves to" placeholder="Tracker name" className={`${field} flex-1`} />
                    <input value={t.tracker.unit ?? ""} maxLength={12} onChange={(e) => patchTab(t.id, { tracker: { ...t.tracker!, unit: e.target.value || undefined } })} aria-label="Unit" placeholder="Unit" className={`${field} w-20`} />
                  </div>
                  {t.tracker.fields.map((f) => (
                    <div key={f.key} className="flex items-center gap-1.5 text-[12px]">
                      <span className="flex-1 min-w-0">{f.label} <span className="text-muted-foreground">({f.type === "number" ? "number" : "text"}{f.unit ? `, ${f.unit}` : ""})</span></span>
                      {t.tracker!.fields.length > 1 && (
                        <button type="button" onClick={() => patchTab(t.id, { tracker: { ...t.tracker!, fields: t.tracker!.fields.filter((x) => x.key !== f.key) } })}
                          className="h-6 px-2 rounded-full text-[11px] border border-border text-muted-foreground">Remove</button>
                      )}
                    </div>
                  ))}
                  {t.tracker.fields.length < MAX_LOG_FIELDS && (
                    <form className="flex gap-1.5" onSubmit={(e) => {
                      e.preventDefault();
                      const raw = (newField[t.id] || "").trim();
                      if (raw.length < 2) return;
                      const isText = /\b(note|notes|text|subject|what|where|who|how)\b/i.test(raw);
                      const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);
                      if (!key || t.tracker!.fields.some((x) => x.key === key)) return;
                      patchTab(t.id, { tracker: { ...t.tracker!, fields: [...t.tracker!.fields, { key, label: raw.slice(0, 30), type: isText ? "text" : "number" }] } });
                      setNewField((m) => ({ ...m, [t.id]: "" }));
                    }}>
                      <input value={newField[t.id] ?? ""} onChange={(e) => setNewField((m) => ({ ...m, [t.id]: e.target.value }))} maxLength={30}
                        placeholder="Add a field: e.g. Minutes, Notes" aria-label="Add a field" className={`${field} flex-1`} />
                      <button type="submit" className="h-8 px-2.5 rounded-lg border border-border text-xs font-semibold shrink-0">Add</button>
                    </form>
                  )}
                </div>
              )}
              {t.kind === "insights" && (
                <label className="flex items-center gap-2 text-[12px]">
                  <span className="text-muted-foreground">Run on its own</span>
                  <select value={checkinFor(t.id)?.freq ?? "off"} onChange={(e) => setCheckin(t.id, e.target.value as "off" | "daily" | "weekly")}
                    disabled={!checkinFor(t.id) && value.checkins.length >= MAX_MODE_CHECKINS} className={`${field} w-28`} data-testid={`mode-checkin-${t.id}`}>
                    <option value="off">Off</option><option value="daily">Daily</option><option value="weekly">Weekly</option>
                  </select>
                </label>
              )}
            </li>
          ); })}
        </ol>
        {value.tabs.length < MAX_MODE_TABS && (
          <button type="button" onClick={addTab} className="mt-2 h-8 px-3 rounded-full border border-border text-xs font-semibold flex items-center gap-1" data-testid="mode-add-tab">
            <Plus className="h-3.5 w-3.5" /> Add a tab
          </button>
        )}
      </section>

      <section data-testid="mode-reminders-editor">
        <p className="text-sm font-semibold mb-1 flex items-center gap-1.5"><Bell className="h-4 w-4" /> Reminders</p>
        <p className="text-[11px] text-muted-foreground mb-2">Offered on the mode's Overview. One you turn on there becomes a repeating task with the app's notifications.</p>
        <ul className="space-y-1.5">
          {value.reminders.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-1.5">
              <input value={r.title} maxLength={80} onChange={(e) => setReminders(value.reminders.map((x) => (x.id === r.id ? { ...x, title: e.target.value } : x)))} aria-label="Reminder" className={`${field} flex-1 min-w-[140px]`} />
              <select value={r.freq} onChange={(e) => setReminders(value.reminders.map((x) => (x.id === r.id ? { ...x, freq: e.target.value as ModeReminder["freq"] } : x)))} aria-label="How often" className={`${field} w-28`}>
                {REMINDER_FREQS.map((f) => <option key={f} value={f}>{f === "daily" ? "Daily" : f === "weekly" ? "Weekly" : "Monthly"}</option>)}
              </select>
              <input type="time" value={r.time ?? ""} onChange={(e) => setReminders(value.reminders.map((x) => (x.id === r.id ? { ...x, time: e.target.value || undefined } : x)))} aria-label="At" className={`${field} w-28`} />
              <button type="button" onClick={() => confirm(`rem:${r.id}`, () => setReminders(value.reminders.filter((x) => x.id !== r.id)))}
                className={`h-8 px-2 rounded-lg text-[11px] ${isArmed(`rem:${r.id}`) ? "bg-destructive text-destructive-foreground" : "border border-border text-muted-foreground"}`}>
                {isArmed(`rem:${r.id}`) ? "Tap again" : "Remove"}
              </button>
            </li>
          ))}
        </ul>
        {value.reminders.length < MAX_MODE_REMINDERS && (
          <form className="flex gap-1.5 mt-1.5" onSubmit={(e) => {
            e.preventDefault();
            const title = newReminder.trim();
            if (title.length < 3) return;
            let id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "reminder";
            for (let n = 2; value.reminders.some((x) => x.id === id); n++) id = `${id.replace(/-\d+$/, "")}-${n}`;
            setReminders([...value.reminders, { id, title, freq: "weekly" }]);
            setNewReminder("");
          }}>
            <input value={newReminder} onChange={(e) => setNewReminder(e.target.value)} maxLength={80} placeholder="Add a reminder: e.g. Weigh in" aria-label="Add a reminder" className={`${field} flex-1`} data-testid="mode-reminder-new" />
            <button type="submit" className="h-8 px-2.5 rounded-lg border border-border text-xs font-semibold shrink-0">Add</button>
          </form>
        )}
      </section>

      <section>
        <p className="text-sm font-semibold mb-1">Suggested conversations</p>
        <ul className="space-y-1">
          {value.prompts.map((p, i) => (
            <li key={`${p}-${i}`} className="flex items-center gap-2 text-sm">
              <span className="flex-1 min-w-0">{p}</span>
              <button type="button" onClick={() => confirm(`prompt:${i}`, () => set({ prompts: value.prompts.filter((_, j) => j !== i) }))}
                className={`h-6 px-2 rounded-full text-[11px] shrink-0 ${isArmed(`prompt:${i}`) ? "bg-destructive text-destructive-foreground" : "border border-border text-muted-foreground"}`}>
                {isArmed(`prompt:${i}`) ? "Tap again" : "Remove"}
              </button>
            </li>
          ))}
        </ul>
        {value.prompts.length < MAX_MODE_PROMPTS && (
          <form className="flex gap-1.5 mt-1.5" onSubmit={(e) => { e.preventDefault(); const v = newPrompt.trim(); if (v.length >= 4) { set({ prompts: [...value.prompts, v] }); setNewPrompt(""); } }}>
            <input value={newPrompt} onChange={(e) => setNewPrompt(e.target.value)} maxLength={140} placeholder="Add a conversation starter" aria-label="Add a conversation starter" className={`${field} flex-1`} />
            <button type="submit" className="h-8 px-2.5 rounded-lg border border-border text-xs font-semibold shrink-0">Add</button>
          </form>
        )}
      </section>
    </div>
  );
}
