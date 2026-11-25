// Word (owner request 2026-11-25): the document app behind the chat box's
// small Word button. Six tabs — My Documents, Editor, Templates, AI Writer,
// AI Review, Version History. The Editor tab is the document editor
// (pages/editor.tsx), which shows the same tab strip, so the two screens are
// one app.
//
// Rules it keeps:
//  - Opening writes nothing (Rule 3). "Use template" and "Open in editor"
//    hand the content to the editor, which saves it as it saves anything
//    typed; nothing is created by looking.
//  - The AI proposes; the user opens or discards (W5). A fact that is not on
//    file is a [Missing: …] blank (W6), and the blanks are counted from the
//    text.
//  - A failed list is an error with a retry (Rule 7). Delete and restore take
//    two taps (Rule 8). The search is a view and says what it hides (Rule 4).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import DOMPurify from "dompurify";
import { FilePlus2, FileText, Loader2, Search, Sparkles, Trash2, Wand2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { hashNavigate } from "@/lib/hashNavigate";
import { useToast } from "@/hooks/use-toast";
import { useConfirmArm } from "@/hooks/useConfirmArm";
import { WorkspaceShell, aiErrorText, leaveWorkspace } from "@/components/workspace/WorkspaceShell";
import {
  AiAccessLine, AiAccessPanel, DictateButton, LoadError, SectionTitle, TabPage, VersionHistory, WorkspaceTabs, readLastOpened, rememberLastOpened,
} from "@/components/workspace/WorkspaceApp";
import { WORD_TABS, isWordTab, setWordSeed, wordTabRoute, type WordTab } from "@/components/workspace/WordTabs";
import { DOC_TEMPLATE_GROUPS, wordTemplatesIn, type WordTemplate } from "@shared/doc-templates";
import { documentBlanks, documentPlainText } from "@shared/workspace-document";
import { REVIEW_CATEGORIES, REVIEW_LABELS, type ReviewFinding } from "@shared/workspace-intel";

interface DocRow { id: string; type: string; title: string; content: string; updatedAt?: string; createdAt?: string }
interface Proposal { title: string | null; html: string; blanks: string[]; sources: string[]; revised: boolean; forId?: string; from: string }

const when = (iso?: string) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
};
const wordCount = (html: string) => documentPlainText(html).split(/\s+/).filter(Boolean).length;
const safe = (html: string) => DOMPurify.sanitize(html);

export const WRITER_IDEAS = [
  "A cover letter for a job I am applying to",
  "A letter disputing a charge on my bill",
  "A one-page summary of my work experience",
  "A thank-you note after an interview",
];
export const REVISE_ACTIONS = [
  { label: "Improve", instruction: "Improve the writing: clearer, tighter and more professional. Keep every fact." },
  { label: "Rewrite", instruction: "Rewrite this in a fresh, polished voice. Keep every fact and the same structure." },
  { label: "Expand", instruction: "Expand this with more detail and fuller explanations where it is thin. Add no invented facts." },
  { label: "Summarize", instruction: "Summarize this document into a shorter version that keeps the essential points." },
];

/** The document the Writer, Review and History tabs are about. */
function DocPicker({ docs, value, onChange, label }: { docs: DocRow[]; value: string; onChange: (id: string) => void; label: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}
      className="ws-title h-9 w-full max-w-md rounded-full border border-border bg-background px-3 text-sm outline-none" data-testid="select-word-document">
      <option value="">Choose a document…</option>
      {docs.map((d) => <option key={d.id} value={d.id}>{d.title || "Untitled"} · {when(d.updatedAt || d.createdAt)}</option>)}
    </select>
  );
}

