// One custom AI Mode, as its own full-screen app (owner request 2026-11-27:
// "every mode becomes a mini-app"). Its tabs are the mode's own
// (shared/ai-modes.ts), drawn with approved parts only:
//   overview — what it is for, what it reads, suggested conversations, cards;
//   widgets  — cards over the person's records (ExecWidgetBody: the same
//              lists every screen reads, nothing copied — Rule 1);
//   insights — an analysis asked for on a TAP, never on opening (WA3);
//   chat     — the conversation, remembered per mode when its switch is on.
// Plus Settings, where every part can be changed — by hand, or by saying what
// to change (a proposal to review and apply, W5).
//
// A tab is a view: once opened it stays mounted (WA1), so a conversation is
// not lost by looking at another tab. Opening any tab writes nothing (Rule 3).
import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, Loader2, MessageCircle, Pin, PinOff, Settings, ShieldCheck, Sparkles, Wand2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { hashNavigate } from "@/lib/hashNavigate";
import { useToast } from "@/hooks/use-toast";
import { useConfirmArm } from "@/hooks/useConfirmArm";
import { getUserToday } from "@shared/timezone";
import { useAiModes, MODES_ROUTE, modeRoute } from "@/lib/ai-modes-client";
import { aiErrorText, useUnsavedWarning } from "@/components/workspace/WorkspaceShell";
import { AiConversation, LoadError, TabPage, WorkspaceTabs, readLastOpened, rememberLastOpened } from "@/components/workspace/WorkspaceApp";
import { ExecWidgetBody } from "@/components/dashboard/ExecWidgetBody";
import { ModeFrame } from "@/components/modes/ModeFrame";
import { ModeGlyph, modeHsl } from "@/components/modes/ModeIcon";
import { ModeEditor } from "@/components/modes/ModeEditor";
import { ChartsTab, LogTab, RemindersPanel } from "@/components/modes/ModeParts";
import { useQuery } from "@tanstack/react-query";
import {
  MODE_SOURCE_LABELS, describeModeChanges, exportModeTemplate, modeMemoryApp, parseModeDigest, sanitizeAiMode,
  type AiMode, type ModeDigest, type ModeInsight, type ModeTab,
} from "@shared/ai-modes";

/** What the mode's scheduled check-ins found (its own row; the cron writes it). */
function useDigest(modeId: string) {
  return useQuery<ModeDigest>({
    queryKey: [`/api/workspace/modes/${modeId}/digest`],
    queryFn: async () => parseModeDigest(await apiRequest("GET", `/api/workspace/modes/${modeId}/digest`).then((r) => r.json())),
    staleTime: 5 * 60_000,
  });
}
const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
import type { ExecWidget } from "@shared/exec-widgets";

const SETTINGS = "__settings";

function readsLine(mode: AiMode): string {
  return mode.access.length ? `Reads: ${mode.access.map((s) => MODE_SOURCE_LABELS[s].label).join(" · ")}.` : "Reads nothing on file — only what you tell it.";
}

function Cards({ widgets, mode }: { widgets: ExecWidget[]; mode: AiMode }) {
  const todayISO = getUserToday();
  if (widgets.length === 0) return <p className="text-sm text-muted-foreground">No cards on this tab yet. Add one in Settings.</p>;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {widgets.map((w) => (
        <div key={w.id} className="bubble p-3 min-w-0" data-testid={`mode-card-${w.id}`}>
          <p className="text-[13px] font-bold mb-1.5 truncate">{w.title}</p>
          <ExecWidgetBody widget={w} todayISO={todayISO} accent={modeHsl(mode.color)} />
        </div>
      ))}
    </div>
  );
}

