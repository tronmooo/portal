// ── Executive-briefing list popups (2026-07-15) ──────────────────────────────
// The briefing's stat tiles and section rows used to NAVIGATE away to other
// pages (/calendar, /dashboard/finance, /goals, /journal, …) — the user asked
// for in-place popups everywhere ("it's just leading to different links").
// Each popup shows the FULL list for its module in the same dense visual
// language as the briefing (accent dot, mono headers, thin dividers) with a
// footer link to the full page for deep work. TasksPopup/HabitsPopup already
// existed in TaskHabitPopups.tsx — these cover the remaining modules.
import { useMemo } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { ArrowRight, Bell, CalendarDays, CreditCard, FileText, NotebookPen, Target } from "lucide-react";

// ── Shared shell ─────────────────────────────────────────────────────────────
function PopupShell({ open, onClose, title, icon: Icon, accent, count, footerLabel, footerHref, children }: {
  open: boolean; onClose: () => void; title: string; icon: any; accent: string;
  count?: number; footerLabel?: string; footerHref?: string; children: React.ReactNode;
}) {
  const [, navigate] = useLocation();
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md max-h-[80vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-4 pt-4 pb-2 border-b border-border/40">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: `hsl(${accent})`, boxShadow: `0 0 6px hsl(${accent} / 0.7)` }} />
            <Icon className="h-4 w-4" style={{ color: `hsl(${accent})` }} />
            {title}
            {typeof count === "number" && (
              <span className="text-[11px] px-1.5 rounded-full font-normal" style={{ background: `hsl(${accent} / 0.15)`, color: `hsl(${accent})` }}>{count}</span>
            )}
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto px-2 py-1.5">{children}</div>
        {footerLabel && footerHref && (
          <div className="px-3 py-2 border-t border-border/40">
            <Button variant="ghost" size="sm" className="w-full h-8 text-xs justify-between"
              onClick={() => { onClose(); navigate(footerHref); }}>
              {footerLabel} <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PopRow({ left, main, right, urgent, onClick }: {
  left: string; main: string; right?: string; urgent?: boolean; onClick?: () => void;
}) {
  const Comp: any = onClick ? "button" : "div";
  return (
    <Comp onClick={onClick}
      className={`w-full flex items-baseline gap-2 py-1.5 px-2 text-left text-xs border-b border-border/25 last:border-0 ${onClick ? "hover:bg-muted/40 rounded-sm" : ""} ${urgent ? "text-red-500" : ""}`}>
      <span className="text-[10px] uppercase text-muted-foreground w-16 shrink-0 truncate">{left}</span>
      <span className="flex-1 truncate">{main}</span>
      {right && <span className="text-[11px] tabular-nums text-right shrink-0">{right}</span>}
    </Comp>
  );
}

const EmptyNote = ({ label }: { label: string }) => (
  <p className="text-xs text-muted-foreground py-4 text-center">{label}</p>
);

// ── Bills ────────────────────────────────────────────────────────────────────
export function BillsPopup({ open, onClose, bills }: { open: boolean; onClose: () => void; bills: any[] }) {
  const { toast } = useToast();
  const payBill = useMutation({
    mutationFn: async (id: string) => { await apiRequest("POST", `/api/obligations/${id}/pay`, {}); },
    onSuccess: () => {
      toast({ title: "Payment recorded" });
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
    },
    onError: () => toast({ title: "Payment failed", variant: "destructive" }),
  });
  const rows = useMemo(() => (bills || []).slice().sort((a, b) => (a.daysUntil ?? 1e9) - (b.daysUntil ?? 1e9)), [bills]);
  const total = rows.reduce((s, b) => s + (Number(b.amount) || 0), 0);
  return (
    <PopupShell open={open} onClose={onClose} title="Bills & Obligations" icon={CreditCard}
      accent="48 96% 53%" count={rows.length} footerLabel="Open Finance" footerHref="/dashboard/finance">
      {rows.length === 0 ? <EmptyNote label="No bills due soon." /> : (
        <>
          <p className="text-[11px] text-muted-foreground px-2 py-1">${Math.round(total).toLocaleString()} upcoming</p>
          {rows.map((b: any) => (
            <div key={b.id} className="flex items-center gap-1">
              <div className="flex-1 min-w-0">
                <PopRow
                  left={b.status === "overdue" ? "overdue" : b.daysUntil === 0 ? "today" : `${b.daysUntil}d`}
                  main={b.name} right={`$${Number(b.amount).toLocaleString()}`}
                  urgent={b.status === "overdue" || b.daysUntil === 0} />
              </div>
              <button onClick={() => payBill.mutate(b.id)} disabled={payBill.isPending}
                className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded border border-border hover:bg-muted shrink-0 mr-1"
                data-testid={`popup-pay-${b.id}`}>Pay</button>
            </div>
          ))}
        </>
      )}
    </PopupShell>
  );
}

// ── Events / calendar preview (also serves birthdays & important dates) ─────
export function EventsPopup({ open, onClose, items, todayStr, title = "Calendar · Next 45 days" }: {
  open: boolean; onClose: () => void; items: any[]; todayStr: string; title?: string;
}) {
  const days = useMemo(() => {
    const buckets: Array<{ day: string; items: any[] }> = [];
    for (const item of items || []) {
      const d = String(item.date || "").slice(0, 10);
      if (!d) continue;
      const label = d === todayStr ? "Today" : new Date(d + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      const bucket = buckets.find(b => b.day === label);
      if (bucket) bucket.items.push(item);
      else buckets.push({ day: label, items: [item] });
    }
    return buckets;
  }, [items, todayStr]);
  return (
    <PopupShell open={open} onClose={onClose} title={title} icon={CalendarDays}
      accent="239 84% 67%" count={(items || []).length} footerLabel="Open Calendar" footerHref="/calendar">
      {days.length === 0 ? <EmptyNote label="Nothing scheduled." /> : days.map(d => (
        <div key={d.day}>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-2 pt-2">{d.day}</div>
          {d.items.map((i: any) => (
            <PopRow key={i.id} left={i.time || (i.allDay ? "all day" : i.type || "")} main={i.title}
              right={i.type && i.type !== "event" ? i.type : undefined}
              urgent={i.type === "bill" || i.type === "obligation"} />
          ))}
        </div>
      ))}
    </PopupShell>
  );
}

// ── Expiring documents ───────────────────────────────────────────────────────
export function DocsPopup({ open, onClose, docs }: { open: boolean; onClose: () => void; docs: any[] }) {
  const [, navigate] = useLocation();
  return (
    <PopupShell open={open} onClose={onClose} title="Document Expirations" icon={FileText}
      accent="0 72% 58%" count={(docs || []).length} footerLabel="Open Documents" footerHref="/linked?tab=documents">
      {(docs || []).length === 0 ? <EmptyNote label="Nothing expiring soon." /> : (docs || []).map((d: any) => (
        <PopRow key={d.documentId || d.id}
          left={d.expirationDate?.slice(5, 10) || "—"}
          main={d.name || d.fieldName || "Document"}
          right={typeof d.daysUntil === "number" ? `${d.daysUntil}d` : undefined}
          urgent={typeof d.daysUntil === "number" && d.daysUntil <= 21}
          onClick={d.documentId ? () => { onClose(); navigate(`/documents/${d.documentId}`); } : undefined} />
      ))}
    </PopupShell>
  );
}

// ── Projects / goals ─────────────────────────────────────────────────────────
export function ProjectsPopup({ open, onClose, goals }: { open: boolean; onClose: () => void; goals: any[] }) {
  const rows = (goals || []).filter((g: any) => g.status === "active" || !g.status);
  return (
    <PopupShell open={open} onClose={onClose} title="Open Projects" icon={Target}
      accent="142 70% 45%" count={rows.length} footerLabel="Open Goals" footerHref="/goals">
      {rows.length === 0 ? <EmptyNote label="No active goals." /> : rows.map((g: any) => {
        const pct = g.target ? Math.max(0, Math.min(100, Math.round(((g.current ?? 0) / g.target) * 100))) : null;
        return (
          <div key={g.id} className="px-2 py-1.5 border-b border-border/25 last:border-0">
            <div className="flex items-baseline gap-2 text-xs">
              <span className="flex-1 truncate">{g.title}</span>
              {pct !== null && <span className="text-[11px] tabular-nums text-emerald-500">{pct}%</span>}
            </div>
            {pct !== null && (
              <div className="mt-1 h-1 rounded-full bg-muted overflow-hidden">
                <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
              </div>
            )}
          </div>
        );
      })}
    </PopupShell>
  );
}

// ── Quick notes / journal ────────────────────────────────────────────────────
export function NotesPopup({ open, onClose, notes }: { open: boolean; onClose: () => void; notes: any[] }) {
  return (
    <PopupShell open={open} onClose={onClose} title="Quick Notes" icon={NotebookPen}
      accent="240 10% 60%" count={(notes || []).length} footerLabel="Open Journal" footerHref="/journal">
      {(notes || []).length === 0 ? <EmptyNote label="No notes yet." /> : (notes || []).map((n: any) => (
        <div key={n.id} className="px-2 py-1.5 border-b border-border/25 last:border-0">
          <div className="text-[10px] uppercase text-muted-foreground">{String(n.date || n.createdAt || "").slice(0, 10)}{n.mood ? ` · ${n.mood}` : ""}</div>
          <p className="text-xs whitespace-pre-wrap break-words mt-0.5">{String(n.content || "").slice(0, 400)}</p>
        </div>
      ))}
    </PopupShell>
  );
}

// ── Reminders ────────────────────────────────────────────────────────────────
export function RemindersPopup({ open, onClose, reminders }: { open: boolean; onClose: () => void; reminders: any[] }) {
  const rows = (reminders || []).filter((r: any) => !r.completed && !r.dismissed);
  return (
    <PopupShell open={open} onClose={onClose} title="Reminders" icon={Bell}
      accent="43 96% 56%" count={rows.length} footerLabel="Open Calendar" footerHref="/calendar">
      {rows.length === 0 ? <EmptyNote label="No reminders." /> : rows.map((r: any) => (
        <PopRow key={r.id}
          left={String(r.fireAt || r.dueDate || "").slice(5, 10) || "—"}
          main={r.title || r.message || r.content}
          right={r.fireAt ? new Date(r.fireAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : undefined} />
      ))}
    </PopupShell>
  );
}
