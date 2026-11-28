// AI Modes: the person's own modes, and the builder that makes new ones
// (owner request 2026-11-27; shared/ai-modes.ts).
//
//  - Your AI Modes: open, pin to the Chat page, rearrange, duplicate, export,
//    delete (two taps). Every change is one server route over the stored row.
//  - Create Mode: describe it in your own words → the AI (or, with no model,
//    the fixed rules) proposes a whole mode → review and change every part →
//    Save. Generating writes nothing (W5). A template or an imported file
//    goes through the same review.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Copy, Download, Flag, GripVertical, Layers, Library, Loader2, Pin, PinOff, Plus, Search, Sparkles, Upload, Wand2 } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDragReorder } from "@/components/modes/useDragReorder";
import { apiRequest } from "@/lib/queryClient";
import { hashNavigate } from "@/lib/hashNavigate";
import { useToast } from "@/hooks/use-toast";
import { useConfirmArm } from "@/hooks/useConfirmArm";
import { useAiModes, modeRoute } from "@/lib/ai-modes-client";
import { aiErrorText } from "@/components/workspace/WorkspaceShell";
import { LoadError, WorkspaceTabs } from "@/components/workspace/WorkspaceApp";
import { ModeFrame } from "@/components/modes/ModeFrame";
import { ModeGlyph } from "@/components/modes/ModeIcon";
import { ModeEditor } from "@/components/modes/ModeEditor";
import {
  MODE_TEMPLATES, MAX_MODES, exportModeTemplate, importModeTemplate, modeFromTemplate, sanitizeAiMode, type AiMode, type ModeProposal,
} from "@shared/ai-modes";

export const MODE_IDEAS = [
  "An AI that helps me understand myself emotionally",
  "An AI that manages my business and projects",
  "An AI that analyzes my fitness and nutrition",
];

type Tab = "mine" | "library" | "create";

interface LibraryCard { id: string; name: string; tagline: string; icon: AiMode["icon"]; color: AiMode["color"]; tabs: string[]; installs: number; publishedAt: string; mine: boolean }