/** What the AI wrote, for the user to open or discard. Nothing is saved by showing it. */
function ProposalCard({ proposal, onOpen, onDiscard }: { proposal: Proposal; onOpen: () => void; onDiscard: () => void }) {
  return (
    <div className="mt-3 bubble ring-1 ring-primary/40 p-3" data-testid="word-proposal">
      <p className="text-xs font-semibold flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5 text-primary" /> {proposal.from} — nothing is saved until you open it in the editor</p>
      {proposal.title && <p className="text-sm font-semibold mt-1.5">{proposal.title}</p>}
      <p className="text-[11px] text-muted-foreground mt-0.5" data-testid="word-proposal-sources">
        {proposal.sources.length ? `Drew on ${proposal.sources.join(", ")}.` : "Drew on nothing from your records."}
        {" "}{proposal.blanks.length === 0 ? "No blanks left to fill." : `${proposal.blanks.length} ${proposal.blanks.length === 1 ? "blank" : "blanks"} to fill in: ${proposal.blanks.slice(0, 6).join("; ")}${proposal.blanks.length > 6 ? "…" : ""}.`}
      </p>
      <div className="prose prose-sm max-w-none mt-2 rounded-lg bg-muted/40 p-3 max-h-80 overflow-y-auto [&_table]:w-full [&_td]:border [&_th]:border [&_td]:p-1 [&_th]:p-1"
        dangerouslySetInnerHTML={{ __html: safe(proposal.html) }} data-testid="word-proposal-preview" />
      <div className="flex gap-2 mt-2 flex-wrap">
        <button type="button" onClick={onOpen} className="h-8 px-3 rounded-full bg-primary text-primary-foreground text-xs font-semibold" data-testid="button-word-proposal-open">
          {proposal.forId ? "Open in the editor with this change" : "Open in the editor"}
        </button>
        <button type="button" onClick={onDiscard} className="h-8 px-3 rounded-full border border-border text-xs" data-testid="button-word-proposal-discard">Discard</button>
      </div>
    </div>
  );
}

