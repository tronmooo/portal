// Customize Executive — the dialog behind the ⋮ menu's "Customize".
//
// Owner's design, 2026-11-22: one dialog, opened from the top-right menu (not
// a button at the foot of the tab), with four tabs — Cards & Widgets, My
// Custom, AI Builder, Layout — a Quiet Mode switch, a row per card (drag to
// reorder, a size, a switch), Widget Ideas, the hidden cards, and Save / Cancel.
//
// Everything edits a DRAFT. Opening the dialog writes nothing (Rule 3); Save
// Changes writes the whole draft as one preference row (`exec_card_prefs`,
// shared/exec-card-prefs), on the account, and Cancel drops it.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell, BookOpen, CalendarDays, Car, ChartColumn, CheckSquare, ChevronDown, ChevronRight, Coins, Dumbbell,
  EyeOff, FileText, Flame, GripVertical, Heart, HeartPulse, History, Home, LayoutGrid, Layers, Moon, PawPrint,
  LayoutDashboard, Plus, RotateCcw, Settings, Sparkles, Star, StickyNote, Target, Trash2, Users, Wallet, Zap, type LucideIcon,
} from "lucide-react";
import { apiRequest, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { BubbleModal } from "@/components/ui/bubble-modal";
import { useToast } from "@/hooks/use-toast";
import { ExecWidgetBody } from "@/components/dashboard/ExecWidgetBody";
import { getUserToday } from "@shared/timezone";
import {
  EXEC_CARD_HINTS, QUIET_MODE_CARDS, EXEC_CARD_TITLES,
  addExecWidget, execCardSize, execCardTitle, isExecCardVisible, isWidgetCardId, orderedExecCards,
  placeExecCard, removeExecWidget, resetExecCardLayout, setExecCardSize, setExecCardVisible,
  widgetCardId,
  type BuiltInCardId, type ExecCardId, type ExecCardPrefs, type ExecCardSize,
} from "@shared/exec-card-prefs";
import {
  WIDGET_ICONS, WIDGET_PROFILE_TYPES, WIDGET_SOURCES, WIDGET_SOURCE_LABELS, WIDGET_TEMPLATES,
  describeWidget, newWidgetId, sanitizeWidget,
  type ExecWidget, type WidgetIcon, type WidgetSource,
} from "@shared/exec-widgets";
import {
  DASHBOARD_TEMPLATES, MAX_DASHBOARDS, activeDashboard, activeExecPrefs, addDashboard, defaultExecDashboards,
  parseExecDashboards, removeDashboard, renameDashboard, serializeExecDashboards, setActiveDashboard, withActiveExecPrefs,
  type ExecDashboards,
} from "@shared/exec-dashboards";

export const EXEC_CARD_PREFS_KEY = "exec_card_prefs";
const QUERY_KEY = ["/api/preferences/exec_card_prefs"];
const PURPLE = "265 85% 66%";

export function useExecCardPrefs(enabled = true) {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery<ExecDashboards>({
    queryKey: QUERY_KEY,
    enabled,
    queryFn: () => apiRequest("GET", `/api/preferences/${EXEC_CARD_PREFS_KEY}`)
      .then(r => r.json())
      .then(d => parseExecDashboards(d?.value)),
    staleTime: 5 * 60_000,
  });
  const save = useMutation({
    mutationFn: async (next: ExecDashboards) => {
      await apiRequest("PUT", `/api/preferences/${EXEC_CARD_PREFS_KEY}`, { value: serializeExecDashboards(next) });
      return next;
    },
    onError: () => { queryClient.invalidateQueries({ queryKey: QUERY_KEY }); },
  });
  const boards = useMemo(() => data ?? defaultExecDashboards(), [data]);
  return {
    /** False only while the stored choice is still on its way, so the caller
     *  does not flash the default layout over a saved one. A failed read
     *  settles too (the defaults apply) — the dashboard never waits forever. */
    loaded: !enabled || !isPending,
    /** Every dashboard the user has, and which one is showing. */
    boards,
    /** The dashboard that is showing, as the layout the tab draws. */
    prefs: useMemo(() => activeExecPrefs(boards), [boards]),
    saving: save.isPending,
    /** The screen follows at once; the save follows behind it and resolves
     *  when the account has it. */
    setBoards: (next: ExecDashboards) => {
      queryClient.setQueryData(QUERY_KEY, next);
      return save.mutateAsync(next);
    },
  };
}

// ── Looks ────────────────────────────────────────────────────────────────────

const CARD_ICON: Record<BuiltInCardId, { icon: LucideIcon; hsl: string }> = {
  attention: { icon: Bell, hsl: "340 85% 62%" },
  schedule: { icon: CalendarDays, hsl: "212 95% 62%" },
  money: { icon: Coins, hsl: "40 95% 55%" },
  tasks: { icon: CheckSquare, hsl: "280 85% 68%" },
  habits: { icon: HeartPulse, hsl: "172 80% 48%" },
  documents: { icon: FileText, hsl: "285 80% 68%" },
  wellness: { icon: Heart, hsl: "350 80% 62%" },
  activity: { icon: History, hsl: "160 60% 48%" },
};
export const WIDGET_ICON: Record<WidgetIcon, LucideIcon> = {
  car: Car, dumbbell: Dumbbell, paw: PawPrint, home: Home, chart: ChartColumn, book: BookOpen, note: StickyNote,
  check: CheckSquare, target: Target, flame: Flame, star: Star, heart: Heart, wallet: Wallet, users: Users,
};
const iconFor = (prefs: ExecCardPrefs, id: ExecCardId): { icon: LucideIcon; hsl: string } => {
  if (isWidgetCardId(id)) {
    const w = prefs.widgets.find((x) => widgetCardId(x.id) === id);
    return { icon: w ? WIDGET_ICON[w.icon] : Star, hsl: PURPLE };
  }
  return CARD_ICON[id];
};
const hintFor = (prefs: ExecCardPrefs, id: ExecCardId): string => {
  if (isWidgetCardId(id)) {
    const w = prefs.widgets.find((x) => widgetCardId(x.id) === id);
    return w ? describeWidget(w) : "";
  }
  return EXEC_CARD_HINTS[id];
};

function Switch({ on, onChange, label, testId }: { on: boolean; onChange: (v: boolean) => void; label: string; testId: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} data-testid={testId}
      className={`touch-hit relative shrink-0 h-6 w-11 rounded-full transition-colors ${on ? "bg-cyan-400" : "bg-muted-foreground/30"}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? "left-[22px]" : "left-0.5"}`} />
    </button>
  );
}

