// Every part of a custom AI Mode, editable (shared/ai-modes.ts).
//
// A controlled DRAFT: it writes nothing (Rule 3); the page that holds it saves
// it with one route call, and the server passes it through `sanitizeAiMode`.
// Removing a tab, a card or a suggested conversation takes two taps (Rule 8).
import { useState } from "react";
import { ArrowDown, ArrowUp, Brain, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useConfirmArm } from "@/hooks/useConfirmArm";
import { describeWidget, inferWidgetFromText, newWidgetId } from "@shared/exec-widgets";
import {
  MAX_MODE_PROMPTS, MAX_MODE_TABS, MAX_TAB_WIDGETS, MODE_COLOR_NAMES, MODE_ICONS, MODE_SOURCES, MODE_SOURCE_LABELS, MODE_TAB_KINDS, MODE_TAB_KIND_LABELS,
  type AiMode, type ModeSource, type ModeTab, type ModeTabKind,
} from "@shared/ai-modes";
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
          {value.tabs.map((t, i) => (
            <li key={t.id} className="rounded-xl border border-border p-2.5 space-y-2" data-testid={`mode-tab-edit-${t.id}`}>
              <div className="flex items-center gap-1.5">
                <input value={t.title} maxLength={24} onChange={(e) => patchTab(t.id, { title: e.target.value })} aria-label="Tab title" className={`${field} flex-1`} />
                <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} className="h-8 w-8 rounded-lg border border-border flex items-center justify-center disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" /></button>
                <button type="button" aria-label="Move down" disabled={i === value.tabs.length - 1} onClick={() => move(i, 1)} className="h-8 w-8 rounded-lg border border-border flex items-center justify-center disabled:opacity-30"><ArrowDown className="h-3.5 w-3.5" /></button>
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
            </li>
          ))}
        </ol>
        {value.tabs.length < MAX_MODE_TABS && (
          <button type="button" onClick={addTab} className="mt-2 h-8 px-3 rounded-full border border-border text-xs font-semibold flex items-center gap-1" data-testid="mode-add-tab">
            <Plus className="h-3.5 w-3.5" /> Add a tab
          </button>
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