export default function WordWorkspacePage() {
  useEffect(() => { document.title = "Word — Portol"; }, []);
  const { toast } = useToast();
  const { confirm, isArmed } = useConfirmArm();
  const qc = useQueryClient();
  const query = useMemo(() => new URLSearchParams(typeof window !== "undefined" ? (window.location.hash.split("?")[1] || "") : ""), []);
  const remembered = useMemo(() => readLastOpened("word"), []);

  const artifacts = useQuery<DocRow[]>({ queryKey: ["/api/artifacts"] });
  const docs = useMemo(() => (Array.isArray(artifacts.data) ? artifacts.data : [])
    .filter((a) => a?.type === "doc")
    .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""))), [artifacts.data]);
  const listFailed = artifacts.isError && docs.length === 0;

  const askedTab = query.get("tab");
  const [tab, setTabState] = useState<WordTab>(() => (isWordTab(askedTab) && askedTab !== "editor" ? askedTab
    : isWordTab(remembered.tab) && remembered.tab !== "editor" ? remembered.tab : "documents"));
  const [docId, setDocIdState] = useState<string>(() => query.get("doc") || remembered.id || "");
  const setDocId = useCallback((id: string) => { setDocIdState(id); rememberLastOpened("word", { id: id || null }); }, []);
  const doc = docs.find((d) => d.id === docId) || null;

  const openEditor = useCallback((id?: string | null) => {
    rememberLastOpened("word", { tab: "editor", ...(id ? { id } : {}) });
    hashNavigate(wordTabRoute("editor", id));
  }, []);
  const pickTab = (next: WordTab) => {
    if (next === "editor") { openEditor(doc?.id ?? null); return; }
    setTabState(next);
    rememberLastOpened("word", { tab: next });
  };

  // The document last open comes back (owner: "automatic restoration of the
  // last opened … document"): when Word was last left in the Editor, and that
  // document still exists, Word opens on it. An explicit ?tab= is obeyed.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !artifacts.isSuccess) return;
    restored.current = true;
    if (!askedTab && remembered.tab === "editor" && remembered.id && docs.some((d) => d.id === remembered.id)) {
      hashNavigate(wordTabRoute("editor", remembered.id));
    }
  }, [artifacts.isSuccess, askedTab, remembered, docs]);

  const [search, setSearch] = useState("");
  const [accessOpen, setAccessOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [review, setReview] = useState<{ forId: string; findings: ReviewFinding[]; words: number } | null>(null);

  const q = search.trim().toLowerCase();
  const shown = q ? docs.filter((d) => `${d.title} ${documentPlainText(d.content || "")}`.toLowerCase().includes(q)) : docs;

  const remove = async (id: string) => {
    try {
      await apiRequest("DELETE", `/api/artifacts/${id}`);
      void qc.invalidateQueries({ queryKey: ["/api/artifacts"] });
      void qc.invalidateQueries({ queryKey: ["/api/documents"] });
      if (id === docId) setDocId("");
      toast({ title: "Document deleted" });
    } catch (err) {
      toast({ title: "Couldn't delete the document", description: aiErrorText(err), variant: "destructive" });
    }
  };

  /** Ask the Document AI. It returns a proposal and writes nothing. */
  const write = async (what: string, opts: { html?: string; title?: string; forId?: string; from: string; key: string }) => {
    const ask = what.trim();
    if (ask.length < 3 || busy) return;
    setBusy(opts.key);
    setProposal(null);
    try {
      const r = await apiRequest("POST", "/api/workspace/document/assist", { instruction: ask, ...(opts.html ? { html: opts.html } : {}), ...(opts.title ? { title: opts.title } : {}) });
      const j = await r.json();
      if (typeof j?.html !== "string" || !j.html.trim()) throw new Error("The AI returned nothing.");
      setProposal({
        title: typeof j.title === "string" && j.title.trim() ? j.title : opts.title || null, html: j.html,
        // Counted from the text that came back, not taken on trust.
        blanks: documentBlanks(j.html), sources: Array.isArray(j.sources) ? j.sources.map(String) : [], revised: !!j.revised, forId: opts.forId, from: opts.from,
      });
    } catch (err) {
      toast({ title: "The AI couldn't write that", description: aiErrorText(err), variant: "destructive" });
    } finally { setBusy(null); }
  };
  const openProposal = () => {
    if (!proposal) return;
    setWordSeed({ title: proposal.title || undefined, html: proposal.html, forId: proposal.forId });
    openEditor(proposal.forId ?? null);
  };
  const startFromTemplate = (t: WordTemplate) => { setWordSeed({ title: t.title, html: t.html }); openEditor(null); };

  const runReview = async () => {
    if (!doc || busy) return;
    setBusy("review");
    setReview(null);
    try {
      const r = await apiRequest("POST", "/api/workspace/document/review", { html: doc.content || "", title: doc.title });
      const j = await r.json();
      if (!Array.isArray(j?.findings)) throw new Error("The AI returned nothing usable.");
      setReview({ forId: doc.id, findings: j.findings, words: Number(j.words) || 0 });
    } catch (err) {
      toast({ title: "The AI couldn't review that", description: aiErrorText(err), variant: "destructive" });
    } finally { setBusy(null); }
  };

  const listGate = artifacts.isLoading
    ? <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading your documents…</p>
    : listFailed ? <LoadError what="your documents" onRetry={() => void artifacts.refetch()} testId="word-list-error" /> : null;
  const noDocs = <p className="text-sm text-muted-foreground" data-testid="word-no-documents">No documents yet. Start one from a template, the AI Writer or a blank page.</p>;
  const accessLine = (
    <>
      <AiAccessLine app="word" onChange={() => setAccessOpen((v) => !v)} />
      {accessOpen && <div className="mt-2"><AiAccessPanel app="word" onClose={() => setAccessOpen(false)} /></div>}
    </>
  );
  const primary = "h-9 px-3.5 rounded-full bg-primary text-primary-foreground text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50 shrink-0";

  return (
    <WorkspaceShell
      kind="document"
      title={<span className="text-sm font-semibold truncate block">Word</span>}
      status={artifacts.isLoading ? "Loading…" : listFailed ? "Couldn't load your documents" : `${docs.length} ${docs.length === 1 ? "document" : "documents"}`}
      onClose={() => leaveWorkspace()}
      tabs={<WorkspaceTabs label="Word sections" tabs={WORD_TABS.map((t) => (t.id === "documents" ? { ...t, badge: docs.length || null } : t))} active={tab} onPick={pickTab} />}
    >
      {tab === "documents" && (
        <TabPage testId="word-documents" wide>
          <div className="flex items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search every document" aria-label="Search every document"
                className="ws-title w-full h-9 rounded-full border border-border bg-background pl-9 pr-3 text-sm outline-none" data-testid="input-word-search" />
            </div>
            <button type="button" onClick={() => openEditor(null)} className={primary} data-testid="button-word-new"><FilePlus2 className="h-4 w-4" /> New</button>
          </div>
          <div className="mt-3">
            {listGate ?? (docs.length === 0 ? noDocs : shown.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="word-search-empty">No document matches “{search.trim()}”. <button type="button" className="underline" onClick={() => setSearch("")}>Show all {docs.length}</button></p>
            ) : (
              <>
                <p className="text-[11px] text-muted-foreground mb-1.5" data-testid="word-count">{shown.length} {shown.length === 1 ? "document" : "documents"}{q ? ` of ${docs.length}` : ""}</p>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {shown.map((d) => {
                    const blanks = documentBlanks(d.content || "").length;
                    return (
                      <li key={d.id} className={`rounded-xl border ${d.id === docId ? "border-primary" : "border-border/70"} bg-card flex items-stretch min-w-0`} data-testid={`word-doc-${d.id}`}>
                        <button type="button" onClick={() => { setDocId(d.id); openEditor(d.id); }} className="flex-1 min-w-0 text-left px-3 py-2.5" title="Open in the editor">
                          <span className="text-sm font-semibold truncate flex items-center gap-1.5"><FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />{d.title || "Untitled"}</span>
                          <span className="text-xs text-muted-foreground line-clamp-2 block mt-0.5">{documentPlainText(d.content || "").replace(/\s+/g, " ").slice(0, 150) || "Empty document"}</span>
                          <span className="text-[11px] text-muted-foreground block mt-1">{wordCount(d.content || "")} words · {when(d.updatedAt || d.createdAt)}{blanks ? ` · ${blanks} ${blanks === 1 ? "blank" : "blanks"} to fill` : ""}</span>
                        </button>
                        <div className="flex flex-col justify-between items-end py-1.5 pr-1.5 gap-1">
                          <div className="flex gap-1">
                            <button type="button" onClick={() => { setDocId(d.id); setReview(null); pickTab("review"); }} className="h-7 px-2 rounded-full border border-border text-[11px]" data-testid={`button-word-review-${d.id}`}>Review</button>
                            <button type="button" onClick={() => { setDocId(d.id); pickTab("history"); }} className="h-7 px-2 rounded-full border border-border text-[11px]" data-testid={`button-word-history-${d.id}`}>History</button>
                          </div>
                          <button type="button" onClick={() => confirm(`del:${d.id}`, () => void remove(d.id))}
                            aria-label={isArmed(`del:${d.id}`) ? "Tap again to delete this document" : "Delete this document"}
                            className={`h-7 rounded-full flex items-center gap-1 text-[11px] px-2 ${isArmed(`del:${d.id}`) ? "bg-destructive text-destructive-foreground" : "text-muted-foreground hover:bg-muted"}`}
                            data-testid={`button-word-delete-${d.id}`}>
                            <Trash2 className="h-3.5 w-3.5" />{isArmed(`del:${d.id}`) ? "Tap again" : ""}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            ))}
          </div>
        </TabPage>
      )}

      {tab === "templates" && (
        <TabPage testId="word-templates" wide>
          <p className="text-sm text-muted-foreground">A template is the structure of a document. Every place your own details go is a marked blank — nothing in a template is an example to mistake for yours.</p>
          <div className="mt-2">{accessLine}</div>
          {proposal && <ProposalCard proposal={proposal} onOpen={openProposal} onDiscard={() => setProposal(null)} />}
          <div className="mt-4 space-y-5">
            {DOC_TEMPLATE_GROUPS.map((g) => (
              <section key={g.id} data-testid={`template-group-${g.id}`}>
                <h2 className="text-sm font-semibold mb-2">{g.label}</h2>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {wordTemplatesIn(g.id).map((t) => (
                    <li key={t.id} className="bubble p-3" data-testid={`template-${t.id}`}>
                      <p className="text-sm font-semibold">{t.label}</p>
                      <p className="text-xs text-muted-foreground">{t.description} {documentBlanks(t.html).length} blanks to fill.</p>
                      {t.caution && <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">{t.caution}</p>}
                      <div className="flex gap-1.5 mt-2 flex-wrap">
                        <button type="button" onClick={() => startFromTemplate(t)} className="h-8 px-3 rounded-full bg-primary text-primary-foreground text-xs font-semibold" data-testid={`button-template-use-${t.id}`}>Use template</button>
                        <button type="button" disabled={!!busy}
                          onClick={() => void write(`Fill in this ${t.label} template for me from the facts on file. Keep its structure and headings. Leave a [Missing: …] blank wherever the facts on file do not say.`, { html: t.html, title: t.title, from: `${t.label}, filled in from your records`, key: `tpl:${t.id}` })}
                          className="h-8 px-3 rounded-full border border-border text-xs flex items-center gap-1 disabled:opacity-50" data-testid={`button-template-fill-${t.id}`}>
                          {busy === `tpl:${t.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} Fill in with AI
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </TabPage>
      )}

      {tab === "writer" && (
        <TabPage testId="word-writer">
          <SectionTitle icon={Wand2}>Write a new document</SectionTitle>
          <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={3} maxLength={5000}
            placeholder="Describe the document: what it is, who it is for, and anything it must say."
            aria-label="Describe the document to write"
            className="ws-title w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60 resize-y" data-testid="input-word-instruction" />
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <button type="button" disabled={!!busy || instruction.trim().length < 3} onClick={() => void write(instruction, { from: "A new document", key: "write" })} className={primary} data-testid="button-word-write">
              {busy === "write" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Write it
            </button>
            <DictateButton testId="button-word-dictate" className="h-9" onText={(t) => setInstruction((v) => (v.trim() ? `${v.replace(/\s+$/, "")} ${t}` : t))} />
          </div>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {WRITER_IDEAS.map((idea) => (
              <button key={idea} type="button" onClick={() => setInstruction(idea)} className="text-xs rounded-full border border-border px-3 py-1 text-muted-foreground hover:text-foreground hover:bg-muted/60">{idea}</button>
            ))}
          </div>
          <div className="mt-3">{accessLine}</div>
          <p className="text-[11px] text-muted-foreground mt-1">A personal fact that is not on file is never invented: it is left as a marked blank for you to fill in.</p>

          <div className="mt-6">
            <SectionTitle icon={Sparkles}>Improve a document you have</SectionTitle>
            {listGate ?? (docs.length === 0 ? noDocs : (
              <>
                <DocPicker docs={docs} value={doc?.id || ""} onChange={(id) => { setDocId(id); setProposal(null); }} label="The document to improve" />
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {REVISE_ACTIONS.map((a) => (
                    <button key={a.label} type="button" disabled={!doc || !!busy}
                      onClick={() => doc && void write(a.instruction, { html: doc.content || "", title: doc.title, forId: doc.id, from: `${a.label}: ${doc.title || "Untitled"}`, key: `rev:${a.label}` })}
                      className="h-8 px-3 rounded-full border border-border text-xs flex items-center gap-1 disabled:opacity-50" data-testid={`button-word-revise-${a.label.toLowerCase()}`}>
                      {busy === `rev:${a.label}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}{a.label}
                    </button>
                  ))}
                </div>
                {!doc && <p className="text-[11px] text-muted-foreground mt-1">Choose a document first.</p>}
              </>
            ))}
          </div>
          {busy && busy !== "review" && <p className="text-xs text-muted-foreground mt-3 flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Writing — this can take up to a minute.</p>}
          {proposal && <ProposalCard proposal={proposal} onOpen={openProposal} onDiscard={() => setProposal(null)} />}
        </TabPage>
      )}

      {tab === "review" && (
        <TabPage testId="word-review">
          <SectionTitle icon={Sparkles}>Review a document</SectionTitle>
          {listGate ?? (docs.length === 0 ? noDocs : (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <DocPicker docs={docs} value={doc?.id || ""} onChange={(id) => { setDocId(id); setReview(null); }} label="The document to review" />
                <button type="button" disabled={!doc || !!busy} onClick={() => void runReview()} className={primary} data-testid="button-word-run-review">
                  {busy === "review" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} {review && review.forId === doc?.id ? "Review again" : "Review"}
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground mt-1.5">Checks grammar, clarity, consistency, formatting and missing information in the saved copy. It reports; it changes nothing.</p>
              {busy === "review" && <p className="text-xs text-muted-foreground mt-3 flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading the document…</p>}
              {review && doc && review.forId === doc.id && (
                <div className="mt-3" data-testid="word-review-result">
                  <p className="text-sm font-medium" data-testid="word-review-summary">
                    {review.findings.length === 0 ? "Nothing to fix was found." : `${review.findings.length} ${review.findings.length === 1 ? "thing" : "things"} to look at`} · {review.words} words read
                  </p>
                  <p className="text-[11px] text-muted-foreground">An AI's review can miss things and can be wrong. Each quoted passage was checked to be in your document.</p>
                  {REVIEW_CATEGORIES.map((cat) => {
                    const items = review.findings.filter((f) => f.category === cat);
                    if (items.length === 0) return null;
                    return (
                      <section key={cat} className="mt-3" data-testid={`review-${cat}`}>
                        <h3 className="text-xs font-semibold mb-1.5">{REVIEW_LABELS[cat]} · {items.length}</h3>
                        <ul className="space-y-1.5">
                          {items.map((f, i) => (
                            <li key={i} className="bubble px-3 py-2">
                              {f.quote && <p className="text-xs italic text-muted-foreground border-l-2 border-border pl-2 mb-1">“{f.quote}”</p>}
                              <p className="text-sm">{f.issue}</p>
                              {f.suggestion && <p className="text-sm text-muted-foreground mt-0.5">Suggestion: {f.suggestion}</p>}
                            </li>
                          ))}
                        </ul>
                      </section>
                    );
                  })}
                  <button type="button" onClick={() => openEditor(doc.id)} className="mt-3 h-8 px-3 rounded-full border border-border text-xs" data-testid="button-review-open-editor">Open in the editor to fix</button>
                </div>
              )}
            </>
          ))}
        </TabPage>
      )}

      {tab === "history" && (
        <TabPage testId="word-history">
          <SectionTitle>Version history</SectionTitle>
          {listGate ?? (docs.length === 0 ? noDocs : (
            <>
              <DocPicker docs={docs} value={doc?.id || ""} onChange={setDocId} label="The document whose versions to show" />
              {!doc ? <p className="text-sm text-muted-foreground mt-3">Choose a document to see its earlier versions.</p> : (
                <div className="mt-3">
                  <VersionHistory key={doc.id} kind="document" id={doc.id}
                    onRestored={() => { void qc.invalidateQueries({ queryKey: ["/api/artifacts"] }); void qc.invalidateQueries({ queryKey: ["/api/documents"] }); }}
                    renderPreview={(v) => <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: safe(v.content) }} />} />
                </div>
              )}
            </>
          ))}
        </TabPage>
      )}
    </WorkspaceShell>
  );
}