const TABS = [
  { key: "cards", label: "Cards & Widgets", icon: LayoutGrid },
  { key: "custom", label: "My Custom", icon: Layers },
  { key: "ai", label: "AI Builder", icon: Sparkles },
  { key: "layout", label: "Layout", icon: LayoutGrid },
] as const;
type TabKey = (typeof TABS)[number]["key"];

// ── The dialog ───────────────────────────────────────────────────────────────

export function ExecCustomizeDialog({ open, onClose, mode = "everyone", ids = [] }: {
  open: boolean; onClose: () => void;
  /** The active profile scope, so a widget preview reads what its card will. */
  mode?: string; ids?: string[];
}) {
  const { boards, setBoards, saving } = useExecCardPrefs(open);
  const { toast } = useToast();
  // The draft holds EVERY dashboard; `draft` below is the one being edited.
  const [draftBoards, setDraftBoards] = useState<ExecDashboards>(boards);
  const draft = useMemo(() => activeExecPrefs(draftBoards), [draftBoards]);
  const [tab, setTab] = useState<TabKey>("cards");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [armedRemove, setArmedRemove] = useState<string | null>(null);
  const [newBoardOpen, setNewBoardOpen] = useState(false);
  const [editingWidget, setEditingWidget] = useState<string | null>(null);
  // Which cards were on the dashboard when it was opened here: they are the
  // main list. A card switched off stays in the list (it is still a draft),
  // and a card that was hidden sits under "Hidden Cards" until switched on.
  const [listed, setListed] = useState<Set<string>>(new Set());
  const relist = (b: ExecDashboards) => {
    const p = activeExecPrefs(b);
    setListed(new Set(orderedExecCards(p).filter((id) => isExecCardVisible(p, id))));
  };
  const touched = useRef(false);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      touched.current = false;
      setDraftBoards(boards); relist(boards);
      setTab("cards"); setExpanded(null); setHiddenOpen(false); setArmedRemove(null); setNewBoardOpen(false); setEditingWidget(null);
    }
    wasOpen.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // The stored choice can land after the dialog is already open (first open of
  // a session): adopt it if the user has not touched anything yet.
  useEffect(() => {
    if (open && !touched.current) { setDraftBoards(boards); relist(boards); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boards]);
  const editBoards = (next: ExecDashboards) => { touched.current = true; setDraftBoards(next); };
  /** Change the dashboard being edited. */
  const edit = (next: ExecCardPrefs) => editBoards(withActiveExecPrefs(draftBoards, next));
  /** Switch which dashboard is being edited (and shown once saved). */
  const switchBoard = (next: ExecDashboards) => { editBoards(next); relist(next); setExpanded(null); setEditingWidget(null); };
  const board = activeDashboard(draftBoards);

  const order = orderedExecCards(draft);
  const mainIds = order.filter((id) => listed.has(id));
  const hiddenIds = order.filter((id) => !listed.has(id));
  const dirty = serializeExecDashboards(draftBoards) !== serializeExecDashboards(boards);
  const todayISO = getUserToday(BROWSER_TIMEZONE);

  // ── Reorder: drag the handle (pointer or touch), or arrow keys on it ───────
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const [dragId, setDragId] = useState<string | null>(null);
  const moveWithin = (list: ExecCardId[], id: ExecCardId, dir: -1 | 1) => {
    const neighbour = list[list.indexOf(id) + dir];
    if (!neighbour) return;
    edit(placeExecCard(draft, id, orderedExecCards(draft).indexOf(neighbour)));
  };
  const dragOver = (list: ExecCardId[], id: ExecCardId, clientY: number) => {
    const full = orderedExecCards(draft);
    const me = full.indexOf(id);
    for (const other of list) {
      if (other === id) continue;
      const r = rowRefs.current.get(other)?.getBoundingClientRect();
      if (!r) continue;
      const mid = r.top + r.height / 2;
      const at = full.indexOf(other);
      if ((me < at && clientY > mid) || (me > at && clientY < mid)) { edit(placeExecCard(draft, id, at)); return; }
    }
  };
  const handle = (list: ExecCardId[], id: ExecCardId, title: string) => (
    <button type="button"
      aria-label={`Reorder ${title}. Drag, or use the arrow keys.`}
      data-testid={`exec-customize-drag-${id}`}
      className={`touch-hit shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing ${dragId === id ? "text-foreground" : ""}`}
      style={{ touchAction: "none" }}
      onPointerDown={(e) => { e.preventDefault(); try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* jsdom */ } setDragId(id); }}
      onPointerMove={(e) => { if (dragId === id) dragOver(list, id, e.clientY); }}
      onPointerUp={() => setDragId(null)}
      onPointerCancel={() => setDragId(null)}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp") { e.preventDefault(); moveWithin(list, id, -1); }
        if (e.key === "ArrowDown") { e.preventDefault(); moveWithin(list, id, 1); }
      }}>
      <GripVertical className="h-4 w-4" aria-hidden="true" />
    </button>
  );
  const sizeSelect = (id: ExecCardId, title: string) => (
    <select
      value={execCardSize(draft, id)}
      onChange={(e) => edit(setExecCardSize(draft, id, e.target.value as ExecCardSize))}
      aria-label={`Size of ${title}`}
      data-testid={`exec-customize-size-${id}`}
      className="shrink-0 h-8 w-[104px] rounded-lg border border-border bg-background/60 px-1.5 text-[12px] font-medium">
      <option value="large">Large</option>
      <option value="medium">Medium</option>
    </select>
  );

  const removeWidget = (w: ExecWidget) => {
    if (armedRemove !== w.id) {
      setArmedRemove(w.id);
      setTimeout(() => setArmedRemove((k) => (k === w.id ? null : k)), 4000);
      return;
    }
    setArmedRemove(null);
    edit(removeExecWidget(draft, w.id));
  };
  const addWidget = (base: Omit<ExecWidget, "id">) => {
    const id = newWidgetId(draft.widgets, base.title);
    const widget = sanitizeWidget({ ...base, id }, id);
    if (!widget) return;
    edit(addExecWidget(draft, widget));
    setListed((prev) => new Set(prev).add(widgetCardId(id)));
    toast({ title: `${widget.title} added`, description: "Press Save Changes to put it on your Executive tab." });
  };

  const cardRow = (list: ExecCardId[], id: ExecCardId) => {
    const title = execCardTitle(draft, id);
    const { icon: Icon, hsl } = iconFor(draft, id);
    const on = isExecCardVisible(draft, id);
    const isOpen = expanded === id;
    const widget = isWidgetCardId(id) ? draft.widgets.find((w) => widgetCardId(w.id) === id) : undefined;
    return (
      <li key={id}
        ref={(el) => { if (el) rowRefs.current.set(id, el); else rowRefs.current.delete(id); }}
        className={`rounded-xl border border-border/70 bg-background/40 ${dragId === id ? "ring-1 ring-primary/60" : ""}`}
        data-testid={`exec-customize-row-${id}`}>
        <div className="flex items-center gap-2 px-2 py-2 min-w-0">
          {handle(list, id, title)}
          <Icon className="h-5 w-5 sm:h-6 sm:w-6 shrink-0" style={{ color: `hsl(${hsl})` }} aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <p className={`text-[14px] font-bold leading-tight truncate ${on ? "" : "text-muted-foreground"}`}>{title}</p>
            <p className="text-[11px] text-muted-foreground leading-tight line-clamp-2 mt-0.5">{hintFor(draft, id)}</p>
          </div>
          {sizeSelect(id, title)}
          <Switch on={on} onChange={(v) => edit(setExecCardVisible(draft, id, v))} label={`Show ${title}`} testId={`exec-customize-show-${id}`} />
          <button type="button" onClick={() => setExpanded(isOpen ? null : id)} aria-expanded={isOpen} aria-label={`Details of ${title}`}
            className="touch-hit shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground" data-testid={`exec-customize-more-${id}`}>
            <ChevronRight className={`h-4 w-4 transition-transform ${isOpen ? "rotate-90" : ""}`} aria-hidden="true" />
          </button>
        </div>
        {isOpen && (
          <div className="px-3 pb-3 pt-1 border-t border-border/50 space-y-2" data-testid={`exec-customize-details-${id}`}>
            <p className="text-[12px] text-muted-foreground">{hintFor(draft, id)}</p>
            <p className="text-[11px] text-muted-foreground">
              {execCardSize(draft, id) === "large" ? "Large: takes the full row." : "Medium: shares a row with another card."}
              {!isWidgetCardId(id) && QUIET_MODE_CARDS.includes(id) ? " One of the four Quiet Mode essentials." : ""}
            </p>
            {widget && (
              <>
                <WidgetEditor value={widget}
                  onChange={(next) => edit({ ...draft, widgets: draft.widgets.map((x) => (x.id === widget.id ? next : x)) })} />
                <p className="micro-label text-muted-foreground">Preview, from your records</p>
                <div className="rounded-lg border border-border/60 p-2">
                  <ExecWidgetBody widget={widget} mode={mode} ids={ids} todayISO={todayISO} accent={PURPLE} preview />
                </div>
                <button type="button" onClick={() => removeWidget(widget)}
                  className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] font-semibold ${armedRemove === widget.id ? "border-red-500/50 bg-red-500/15 text-red-500" : "border-border text-muted-foreground hover:bg-muted"}`}
                  data-testid={`exec-customize-remove-${widget.id}`}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  {armedRemove === widget.id ? "Tap again to remove" : "Remove this card"}
                </button>
              </>
            )}
          </div>
        )}
      </li>
    );
  };

  const save = async () => {
    try {
      await setBoards(draftBoards);
      toast({ title: "Executive tab updated" });
      onClose();
    } catch {
      toast({ title: "Couldn't save your changes", description: "Nothing was changed. Try again.", variant: "destructive" });
    }
  };

  const section = (title: string, sub: string, children: ReactNode) => (
    <div>
      <p className="text-[15px] font-bold leading-tight">{title}</p>
      <p className="text-[12px] text-muted-foreground mb-2">{sub}</p>
      {children}
    </div>
  );

  return (
    <BubbleModal open={open} onClose={onClose} testId="exec-customize" width="lg" tall
      title="Customize Executive" subtitle="Choose what appears on your Executive tab and build your own."
      icon={Settings} accent={PURPLE}
      footer={
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => edit(resetExecCardLayout(draft))}
            title="Back to the built-in layout and Quiet Mode. Cards you built are kept."
            className="inline-flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-[13px] font-semibold text-muted-foreground hover:bg-muted"
            data-testid="exec-customize-reset">
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Reset to Default
          </button>
          <span className="flex-1" />
          <button type="button" onClick={onClose}
            className="rounded-xl border border-border px-3.5 py-2 text-[13px] font-semibold hover:bg-muted" data-testid="exec-customize-cancel">
            Cancel
          </button>
          <button type="button" onClick={save} disabled={!dirty || saving}
            className="rounded-xl px-3.5 py-2 text-[13px] font-bold text-white disabled:opacity-50"
            style={{ background: `hsl(${PURPLE})` }} data-testid="exec-customize-save">
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      }>
      {/* Dashboards: each is its own layout over the same cards. */}
      <div className="rounded-xl border border-border/70 px-3 py-2.5 space-y-2" data-testid="exec-customize-boards">
        <div className="flex items-center gap-2">
          <LayoutDashboard className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <p className="text-[14px] font-bold leading-tight">Dashboards</p>
            <p className="text-[12px] text-muted-foreground leading-tight">Each dashboard has its own cards, order and sizes. You are editing the highlighted one.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {draftBoards.dashboards.map((d) => (
            <button key={d.id} type="button" aria-pressed={d.id === board.id}
              onClick={() => switchBoard(setActiveDashboard(draftBoards, d.id))}
              data-testid={`exec-customize-board-${d.id}`}
              className={`rounded-full px-3 py-1.5 text-[12px] font-semibold ${d.id === board.id ? "text-white" : "border border-border text-muted-foreground hover:bg-muted"}`}
              style={d.id === board.id ? { background: `hsl(${PURPLE} / 0.35)`, boxShadow: `inset 0 0 0 1px hsl(${PURPLE} / 0.7)` } : undefined}>
              {d.name}
            </button>
          ))}
          {draftBoards.dashboards.length < MAX_DASHBOARDS && (
            <button type="button" onClick={() => setNewBoardOpen((o) => !o)} aria-expanded={newBoardOpen}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-3 py-1.5 text-[12px] font-semibold text-muted-foreground hover:bg-muted"
              data-testid="exec-customize-board-new">
              <Plus className="h-3.5 w-3.5" aria-hidden="true" /> New dashboard
            </button>
          )}
        </div>
        {newBoardOpen ? (
          <NewDashboard
            onCreate={(name, key) => { switchBoard(addDashboard(draftBoards, name, key)); setNewBoardOpen(false); setTab("cards"); }}
            onCancel={() => setNewBoardOpen(false)} />
        ) : (
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-muted-foreground shrink-0" htmlFor="exec-board-name">Name</label>
            <input id="exec-board-name" key={board.id} defaultValue={board.name} maxLength={24}
              onChange={(e) => { if (e.target.value.trim()) editBoards(renameDashboard(draftBoards, board.id, e.target.value)); }}
              className="flex-1 min-w-0 h-8 rounded-lg border border-border bg-background/60 px-2 text-[13px] font-semibold"
              data-testid="exec-customize-board-name" />
            {draftBoards.dashboards.length > 1 && (
              <button type="button"
                onClick={() => {
                  const k = `board:${board.id}`;
                  if (armedRemove !== k) { setArmedRemove(k); setTimeout(() => setArmedRemove((x) => (x === k ? null : x)), 4000); return; }
                  setArmedRemove(null);
                  switchBoard(removeDashboard(draftBoards, board.id));
                }}
                className={`shrink-0 inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] font-semibold ${armedRemove === `board:${board.id}` ? "border-red-500/50 bg-red-500/15 text-red-500" : "border-border text-muted-foreground hover:bg-muted"}`}
                title="Deletes this dashboard's layout. The cards themselves are kept."
                data-testid="exec-customize-board-delete">
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                {armedRemove === `board:${board.id}` ? "Tap again to delete" : "Delete"}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div role="tablist" className="grid grid-cols-4 gap-1 rounded-xl border border-border/70 p-1" data-testid="exec-customize-tabs">
        {TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
            data-testid={`exec-customize-tab-${t.key}`}
            // A phone has room for the words or the icons, not both: the label
            // wraps to two lines there and the icon joins it from 640px.
            className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-1 py-2 text-[12px] leading-tight font-semibold text-center transition-colors min-w-0 ${tab === t.key ? "text-white" : "text-muted-foreground hover:text-foreground"}`}
            style={tab === t.key ? { background: `hsl(${PURPLE} / 0.35)`, boxShadow: `inset 0 0 0 1px hsl(${PURPLE} / 0.7)` } : undefined}>
            <t.icon className="hidden sm:block h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {tab === "cards" && (
        <div className="space-y-4 pb-3" data-testid="exec-customize-panel-cards">
          <div className="flex items-center gap-3 rounded-xl border border-border/70 px-3 py-2.5">
            <Moon className="h-6 w-6 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <p className="text-[14px] font-bold leading-tight">Quiet Mode</p>
              <p className="text-[12px] text-muted-foreground leading-tight mt-0.5">
                Show only your essentials ({QUIET_MODE_CARDS.map((id) => EXEC_CARD_TITLES[id]).join(", ")}).
              </p>
            </div>
            <Switch on={draft.quiet} onChange={(v) => edit({ ...draft, quiet: v })} label="Quiet Mode" testId="exec-customize-quiet" />
          </div>

          {section("Executive Cards", "Show, hide, and reorder the cards on your Executive dashboard.",
            <ul className="space-y-1.5" data-testid="exec-customize-list">{mainIds.map((id) => cardRow(mainIds, id))}</ul>)}

          <button type="button" onClick={() => setTab("ai")}
            className="w-full flex items-center gap-3 rounded-xl px-3 py-3 text-left"
            style={{ background: `hsl(${PURPLE} / 0.12)`, boxShadow: `inset 0 0 0 1px hsl(${PURPLE} / 0.6)` }}
            data-testid="exec-customize-create">
            <span className="h-10 w-10 shrink-0 rounded-lg inline-flex items-center justify-center" style={{ boxShadow: `inset 0 0 0 1.5px hsl(${PURPLE})`, color: `hsl(${PURPLE})` }}>
              <Plus className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="flex-1 min-w-0">
              <span className="flex items-center gap-2">
                <span className="text-[14px] font-bold">Create Your Own Widget</span>
                <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ boxShadow: `inset 0 0 0 1px hsl(${PURPLE} / 0.7)`, color: `hsl(${PURPLE})` }}>
                  <Sparkles className="h-3 w-3" aria-hidden="true" /> AI Powered
                </span>
              </span>
              <span className="block text-[12px] text-muted-foreground mt-0.5">Build a custom card to track, view, or analyze anything you want.</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>

          <WidgetIdeas onAdd={addWidget} taken={draft.widgets} />

          <div className="rounded-xl border border-border/70" data-testid="exec-customize-hidden">
            <button type="button" onClick={() => setHiddenOpen((o) => !o)} aria-expanded={hiddenOpen}
              className="w-full flex items-center gap-3 px-3 py-2.5 text-left" data-testid="exec-customize-hidden-toggle">
              <EyeOff className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="flex-1 min-w-0">
                <span className="block text-[14px] font-bold leading-tight">Hidden Cards ({hiddenIds.length})</span>
                <span className="block text-[12px] text-muted-foreground leading-tight mt-0.5">Cards not shown on your Executive tab.</span>
              </span>
              <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${hiddenOpen ? "rotate-180" : ""}`} aria-hidden="true" />
            </button>
            {hiddenOpen && (
              hiddenIds.length === 0
                ? <p className="px-3 pb-3 text-[12px] text-muted-foreground">Every card is on your tab.</p>
                : <ul className="px-2 pb-2 space-y-1.5">{hiddenIds.map((id) => cardRow(hiddenIds, id))}</ul>
            )}
          </div>
        </div>
      )}

      {tab === "custom" && (
        <div className="space-y-3 pb-3" data-testid="exec-customize-panel-custom">
          {section("My Custom Cards", "Cards you built. They read your records live — nothing is copied.",
            draft.widgets.length === 0 ? (
              <p className="rounded-xl border border-border/70 px-3 py-4 text-[12px] text-muted-foreground" data-testid="exec-customize-custom-empty">
                You haven't built a card yet. Pick a Widget Idea below, or describe one in the AI Builder.
              </p>
            ) : (
              <ul className="space-y-1.5">{draft.widgets.map((w) => cardRow(draft.widgets.map((x) => widgetCardId(x.id)), widgetCardId(w.id)))}</ul>
            ))}
          <WidgetIdeas onAdd={addWidget} taken={draft.widgets} />
        </div>
      )}

      {tab === "ai" && (
        <AiBuilder mode={mode} ids={ids} todayISO={todayISO} existing={draft.widgets}
          onAdd={(w) => { addWidget(w); setTab("cards"); }} />
      )}

      {tab === "layout" && (
        <div className="space-y-3 pb-3" data-testid="exec-customize-panel-layout">
          {section("Layout", "The order and size of the cards that are showing. Drag a handle, or use the arrow keys on it.",
            <>
              <ul className="space-y-1.5">
                {order.filter((id) => isExecCardVisible(draft, id)).map((id, _i, list) => {
                  const title = execCardTitle(draft, id);
                  const { icon: Icon, hsl } = iconFor(draft, id);
                  return (
                    <li key={id} ref={(el) => { if (el) rowRefs.current.set(id, el); else rowRefs.current.delete(id); }}
                      className={`flex items-center gap-2 rounded-xl border border-border/70 px-2 py-2 ${dragId === id ? "ring-1 ring-primary/60" : ""}`}
                      data-testid={`exec-customize-layout-row-${id}`}>
                      {handle(list, id, title)}
                      <Icon className="h-5 w-5 shrink-0" style={{ color: `hsl(${hsl})` }} aria-hidden="true" />
                      <span className="flex-1 min-w-0 text-[13px] font-semibold truncate">{title}</span>
                      {sizeSelect(id, title)}
                    </li>
                  );
                })}
              </ul>
              <p className="micro-label text-muted-foreground mt-3 mb-1">How it lays out on a phone</p>
              <div className="grid grid-cols-2 gap-1" data-testid="exec-customize-preview" aria-hidden="true">
                {order.filter((id) => isExecCardVisible(draft, id)).map((id) => (
                  <div key={id} className={`rounded-md border border-border/60 px-2 py-2 text-[11px] font-semibold truncate ${execCardSize(draft, id) === "large" ? "col-span-2" : ""}`}
                    style={{ background: `hsl(${iconFor(draft, id).hsl} / 0.12)` }}>
                    {execCardTitle(draft, id)}
                  </div>
                ))}
              </div>
            </>)}
        </div>
      )}
    </BubbleModal>
  );
}

function WidgetIdeas({ onAdd, taken }: { onAdd: (w: Omit<ExecWidget, "id">) => void; taken: ExecWidget[] }) {
  return (
    <div className="rounded-xl border border-border/70 px-3 py-2.5" data-testid="exec-customize-ideas">
      <div className="flex items-center gap-2 mb-2">
        <Zap className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div>
          <p className="text-[14px] font-bold leading-tight">Widget Ideas</p>
          <p className="text-[12px] text-muted-foreground leading-tight">Tap to create a custom card instantly.</p>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
        {WIDGET_TEMPLATES.map((t) => {
          const Icon = WIDGET_ICON[t.widget.icon];
          const have = taken.some((w) => w.title === t.widget.title);
          return (
            <button key={t.key} type="button" disabled={have} onClick={() => onAdd(t.widget)}
              title={have ? "Already one of your cards" : describeWidget({ ...t.widget, id: t.key })}
              className="flex items-center gap-2 rounded-lg border border-border/70 px-2 py-2 text-left hover:bg-muted disabled:opacity-50"
              data-testid={`exec-customize-idea-${t.key}`}>
              <Icon className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="text-[12px] font-semibold leading-tight">{t.label[0]}<br />{t.label[1]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Start a dashboard: a name and a starting point. */
function NewDashboard({ onCreate, onCancel }: { onCreate: (name: string, templateKey: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("standard");
  const t = DASHBOARD_TEMPLATES.find((x) => x.key === key)!;
  return (
    <div className="rounded-lg border border-border/60 p-2.5 space-y-2" data-testid="exec-customize-board-form">
      <input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} placeholder={`Name (e.g. ${t.name})`} aria-label="Dashboard name"
        className="w-full h-8 rounded-lg border border-border bg-background/60 px-2 text-[13px] font-semibold"
        data-testid="exec-customize-board-form-name" />
      <p className="micro-label text-muted-foreground">Start from</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
        {DASHBOARD_TEMPLATES.map((x) => (
          <button key={x.key} type="button" aria-pressed={x.key === key} onClick={() => setKey(x.key)}
            data-testid={`exec-customize-board-template-${x.key}`}
            className={`rounded-lg border px-2 py-1.5 text-left ${x.key === key ? "border-primary/60 bg-primary/10" : "border-border/70 hover:bg-muted"}`}>
            <span className="block text-[12px] font-semibold leading-tight">{x.name}</span>
            <span className="block text-[11px] text-muted-foreground leading-tight mt-0.5">{x.hint}</span>
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => onCreate(name, key)}
          className="rounded-xl px-3 py-1.5 text-[12px] font-bold text-white" style={{ background: `hsl(${PURPLE})` }}
          data-testid="exec-customize-board-form-create">Create dashboard</button>
        <button type="button" onClick={onCancel} className="rounded-xl border border-border px-3 py-1.5 text-[12px] font-semibold hover:bg-muted">Cancel</button>
      </div>
    </div>
  );
}

const DAY_CHOICES: Array<{ label: string; days: number | null }> = [
  { label: "Default", days: null }, { label: "7 days", days: 7 }, { label: "30 days", days: 30 }, { label: "90 days", days: 90 }, { label: "1 year", days: 365 },
];
const SOURCES_WITH_DAYS: WidgetSource[] = ["expenses", "bills", "events", "journal", "notes"];

/**
 * Every part of a custom card, editable: what it reads, which kinds, a text
 * filter, how far back or ahead, how many rows, its icon and title. Each
 * change is held to `sanitizeWidget`, so the card stays one the app can draw.
 */
function WidgetEditor({ value, onChange, hideTitle = false }: { value: ExecWidget; onChange: (w: ExecWidget) => void; hideTitle?: boolean }) {
  const set = (patch: Record<string, unknown>) => {
    const next = sanitizeWidget({ ...value, ...patch }, value.id);
    if (next) onChange(next);
  };
  const t = value.id;
  return (
    <div className="rounded-lg border border-border/60 p-2.5 space-y-2" data-testid={`widget-editor-${t}`}>
      {!hideTitle && (
        <label className="block">
          <span className="micro-label text-muted-foreground">Title</span>
          {/* Uncontrolled: a half-typed title (one letter) is not a title yet. */}
          <input key={`${t}:title`} defaultValue={value.title} maxLength={40}
            onChange={(e) => { if (e.target.value.trim().length >= 2) set({ title: e.target.value }); }}
            className="mt-0.5 w-full h-8 rounded-lg border border-border bg-background/60 px-2 text-[13px] font-semibold"
            data-testid={`widget-editor-title-${t}`} />
        </label>
      )}
      <label className="block">
        <span className="micro-label text-muted-foreground">Shows</span>
        <select value={value.source} onChange={(e) => set({ source: e.target.value, types: [], days: undefined })}
          className="mt-0.5 w-full h-8 rounded-lg border border-border bg-background/60 px-2 text-[12px]"
          data-testid={`widget-editor-source-${t}`}>
          {WIDGET_SOURCES.map((src) => <option key={src} value={src}>{WIDGET_SOURCE_LABELS[src]}</option>)}
        </select>
      </label>
      {value.source === "profiles" && (
        <div>
          <span className="micro-label text-muted-foreground">Which kinds (none selected = all)</span>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {WIDGET_PROFILE_TYPES.map((k) => {
              const on = (value.types ?? []).includes(k);
              return (
                <button key={k} type="button" aria-pressed={on}
                  onClick={() => set({ types: on ? (value.types ?? []).filter((x) => x !== k) : [...(value.types ?? []), k] })}
                  data-testid={`widget-editor-type-${t}-${k}`}
                  className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${on ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted"}`}>
                  {k}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <label className="block">
        <span className="micro-label text-muted-foreground">Only items containing (optional)</span>
        <input key={`${t}:match:${value.source}`} defaultValue={value.match ?? ""} maxLength={40} placeholder="a word, a category, a name"
          onChange={(e) => set({ match: e.target.value })}
          className="mt-0.5 w-full h-8 rounded-lg border border-border bg-background/60 px-2 text-[12px]"
          data-testid={`widget-editor-match-${t}`} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        {SOURCES_WITH_DAYS.includes(value.source) && (
          <label className="block">
            <span className="micro-label text-muted-foreground">Time span</span>
            <select value={value.days ?? ""} onChange={(e) => set({ days: e.target.value ? Number(e.target.value) : undefined })}
              className="mt-0.5 w-full h-8 rounded-lg border border-border bg-background/60 px-2 text-[12px]"
              data-testid={`widget-editor-days-${t}`}>
              {DAY_CHOICES.map((c) => <option key={c.label} value={c.days ?? ""}>{c.label}</option>)}
            </select>
          </label>
        )}
        <label className="block">
          <span className="micro-label text-muted-foreground">Rows</span>
          <select value={value.limit} onChange={(e) => set({ limit: Number(e.target.value) })}
            className="mt-0.5 w-full h-8 rounded-lg border border-border bg-background/60 px-2 text-[12px]"
            data-testid={`widget-editor-limit-${t}`}>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
      <div>
        <span className="micro-label text-muted-foreground">Icon</span>
        <div className="mt-0.5 flex flex-wrap gap-1">
          {WIDGET_ICONS.map((k) => {
            const Icon = WIDGET_ICON[k];
            return (
              <button key={k} type="button" aria-pressed={value.icon === k} aria-label={`Icon: ${k}`} onClick={() => set({ icon: k })}
                data-testid={`widget-editor-icon-${t}-${k}`}
                className={`rounded-lg border p-1.5 ${value.icon === k ? "border-primary/60 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted"}`}>
                <Icon className="h-4 w-4" aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const AI_EXAMPLES = ["My dog's vet visits and care tasks", "How much I spend on groceries", "Journal entries about work", "My sleep and weight", "Goals I'm working on"];

function AiBuilder({ onAdd, mode, ids, todayISO, existing }: {
  onAdd: (w: Omit<ExecWidget, "id">) => void; mode: string; ids: string[]; todayISO: string; existing: ExecWidget[];
}) {
  const [text, setText] = useState("");
  const [proposal, setProposal] = useState<{ widget: ExecWidget; by: "ai" | "rules" | "manual" } | null>(null);
  const build = useMutation({
    // A read: the server answers with a widget description and stores nothing.
    mutationFn: async (prompt: string) => {
      const d = await apiRequest("GET", `/api/exec-widgets/suggest?prompt=${encodeURIComponent(prompt)}`).then((r) => r.json());
      const widget = sanitizeWidget(d?.widget, "preview");
      if (!widget) throw new Error("Unexpected response");
      return { widget, by: d?.by === "ai" ? "ai" as const : "rules" as const };
    },
    onSuccess: (p) => setProposal(p),
  });
  const ask = (prompt: string) => { const p = prompt.trim(); if (p.length < 3) return; setProposal(null); build.mutate(p); };
  const titleTaken = useMemo(() => !!proposal && existing.some((w) => w.title === proposal.widget.title), [proposal, existing]);
  return (
    <div className="space-y-3 pb-3" data-testid="exec-customize-panel-ai">
      <div>
        <p className="text-[15px] font-bold leading-tight">AI Builder</p>
        <p className="text-[12px] text-muted-foreground">Say what you want to follow. You get a card that reads your own records — journal, notes, spending, trackers, tasks, goals, habits, people, pets, vehicles, property.</p>
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={300}
        placeholder="e.g. Journal entries about work"
        className="w-full rounded-xl border border-border bg-background/60 px-3 py-2 text-[13px]"
        data-testid="exec-customize-ai-input" />
      <div className="flex flex-wrap gap-1.5">
        {AI_EXAMPLES.map((ex) => (
          <button key={ex} type="button" onClick={() => { setText(ex); ask(ex); }}
            className="rounded-full border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted">{ex}</button>
        ))}
      </div>
      <button type="button" onClick={() => ask(text)} disabled={build.isPending || text.trim().length < 3}
        className="inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-[13px] font-bold text-white disabled:opacity-50"
        style={{ background: `hsl(${PURPLE})` }} data-testid="exec-customize-ai-build">
        <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> {build.isPending ? "Building…" : "Build card"}
      </button>
      <button type="button"
        onClick={() => { build.reset(); setProposal({ by: "manual", widget: { id: "preview", title: "My card", icon: "star", source: "journal", limit: 4 } }); }}
        className="ml-2 inline-flex items-center gap-1.5 rounded-xl border border-border px-3.5 py-2 text-[13px] font-semibold text-muted-foreground hover:bg-muted"
        data-testid="exec-customize-ai-manual">
        Build it yourself
      </button>
      {build.isError && (
        <p className="text-[12px] text-destructive" data-testid="exec-customize-ai-error">Couldn't build that card. Try again, pick a Widget Idea, or build it yourself.</p>
      )}
      {proposal && (
        <div className="rounded-xl border border-border/70 p-3 space-y-2" data-testid="exec-customize-ai-proposal">
          <div className="flex items-center gap-2">
            {(() => { const Icon = WIDGET_ICON[proposal.widget.icon]; return <Icon className="h-5 w-5 shrink-0" style={{ color: `hsl(${PURPLE})` }} aria-hidden="true" />; })()}
            <input value={proposal.widget.title} maxLength={40} aria-label="Card title"
              onChange={(e) => setProposal({ ...proposal, widget: { ...proposal.widget, title: e.target.value } })}
              className="flex-1 min-w-0 rounded-lg border border-border bg-background/60 px-2 py-1 text-[14px] font-bold"
              data-testid="exec-customize-ai-title" />
          </div>
          <p className="text-[12px] text-muted-foreground" data-testid="exec-customize-ai-description">{describeWidget(proposal.widget)}</p>
          {/* Every part of the card can be changed before it is added. */}
          <WidgetEditor value={proposal.widget} hideTitle onChange={(next) => setProposal({ ...proposal, widget: next })} />
          <p className="micro-label text-muted-foreground">Preview, from your records</p>
          <div className="rounded-lg border border-border/60 p-2">
            <ExecWidgetBody widget={proposal.widget} mode={mode} ids={ids} todayISO={todayISO} accent={PURPLE} preview />
          </div>
          {proposal.by === "rules" && (
            <p className="text-[11px] text-muted-foreground">Built from your words by fixed rules (the AI model didn't answer).</p>
          )}
          <button type="button" disabled={proposal.widget.title.trim().length < 2 || titleTaken}
            onClick={() => { const { id: _id, ...rest } = proposal.widget; onAdd({ ...rest, title: rest.title.trim() }); setProposal(null); setText(""); }}
            className="inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-[13px] font-bold text-white disabled:opacity-50"
            style={{ background: `hsl(${PURPLE})` }} data-testid="exec-customize-ai-add">
            <Plus className="h-3.5 w-3.5" aria-hidden="true" /> {titleTaken ? "You already have a card with this name" : "Add to my cards"}
          </button>
        </div>
      )}
    </div>
  );
}

export default ExecCustomizeDialog;