/** The public library: browse, search, install a copy (to review), report; unpublish your own (two taps). */
function LibraryTab({ onInstall }: { onInstall: (mode: AiMode) => void }) {
  const { toast } = useToast();
  const { confirm, isArmed } = useConfirmArm();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [sort, setSort] = useState<"popular" | "new">("popular");
  const [mine, setMine] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const key = ["/api/workspace/modes/library", term, sort, mine ? "mine" : "all"];
  const lib = useQuery<LibraryCard[]>({
    queryKey: key,
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/workspace/modes/library?q=${encodeURIComponent(term)}&sort=${sort}${mine ? "&mine=1" : ""}`);
      const j = await r.json();
      if (!j || !Array.isArray(j.items)) throw new Error("Unexpected response");
      return j.items;
    },
    staleTime: 60_000,
  });
  const act = async (id: string, fn: () => Promise<void>, fail: string) => {
    setBusy(id);
    try { await fn(); } catch (err) { toast({ title: fail, description: aiErrorText(err), variant: "destructive" }); } finally { setBusy(null); }
  };
  return (
    <div className="space-y-3" data-testid="modes-library">
      <p className="text-[12px] text-muted-foreground">Modes other people built and shared. Installing gives you your own copy to review and change before it's saved; it reads only what you allow, and never anyone else's data.</p>
      <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); setTerm(q.trim()); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search modes" aria-label="Search the mode library"
          className="ws-title flex-1 min-w-0 h-9 rounded-full border border-border bg-background px-3 text-sm outline-none" data-testid="modes-library-search" />
        <button type="submit" aria-label="Search" className="h-9 w-9 rounded-full border border-border flex items-center justify-center"><Search className="h-4 w-4" /></button>
      </form>
      <div className="flex gap-1.5 flex-wrap">
        {(["popular", "new"] as const).map((s) => (
          <button key={s} type="button" aria-pressed={!mine && sort === s} onClick={() => { setMine(false); setSort(s); }}
            className={`h-7 px-3 rounded-full text-xs ${!mine && sort === s ? "bg-foreground text-background font-semibold" : "border border-border text-muted-foreground"}`}>{s === "popular" ? "Popular" : "Newest"}</button>
        ))}
        <button type="button" aria-pressed={mine} onClick={() => setMine(true)}
          className={`h-7 px-3 rounded-full text-xs ${mine ? "bg-foreground text-background font-semibold" : "border border-border text-muted-foreground"}`} data-testid="modes-library-mine">Published by me</button>
      </div>
      {term && <p className="text-[11px] text-muted-foreground">Showing modes matching “{term}”. <button type="button" className="underline" onClick={() => { setQ(""); setTerm(""); }}>Show all</button></p>}
      {lib.isError && lib.data === undefined ? (
        <div role="alert" className="text-sm" data-testid="modes-library-error">
          <p className="text-destructive">{aiErrorText(lib.error)}</p>
          <button type="button" className="underline text-xs mt-1" onClick={() => void lib.refetch()}>Retry</button>
        </div>
      ) : !lib.data ? <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
        : lib.data.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="modes-library-empty">
            {mine ? "You haven't published a mode. Open one of yours → Settings → Publish to library." : term ? "No published mode matches that." : "Nothing has been published yet. Be the first: open one of your modes → Settings → Publish to library."}
          </p>
        ) : (
          <ul className="space-y-2" data-testid="modes-library-list">
            {lib.data.map((c) => (
              <li key={c.id} className="bubble p-3" data-testid={`library-card-${c.id}`}>
                <div className="flex items-start gap-3">
                  <ModeGlyph icon={c.icon} color={c.color} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold truncate">{c.name}{c.mine && <span className="ml-1.5 text-[11px] font-semibold rounded-full px-1.5 py-0.5 bg-primary/15 text-primary">Yours</span>}</p>
                    {c.tagline && <p className="text-[12px] text-muted-foreground line-clamp-2">{c.tagline}</p>}
                    <p className="text-[11px] text-muted-foreground mt-0.5">{c.tabs.join(" · ")} · {c.installs} install{c.installs === 1 ? "" : "s"}</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-2 pl-12">
                  <button type="button" disabled={busy !== null} onClick={() => void act(c.id, async () => {
                    const j = await apiRequest("POST", `/api/workspace/modes/library/${c.id}/install`).then((r) => r.json());
                    const mode = j?.mode ? sanitizeAiMode(j.mode, { keepJournal: false }) : null;
                    if (!mode) throw new Error("That mode couldn't be read.");
                    onInstall(mode);
                  }, "Couldn't install it")}
                    className="h-7 px-3 rounded-full bg-primary text-primary-foreground text-[11px] font-semibold" data-testid={`library-install-${c.id}`}>{busy === c.id ? "…" : "Install a copy"}</button>
                  {c.mine ? (
                    <button type="button" disabled={busy !== null} onClick={() => confirm(`unpub:${c.id}`, () => void act(c.id, async () => {
                      await apiRequest("DELETE", `/api/workspace/modes/library/${c.id}`);
                      await qc.invalidateQueries({ queryKey: ["/api/workspace/modes/library"] });
                    }, "Couldn't unpublish it"))}
                      className={`h-7 px-3 rounded-full text-[11px] ${isArmed(`unpub:${c.id}`) ? "bg-destructive text-destructive-foreground" : "border border-border text-muted-foreground"}`} data-testid={`library-unpublish-${c.id}`}>
                      {isArmed(`unpub:${c.id}`) ? "Tap again to unpublish" : "Unpublish"}
                    </button>
                  ) : (
                    <button type="button" disabled={busy !== null} onClick={() => confirm(`report:${c.id}`, () => void act(c.id, async () => {
                      await apiRequest("POST", `/api/workspace/modes/library/${c.id}/report`);
                      toast({ title: "Thanks — reported", description: "A mode reported by several people is taken out of the library." });
                    }, "Couldn't report it"))}
                      className={`h-7 px-3 rounded-full text-[11px] flex items-center gap-1 ${isArmed(`report:${c.id}`) ? "bg-destructive text-destructive-foreground" : "border border-border text-muted-foreground"}`} data-testid={`library-report-${c.id}`}>
                      <Flag className="h-3 w-3" /> {isArmed(`report:${c.id}`) ? "Tap again to report" : "Report"}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

const swap = (ids: string[], i: number, j: number) => { const out = ids.slice(); [out[i], out[j]] = [out[j], out[i]]; return out; };

/** Save a file to the person's device (a template carries no private data). */
function downloadJson(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ModesWorkspacePage() {
  const query = useMemo(() => new URLSearchParams(typeof window !== "undefined" ? (window.location.hash.split("?")[1] || "") : ""), []);
  const [tab, setTab] = useState<Tab>(query.get("new") ? "create" : "mine");
  const m = useAiModes();
  const { toast } = useToast();
  const { confirm, isArmed } = useConfirmArm();
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Create
  // A description handed over from the main chat ("make me an AI that …").
  const handed = (query.get("describe") || "").trim().slice(0, 1500);
  const [description, setDescription] = useState(handed);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ModeProposal | null>(null);
  const [saving, setSaving] = useState(false);

  const act = async (key: string, fn: () => Promise<unknown>, fail: string) => {
    setBusy(key);
    try { await fn(); } catch (err) { toast({ title: fail, description: aiErrorText(err), variant: "destructive" }); } finally { setBusy(null); }
  };

  const generate = async (text = description) => {
    const said = text.trim();
    if (said.length < 4 || generating) return;
    setDescription(said);
    setGenerating(true);
    setGenError(null);
    try {
      const r = await apiRequest("POST", "/api/workspace/modes/generate", { description: said });
      const j = await r.json();
      const mode = j?.mode ? sanitizeAiMode(j.mode, { keepJournal: false }) : null;
      if (!mode) throw new Error("The builder did not return a usable mode. Please try again.");
      setDraft({ mode, suggestJournal: !!j.suggestJournal, by: j.by === "rules" ? "rules" : "ai" });
    } catch (err) { setGenError(aiErrorText(err)); } finally { setGenerating(false); }
  };

  // Asked for in the chat: build the proposal at once (a proposal writes
  // nothing — AM4; the person still reviews and saves).
  const autoBuilt = useRef(false);
  useEffect(() => {
    if (!handed || autoBuilt.current) return;
    autoBuilt.current = true;
    void generate(handed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (!draft || saving) return;
    const clean = sanitizeAiMode(draft.mode, { keepJournal: true });
    if (!clean) { toast({ title: "Give the mode a name first", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const saved = await m.create(clean);
      setDraft(null); setDescription("");
      if (saved) hashNavigate(modeRoute(saved.id));
    } catch (err) {
      toast({ title: "Couldn't save the mode", description: aiErrorText(err), variant: "destructive" });
    } finally { setSaving(false); }
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const mode = importModeTemplate(await file.text(), m.modes ?? [], new Date());
      if (!mode) throw new Error("That file isn't a Portol AI mode.");
      setDraft({ mode, suggestJournal: false, by: "rules" });
      setTab("create");
    } catch (err) { toast({ title: "Couldn't import that file", description: aiErrorText(err), variant: "destructive" }); }
  };

  const modes = m.modes ?? [];
  const full = modes.length >= MAX_MODES;
  const drag = useDragReorder(modes.map((x) => x.id), (ids) => void act("order", () => m.reorder(ids), "Couldn't move it"));
  const shown = drag.order.map((id) => modes.find((x) => x.id === id)!).filter(Boolean);

  return (
    <ModeFrame
      testId="workspace-modes"
      icon={<Layers className="h-5 w-5 text-primary shrink-0 ml-1" aria-hidden />}
      title="AI Modes"
      sub="Your own AI workspaces"
      tabs={<WorkspaceTabs label="AI Modes" active={tab} onPick={(t) => setTab(t)} tabs={[
        { id: "mine", label: "Your AI Modes", badge: m.modes ? modes.length : null },
        { id: "library", label: "Library", icon: Library },
        { id: "create", label: "Create Mode", icon: Sparkles },
      ]} />}
    >
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain" data-workspace-scroll>
        <div className="max-w-2xl mx-auto px-3 sm:px-6 py-4 space-y-4">
          {tab === "mine" && (
            m.failed ? <LoadError what="your AI modes" onRetry={() => void m.retry()} testId="modes-error" />
              : !m.modes ? <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
              : (
                <>
                  {modes.length === 0 ? (
                    <div className="bubble p-4 text-center" data-testid="modes-empty">
                      <Sparkles className="h-6 w-6 text-primary mx-auto" />
                      <p className="text-sm font-semibold mt-2">You haven't built a mode yet</p>
                      <p className="text-[12px] text-muted-foreground mt-1">Describe what you want your AI to do, and it builds a workspace around it.</p>
                      <button type="button" onClick={() => setTab("create")} className="mt-3 h-9 px-4 rounded-full bg-primary text-primary-foreground text-sm font-semibold">Create a mode</button>
                    </div>
                  ) : (
                    <ul className="space-y-2" data-testid="modes-list">
                      {shown.map((mode, i) => (
                        <li key={mode.id} ref={drag.itemRef(mode.id)} className={`bubble p-3 ${drag.dragging === mode.id ? "ring-2 ring-primary" : ""}`} data-testid={`mode-row-${mode.id}`}>
                          <div className="flex items-start gap-3">
                            <span {...drag.handleProps(mode.id)} className="h-9 w-5 -ml-1 flex items-center justify-center text-muted-foreground shrink-0" data-testid={`mode-drag-${mode.id}`}>
                              <GripVertical className="h-4 w-4" />
                            </span>
                            <button type="button" onClick={() => hashNavigate(modeRoute(mode.id))} className="flex items-start gap-3 flex-1 min-w-0 text-left" data-testid={`mode-open-${mode.id}`}>
                              <ModeGlyph icon={mode.icon} color={mode.color} />
                              <span className="min-w-0">
                                <span className="text-sm font-bold block truncate">{mode.name}</span>
                                <span className="text-[12px] text-muted-foreground block line-clamp-2">{mode.tagline || mode.tabs.map((t) => t.title).join(" · ")}</span>
                              </span>
                            </button>
                            <button type="button" disabled={busy !== null}
                              onClick={() => void act(`pin:${mode.id}`, () => m.update(mode.id, { pinned: !mode.pinned }), "Couldn't change the pin")}
                              aria-pressed={mode.pinned} aria-label={mode.pinned ? `Unpin ${mode.name} from the Chat page` : `Pin ${mode.name} to the Chat page`}
                              title={mode.pinned ? "Pinned to the Chat page" : "Pin to the Chat page"}
                              className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 ${mode.pinned ? "bg-primary/15 text-primary" : "border border-border text-muted-foreground"}`}
                              data-testid={`mode-pin-${mode.id}`}>
                              {mode.pinned ? <Pin className="h-3.5 w-3.5" /> : <PinOff className="h-3.5 w-3.5" />}
                            </button>
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5 mt-2 pl-12">
                            <button type="button" aria-label="Move up" disabled={i === 0 || busy !== null}
                              onClick={() => void act("order", () => m.reorder(swap(modes.map((x) => x.id), i, i - 1)), "Couldn't move it")}
                              className="h-7 w-7 rounded-full border border-border flex items-center justify-center disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" /></button>
                            <button type="button" aria-label="Move down" disabled={i === modes.length - 1 || busy !== null}
                              onClick={() => void act("order", () => m.reorder(swap(modes.map((x) => x.id), i, i + 1)), "Couldn't move it")}
                              className="h-7 w-7 rounded-full border border-border flex items-center justify-center disabled:opacity-30"><ArrowDown className="h-3.5 w-3.5" /></button>
                            <button type="button" disabled={busy !== null || full} onClick={() => void act(`dup:${mode.id}`, () => m.duplicate(mode.id), "Couldn't duplicate it")}
                              className="h-7 px-2.5 rounded-full border border-border text-[11px] flex items-center gap-1 disabled:opacity-40" data-testid={`mode-duplicate-${mode.id}`}><Copy className="h-3 w-3" /> Duplicate</button>
                            <button type="button" onClick={() => downloadJson(`${mode.id}.portol-mode.json`, exportModeTemplate(mode))}
                              title="A template: the mode's setup only — no conversations, memories or records"
                              className="h-7 px-2.5 rounded-full border border-border text-[11px] flex items-center gap-1" data-testid={`mode-export-${mode.id}`}><Download className="h-3 w-3" /> Export</button>
                            <button type="button" disabled={busy !== null}
                              onClick={() => confirm(`del:${mode.id}`, () => void act(`del:${mode.id}`, () => m.remove(mode.id), "Couldn't delete it"))}
                              className={`h-7 px-2.5 rounded-full text-[11px] ${isArmed(`del:${mode.id}`) ? "bg-destructive text-destructive-foreground" : "border border-border text-muted-foreground"}`}
                              data-testid={`mode-delete-${mode.id}`}>
                              {isArmed(`del:${mode.id}`) ? "Tap again: delete it and its conversation" : "Delete"}
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => setTab("create")} disabled={full}
                      className="h-9 px-4 rounded-full bg-primary text-primary-foreground text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50" data-testid="modes-create">
                      <Plus className="h-4 w-4" /> Create Mode
                    </button>
                    <button type="button" onClick={() => fileRef.current?.click()} disabled={full}
                      className="h-9 px-4 rounded-full border border-border text-sm flex items-center gap-1.5 disabled:opacity-50" data-testid="modes-import">
                      <Upload className="h-4 w-4" /> Import a template
                    </button>
                    <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { void importFile(e.target.files?.[0]); e.target.value = ""; }} data-testid="modes-import-file" />
                  </div>
                  {full && <p className="text-[12px] text-muted-foreground">You have {MAX_MODES} modes, the most there can be. Delete one to make room.</p>}
                </>
              )
          )}

          {tab === "library" && <LibraryTab onInstall={(mode) => { setDraft({ mode, suggestJournal: false, by: "library" }); setTab("create"); }} />}

          {tab === "create" && !draft && (
            <>
              <section className="bubble p-4 space-y-3" data-testid="mode-builder">
                <div>
                  <h2 className="text-base font-bold flex items-center gap-1.5"><Wand2 className="h-4 w-4 text-primary" /> Create your AI mode</h2>
                  <p className="text-[12px] text-muted-foreground mt-0.5">Describe what you want your AI to do. It builds a workspace around it — name, personality, instructions, tabs and what it may read — for you to review before anything is saved.</p>
                </div>
                <label htmlFor="mode-description" className="text-sm font-semibold block">What do you want your AI to do for you?</label>
                <textarea id="mode-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={1500}
                  placeholder="e.g. Help me plan meals around my workouts and budget"
                  className="ws-title w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60 resize-y" data-testid="mode-description" />
                <div>
                  <p className="text-[11px] font-semibold text-muted-foreground mb-1.5">Try an idea</p>
                  <div className="flex flex-wrap gap-1.5">
                    {MODE_IDEAS.map((idea) => (
                      <button key={idea} type="button" disabled={generating} onClick={() => void generate(idea)}
                        className="text-left text-xs rounded-full border border-border px-3 py-1.5 hover:bg-muted/60" data-testid="mode-idea">{idea}</button>
                    ))}
                  </div>
                </div>
                <button type="button" onClick={() => void generate()} disabled={generating || description.trim().length < 4 || full}
                  className="h-10 w-full rounded-full bg-primary text-primary-foreground text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50" data-testid="mode-generate">
                  {generating ? <><Loader2 className="h-4 w-4 animate-spin" /> Building your mode…</> : <><Sparkles className="h-4 w-4" /> Generate mode concept</>}
                </button>
                {genError && <p role="alert" className="text-xs text-destructive" data-testid="mode-generate-error">{genError} <button type="button" className="underline" onClick={() => void generate()}>Try again</button></p>}
              </section>
              <section>
                <h3 className="text-sm font-bold mb-2">Or start from a template</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {MODE_TEMPLATES.map((t) => (
                    <button key={t.key} type="button" onClick={() => setDraft({ mode: modeFromTemplate(t, modes, new Date()), suggestJournal: !!t.suggestJournal, by: "rules" })}
                      className="bubble p-3 text-left flex items-start gap-2.5 pressable" data-testid={`mode-template-${t.key}`}>
                      <ModeGlyph icon={t.mode.icon} color={t.mode.color} size="sm" />
                      <span className="min-w-0">
                        <span className="text-sm font-semibold block">{t.mode.name}</span>
                        <span className="text-[11px] text-muted-foreground block">{t.mode.tabs.map((x) => x.title).join(" · ")}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            </>
          )}

          {tab === "create" && draft && (
            <section className="space-y-3" data-testid="mode-review">
              <div className="bubble p-3 flex items-start gap-3">
                <ModeGlyph icon={draft.mode.icon} color={draft.mode.color} size="lg" />
                <div className="min-w-0 flex-1">
                  <p className="text-base font-bold truncate">{draft.mode.name || "Untitled mode"}</p>
                  <p className="text-[12px] text-muted-foreground">{draft.mode.tagline}</p>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {draft.by === "ai" ? "Designed by the AI from what you described." : draft.by === "library" ? "A copy of a mode someone published. It reads only what you switch on below." : "Built from a template that fits what you described."} Nothing is saved until you press Save. Change anything below.
                  </p>
                  <div className="flex flex-wrap gap-1 mt-2" aria-label="Tabs">
                    {draft.mode.tabs.map((t) => <span key={t.id} className="text-[11px] rounded-full border border-border px-2 py-0.5">{t.title}</span>)}
                  </div>
                </div>
              </div>
              <ModeEditor value={draft.mode} onChange={(mode) => setDraft({ ...draft, mode })} suggestJournal={draft.suggestJournal} />
              <div className="flex gap-2 sticky bottom-0 bg-background/95 py-2">
                <button type="button" onClick={() => setDraft(null)} className="h-10 px-4 rounded-full border border-border text-sm" data-testid="mode-review-discard">Discard</button>
                <button type="button" onClick={() => void save()} disabled={saving || draft.mode.name.trim().length < 2}
                  className="h-10 flex-1 rounded-full bg-primary text-primary-foreground text-sm font-semibold flex items-center justify-center gap-1.5 disabled:opacity-50" data-testid="mode-review-save">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save and open
                </button>
              </div>
            </section>
          )}
        </div>
      </div>
    </ModeFrame>
  );
}