function InsightsTab({ mode, tab }: { mode: AiMode; tab: ModeTab }) {
  const digest = useDigest(mode.id);
  const checkin = mode.checkins.find((c) => c.tabId === tab.id && c.enabled);
  const lastRun = digest.data?.runs[tab.id];
  const [state, setState] = useState<{ items: ModeInsight[]; read: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true); setError(null);
    try {
      const r = await apiRequest("POST", "/api/workspace/modes/insights", { modeId: mode.id, tabId: tab.id });
      const j = await r.json();
      if (!j || !Array.isArray(j.items)) throw new Error("The AI did not return a usable answer.");
      setState({ items: j.items, read: Array.isArray(j.read) ? j.read : [] });
    } catch (err) { setError(aiErrorText(err)); } finally { setBusy(false); }
  };
  return (
    <TabPage testId={`mode-insights-${tab.id}`}>
      <div className="bubble p-3">
        <p className="micro-label text-muted-foreground">What this tab looks at</p>
        <p className="text-sm mt-1">{tab.focus}</p>
        <p className="text-[11px] text-muted-foreground mt-1.5 flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" /> {readsLine(mode)}</p>
        <button type="button" onClick={() => void run()} disabled={busy}
          className="mt-3 h-9 px-4 rounded-full text-sm font-semibold text-white flex items-center gap-1.5 disabled:opacity-60" style={{ background: `hsl(${modeHsl(mode.color)})` }}
          data-testid={`mode-insights-run-${tab.id}`}>
          {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> Looking at your records…</> : <><Sparkles className="h-4 w-4" /> {state ? "Look again" : "Analyze"}</>}
        </button>
      </div>
      {checkin && (
        <p className="text-[11px] text-muted-foreground mt-2" data-testid={`mode-checkin-note-${tab.id}`}>
          Runs on its own {checkin.freq === "daily" ? "every day" : "every week"}; you get a notification when it has something.
          {lastRun ? ` Last check-in: ${when(lastRun.at)}.` : " It hasn't run yet."}
        </p>
      )}
      {!state && lastRun && lastRun.items.length > 0 && (
        <ul className="space-y-2 mt-3" data-testid={`mode-checkin-items-${tab.id}`}>
          {lastRun.items.map((it, i) => (
            <li key={i} className="bubble p-3">
              <p className="text-sm font-semibold">{it.title}</p>
              <p className="text-[13px] mt-1 whitespace-pre-wrap">{it.detail}</p>
              <p className="text-[11px] text-muted-foreground mt-1.5">From: {it.sources.map((s) => MODE_SOURCE_LABELS[s]?.label ?? s).join(", ")} · check-in of {when(lastRun.at)}</p>
            </li>
          ))}
        </ul>
      )}
      {error && <div role="alert" className="text-xs rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-2 mt-3" data-testid={`mode-insights-error-${tab.id}`}>{error} <button type="button" className="underline ml-1" onClick={() => void run()}>Try again</button></div>}
      {state && (
        state.items.length === 0 ? (
          <p className="text-sm text-muted-foreground mt-3" data-testid={`mode-insights-empty-${tab.id}`}>Your records don't say enough about this yet. As you add more, ask again.</p>
        ) : (
          <ul className="space-y-2 mt-3" data-testid={`mode-insights-items-${tab.id}`}>
            {state.items.map((it, i) => (
              <li key={i} className="bubble p-3">
                <p className="text-sm font-semibold">{it.title}</p>
                <p className="text-[13px] mt-1 whitespace-pre-wrap">{it.detail}</p>
                <p className="text-[11px] text-muted-foreground mt-1.5">From: {it.sources.map((s) => MODE_SOURCE_LABELS[s]?.label ?? s).join(", ")}</p>
              </li>
            ))}
          </ul>
        )
      )}
      <p className="text-[11px] text-muted-foreground mt-3">Asked only when you tap. It reads your records and changes nothing. General information, not professional advice.</p>
    </TabPage>
  );
}

function OverviewTab({ mode, tab, onPrompt, onSettings, onTab }: { mode: AiMode; tab: ModeTab; onPrompt: (text: string) => void; onSettings: () => void; onTab: (id: string) => void }) {
  const hsl = modeHsl(mode.color);
  const digest = useDigest(mode.id);
  const latest = Object.entries(digest.data?.runs ?? {}).filter(([, r]) => r.items.length > 0).sort((a, b) => b[1].at.localeCompare(a[1].at))[0];
  return (
    <TabPage testId={`mode-overview-${tab.id}`}>
      <div className="rounded-2xl p-4 border" style={{ background: `linear-gradient(135deg, hsl(${hsl} / 0.18), transparent)`, borderColor: `hsl(${hsl} / 0.35)` }}>
        <div className="flex items-start gap-3">
          <ModeGlyph icon={mode.icon} color={mode.color} size="lg" />
          <div className="min-w-0">
            <p className="text-base font-bold">{mode.name}</p>
            {mode.tagline && <p className="text-[13px] text-muted-foreground">{mode.tagline}</p>}
          </div>
        </div>
        {mode.instructions && <p className="text-[13px] mt-3 whitespace-pre-wrap line-clamp-5">{mode.instructions}</p>}
        <p className="text-[11px] text-muted-foreground mt-2 flex items-center gap-1 flex-wrap">
          <ShieldCheck className="h-3.5 w-3.5" /> {readsLine(mode)}
          <button type="button" className="underline" onClick={onSettings}>Change</button>
        </p>
      </div>
      {mode.prompts.length > 0 && (
        <section className="mt-4">
          <p className="text-sm font-bold mb-2">Suggested conversations</p>
          <div className="flex flex-col gap-1.5">
            {mode.prompts.map((p) => (
              <button key={p} type="button" onClick={() => onPrompt(p)} className="bubble px-3 py-2 text-left text-sm flex items-center gap-2 pressable" data-testid="mode-prompt">
                <MessageCircle className="h-4 w-4 shrink-0" style={{ color: `hsl(${hsl})` }} /> <span className="flex-1">{p}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {latest && (
        <section className="mt-4 bubble p-3" data-testid="mode-noticed">
          <p className="micro-label text-muted-foreground">What I've noticed · {when(latest[1].at)}</p>
          <p className="text-sm font-semibold mt-1">{latest[1].items[0].title}</p>
          <p className="text-[13px] mt-0.5 line-clamp-3">{latest[1].items[0].detail}</p>
          <button type="button" className="text-xs underline mt-1.5" onClick={() => onTab(latest[0])}>See the whole check-in</button>
        </section>
      )}
      {(tab.widgets ?? []).length > 0 && <section className="mt-4"><Cards widgets={tab.widgets ?? []} mode={mode} /></section>}
      <RemindersPanel mode={mode} />
    </TabPage>
  );
}

/** Share the mode's SETUP to the public library — shown in full first, then one more tap. */
function PublishButton({ mode }: { mode: AiMode }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const shared = exportModeTemplate(mode) as { mode: AiMode };
  const publish = async () => {
    setBusy(true);
    try {
      await apiRequest("POST", "/api/workspace/modes/library", { modeId: mode.id });
      setOpen(false);
      toast({ title: "Published to the mode library", description: "Anyone can install a copy. Unpublish it any time from AI Modes → Library." });
    } catch (err) { toast({ title: "Couldn't publish it", description: aiErrorText(err), variant: "destructive" }); }
    finally { setBusy(false); }
  };
  if (!open) {
    return <button type="button" onClick={() => setOpen(true)} className="h-8 px-3 rounded-full border border-border text-xs flex items-center gap-1" data-testid="mode-publish"><Sparkles className="h-3.5 w-3.5" /> Publish to library</button>;
  }
  return (
    <div className="w-full rounded-xl border border-primary/40 bg-primary/5 p-3 text-sm" data-testid="mode-publish-review">
      <p className="font-semibold">Publish “{mode.name}” to the public library?</p>
      <p className="text-[12px] text-muted-foreground mt-1">Anyone using Portol can see and install a copy of this setup. Your name, conversations, memories, records and journal are never shared. Read what will be shared — the instructions are your own words:</p>
      <dl className="text-[12px] mt-2 space-y-1">
        <div><dt className="inline font-semibold">Tagline: </dt><dd className="inline">{shared.mode.tagline || "—"}</dd></div>
        <div><dt className="inline font-semibold">Personality: </dt><dd className="inline">{shared.mode.personality || "—"}</dd></div>
        <div><dt className="font-semibold">Instructions:</dt><dd className="whitespace-pre-wrap" data-testid="mode-publish-instructions">{shared.mode.instructions || "—"}</dd></div>
        <div><dt className="inline font-semibold">Tabs: </dt><dd className="inline">{shared.mode.tabs.map((t) => t.title).join(", ")}</dd></div>
      </dl>
      <div className="flex gap-2 mt-3">
        <button type="button" onClick={() => setOpen(false)} className="h-8 px-3 rounded-full border border-border text-xs">Cancel</button>
        <button type="button" onClick={() => void publish()} disabled={busy} className="h-8 px-3 rounded-full bg-primary text-primary-foreground text-xs font-semibold disabled:opacity-50" data-testid="mode-publish-confirm">
          {busy ? "Publishing…" : "Publish"}
        </button>
      </div>
    </div>
  );
}

function SettingsTab({ mode, draft, setDraft, saving, onSave, onUndo, onDeleted }: {
  mode: AiMode; draft: AiMode; setDraft: (m: AiMode) => void; saving: boolean; onSave: () => Promise<boolean>; onUndo: () => void; onDeleted: () => void;
}) {
  const m = useAiModes();
  const { toast } = useToast();
  const { confirm, isArmed } = useConfirmArm();
  const [instruction, setInstruction] = useState("");
  const [revising, setRevising] = useState(false);
  const [proposal, setProposal] = useState<{ mode: AiMode; changes: string[] } | null>(null);
  const [reviseError, setReviseError] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(mode);

  const revise = async () => {
    const said = instruction.trim();
    if (said.length < 3 || revising) return;
    setRevising(true); setReviseError(null);
    try {
      const r = await apiRequest("POST", "/api/workspace/modes/revise", { modeId: mode.id, instruction: said });
      const j = await r.json();
      const next = j?.mode ? sanitizeAiMode(j.mode, { keepJournal: true }) : null;
      if (!next) throw new Error("The AI did not return a usable change.");
      const changes = describeModeChanges(mode, next);
      setProposal({ mode: next, changes });
    } catch (err) { setReviseError(aiErrorText(err)); } finally { setRevising(false); }
  };
  const apply = async () => {
    if (!proposal) return;
    try {
      const { id: _i, createdAt: _c, updatedAt: _u, ...patch } = proposal.mode;
      await m.update(mode.id, patch);
      setProposal(null); setInstruction("");
      toast({ title: "Mode updated" });
    } catch (err) { toast({ title: "Couldn't apply that change", description: aiErrorText(err), variant: "destructive" }); }
  };

  return (
    <TabPage testId="mode-settings">
      <section className="bubble p-3 space-y-2" data-testid="mode-revise">
        <p className="text-sm font-bold flex items-center gap-1.5"><Wand2 className="h-4 w-4 text-primary" /> Change it by talking</p>
        <p className="text-[11px] text-muted-foreground">e.g. "Add a sleep analysis tab and compare my sleep against my workout performance". You'll see what would change before anything is saved.</p>
        <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={2} maxLength={1500} aria-label="What to change"
          className="ws-title w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60 resize-y" data-testid="mode-revise-input" />
        <button type="button" onClick={() => void revise()} disabled={revising || instruction.trim().length < 3}
          className="h-9 px-4 rounded-full bg-primary text-primary-foreground text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50" data-testid="mode-revise-run">
          {revising ? <><Loader2 className="h-4 w-4 animate-spin" /> Working it out…</> : "Propose the change"}
        </button>
        {reviseError && <p role="alert" className="text-xs text-destructive" data-testid="mode-revise-error">{reviseError}</p>}
        {proposal && (
          <div className="rounded-xl border border-primary/40 bg-primary/5 p-2.5" data-testid="mode-revise-proposal">
            {proposal.changes.length === 0 ? <p className="text-sm">That would change nothing.</p> : (
              <ul className="text-sm list-disc pl-5 space-y-0.5">{proposal.changes.map((c) => <li key={c}>{c}</li>)}</ul>
            )}
            <div className="flex gap-2 mt-2">
              <button type="button" onClick={() => setProposal(null)} className="h-8 px-3 rounded-full border border-border text-xs" data-testid="mode-revise-discard">Discard</button>
              {proposal.changes.length > 0 && (
                <button type="button" onClick={() => void apply()} disabled={dirty} title={dirty ? "Save or undo your own edits first" : undefined}
                  className="h-8 px-3 rounded-full bg-primary text-primary-foreground text-xs font-semibold disabled:opacity-50" data-testid="mode-revise-apply">Apply</button>
              )}
            </div>
            {dirty && <p className="text-[11px] text-muted-foreground mt-1">Save or undo your edits below first.</p>}
          </div>
        )}
      </section>

      <section className="mt-4">
        <ModeEditor value={draft} onChange={setDraft} />
      </section>

      <div className="flex flex-wrap gap-2 sticky bottom-0 bg-background/95 py-2 mt-3">
        <button type="button" onClick={onUndo} disabled={!dirty || saving} className="h-9 px-4 rounded-full border border-border text-sm disabled:opacity-40" data-testid="mode-settings-undo">Undo changes</button>
        <button type="button" onClick={() => void onSave()} disabled={!dirty || saving}
          className="h-9 flex-1 rounded-full bg-primary text-primary-foreground text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50" data-testid="mode-settings-save">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {dirty ? "Save changes" : "Saved"}
        </button>
      </div>

      <section className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={() => void m.update(mode.id, { pinned: !mode.pinned }).catch((err) => toast({ title: "Couldn't change the pin", description: aiErrorText(err), variant: "destructive" }))}
          className="h-8 px-3 rounded-full border border-border text-xs flex items-center gap-1" data-testid="mode-settings-pin">
          {mode.pinned ? <><PinOff className="h-3.5 w-3.5" /> Unpin from the Chat page</> : <><Pin className="h-3.5 w-3.5" /> Pin to the Chat page</>}
        </button>
        <button type="button" onClick={() => void m.duplicate(mode.id).then((copy) => { if (copy) hashNavigate(modeRoute(copy.id)); }).catch((err) => toast({ title: "Couldn't duplicate it", description: aiErrorText(err), variant: "destructive" }))}
          className="h-8 px-3 rounded-full border border-border text-xs flex items-center gap-1"><Copy className="h-3.5 w-3.5" /> Duplicate</button>
        <button type="button" onClick={() => {
          const blob = new Blob([JSON.stringify(exportModeTemplate(mode), null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `${mode.id}.portol-mode.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        }} className="h-8 px-3 rounded-full border border-border text-xs flex items-center gap-1" title="The mode's setup only — no conversations, memories or records">
          <Download className="h-3.5 w-3.5" /> Export template</button>
        <PublishButton mode={mode} />
        <button type="button" onClick={() => confirm("delete", () => void m.remove(mode.id).then(onDeleted).catch((err) => toast({ title: "Couldn't delete it", description: aiErrorText(err), variant: "destructive" })))}
          className={`h-8 px-3 rounded-full text-xs ${isArmed("delete") ? "bg-destructive text-destructive-foreground" : "border border-border text-muted-foreground"}`} data-testid="mode-settings-delete">
          {isArmed("delete") ? "Tap again: delete this mode and its conversation" : "Delete mode"}
        </button>
      </section>
    </TabPage>
  );
}

export default function ModeWorkspacePage({ params }: { params?: { id?: string } }) {
  const id = String(params?.id || "");
  const m = useAiModes();
  const { toast } = useToast();
  const mode = m.modes?.find((x) => x.id === id) ?? null;
  const app = `mode:${id}`;
  const [active, setActive] = useState<string>(() => readLastOpened(app).tab || "");
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  const [sendNow, setSendNow] = useState<{ text: string; key: number } | null>(null);
  const [draft, setDraft] = useState<AiMode | null>(null);
  const [saving, setSaving] = useState(false);

  // The settings draft follows the stored mode (a change applied by talking,
  // a pin) as long as the person has not edited it.
  const base = useRef<AiMode | null>(null);
  useEffect(() => {
    if (!mode) return;
    if (!draft || draft.id !== mode.id || JSON.stringify(draft) === JSON.stringify(base.current)) setDraft(mode);
    base.current = mode;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
  const dirty = !!(mode && draft && JSON.stringify(draft) !== JSON.stringify(mode));
  useUnsavedWarning(dirty);

  const tabIds = useMemo(() => (mode ? [...mode.tabs.map((t) => t.id), SETTINGS] : []), [mode]);
  const current = tabIds.includes(active) ? active : (mode?.tabs[0]?.id ?? SETTINGS);
  useEffect(() => { if (mode) setVisited((v) => (v.has(current) ? v : new Set(v).add(current))); }, [current, mode]);
  const pick = (t: string) => { setActive(t); rememberLastOpened(app, { tab: t }); };
  const chatTab = mode?.tabs.find((t) => t.kind === "chat");

  const save = async (): Promise<boolean> => {
    if (!mode || !draft || !dirty) return true;
    const clean = sanitizeAiMode(draft, { id: mode.id, keepJournal: true });
    if (!clean) { toast({ title: "The mode needs a name", variant: "destructive" }); return false; }
    setSaving(true);
    try {
      const { id: _i, createdAt: _c, updatedAt: _u, ...patch } = clean;
      const saved = await m.update(mode.id, patch);
      if (saved) setDraft(saved);
      return true;
    } catch (err) {
      toast({ title: "Couldn't save the mode", description: aiErrorText(err), variant: "destructive" });
      return false;
    } finally { setSaving(false); }
  };

  if (m.failed) {
    return <ModeFrame testId="workspace-mode" icon={<Sparkles className="h-5 w-5 ml-1" />} title="AI Mode"><TabPage><LoadError what="this mode" onRetry={() => void m.retry()} testId="mode-load-error" /></TabPage></ModeFrame>;
  }
  if (!m.modes) {
    return <ModeFrame testId="workspace-mode" icon={<Sparkles className="h-5 w-5 ml-1" />} title="AI Mode"><TabPage><p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p></TabPage></ModeFrame>;
  }
  if (!mode || !draft) {
    return (
      <ModeFrame testId="workspace-mode" icon={<Sparkles className="h-5 w-5 ml-1" />} title="AI Mode">
        <TabPage testId="mode-missing">
          <p className="text-sm">This mode no longer exists.</p>
          <button type="button" onClick={() => hashNavigate(MODES_ROUTE)} className="mt-2 h-9 px-4 rounded-full border border-border text-sm">See your AI modes</button>
        </TabPage>
      </ModeFrame>
    );
  }

  return (
    <ModeFrame
      testId="workspace-mode"
      icon={<ModeGlyph icon={mode.icon} color={mode.color} size="sm" />}
      title={mode.name}
      sub={mode.tagline || "Custom AI workspace"}
      onClose={async () => { if (!(await save())) return false; hashNavigate("/chat"); }}
      tabs={<WorkspaceTabs label={`${mode.name} tabs`} active={current} onPick={pick}
        tabs={[...mode.tabs.map((t) => ({ id: t.id, label: t.title })), { id: SETTINGS, label: "Settings", icon: Settings }]} />}
    >
      {mode.tabs.map((t) => {
        if (!visited.has(t.id) && t.id !== current) return null;
        const hidden = t.id !== current;
        return (
          <div key={t.id} className={hidden ? "hidden" : "flex-1 min-h-0 flex flex-col"} data-testid={`mode-tab-${t.id}`}>
            {t.kind === "chat" ? (
              <AiConversation
                testId="mode-chat"
                memoryApp={modeMemoryApp(mode.id)}
                accessLine={<p className="text-[11px] text-muted-foreground flex items-center gap-1.5 flex-wrap" data-testid="mode-chat-reads"><ShieldCheck className="h-3.5 w-3.5 shrink-0" />{readsLine(mode)}<button type="button" className="underline" onClick={() => pick(SETTINGS)}>Change</button></p>}
                intro={`${mode.name}. ${mode.tagline || "Ask me anything."}`}
                suggestions={mode.prompts}
                placeholder={`Talk to ${mode.name}…`}
                sendNow={sendNow}
                ask={async (turns) => {
                  const r = await apiRequest("POST", "/api/workspace/modes/chat", { modeId: mode.id, messages: turns });
                  const j = await r.json();
                  if (!j || typeof j.answer !== "string") throw new Error("The AI returned nothing.");
                  return { answer: j.answer, note: j.note, remembered: j.remembered };
                }}
              />
            ) : t.kind === "insights" ? <InsightsTab mode={mode} tab={t} />
              : t.kind === "charts" ? <ChartsTab tab={t} />
              : t.kind === "log" && t.tracker ? <LogTab tab={t} />
              : t.kind === "overview" ? <OverviewTab mode={mode} tab={t} onSettings={() => pick(SETTINGS)} onTab={pick}
                  onPrompt={(text) => { if (chatTab) { pick(chatTab.id); setSendNow({ text, key: Date.now() }); } }} />
              : <TabPage testId={`mode-widgets-${t.id}`}><Cards widgets={t.widgets ?? []} mode={mode} /></TabPage>}
          </div>
        );
      })}
      {(visited.has(SETTINGS) || current === SETTINGS) && (
        <div className={current === SETTINGS ? "flex-1 min-h-0 flex flex-col" : "hidden"}>
          <SettingsTab mode={mode} draft={draft} setDraft={setDraft} saving={saving} onSave={save} onUndo={() => setDraft(mode)} onDeleted={() => hashNavigate(MODES_ROUTE)} />
        </div>
      )}
    </ModeFrame>
  );
}
