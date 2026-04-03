import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

interface DrillDownItem {
  label: string;
  value: string | number;
  sub?: string;
  category?: string;
  date?: string;
  profile?: string;
  id?: string;
}

export interface ExpenseRecord {
  id: string;
  description: string;
  amount: number;
  date: string;
  category?: string;
  vendor?: string;
}

export interface TaskRecord {
  id: string;
  title: string;
  status: string;
  priority?: string;
  dueDate?: string;
}

export interface ObligationRecord {
  id: string;
  name: string;
  amount: number;
  frequency?: string;
  nextDueDate?: string;
}

interface DrillDownDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  total?: string | number;
  items: DrillDownItem[];
  expenses?: ExpenseRecord[];
  tasks?: TaskRecord[];
  obligations?: ObligationRecord[];
  emptyMessage?: string;
}

function fmtDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtMoney(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const PRIORITY_CLR: Record<string, string> = {
  low: "bg-slate-500/10 text-slate-600",
  medium: "bg-amber-500/10 text-amber-600",
  high: "bg-red-500/10 text-red-600",
};

export function DrillDownDialog({ open, onClose, title, subtitle, total, items, expenses, tasks, obligations, emptyMessage }: DrillDownDialogProps) {
  const expenseTotal = expenses?.reduce((s, e) => s + e.amount, 0) ?? 0;
  const hasRecords = (expenses?.length ?? 0) > 0 || (tasks?.length ?? 0) > 0 || (obligations?.length ?? 0) > 0;

  // Reconciliation: parse header total as number for comparison
  const headerNum = typeof total === "number" ? total : typeof total === "string" ? parseFloat(total.replace(/[^0-9.\-]/g, "")) : NaN;
  const expenseMatch = expenses && expenses.length > 0 && !isNaN(headerNum)
    ? Math.abs(expenseTotal - headerNum) < 0.01
    : null;
  const discrepancy = expenseMatch === false ? Math.abs(expenseTotal - headerNum) : 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>{title}</span>
            {total != null && (
              <span className="text-lg font-bold tabular-nums">{total}</span>
            )}
          </DialogTitle>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </DialogHeader>
        <div className="overflow-y-auto flex-1 -mx-6 px-6">
          {items.length === 0 && !hasRecords ? (
            <p className="text-xs text-muted-foreground text-center py-8">{emptyMessage || "No data"}</p>
          ) : (
            <>
              {/* Category breakdown */}
              {items.length > 0 && (
                <div className="divide-y divide-border/50">
                  {items.map((item, i) => (
                    <div key={item.id || i} className="py-2 flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium truncate">{item.label}</p>
                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                          {item.category && (
                            <Badge variant="outline" className="text-[9px] h-4 capitalize">{item.category}</Badge>
                          )}
                          {item.profile && (
                            <Badge variant="secondary" className="text-[9px] h-4">{item.profile}</Badge>
                          )}
                          {item.date && (
                            <span className="text-[10px] text-muted-foreground">{item.date}</span>
                          )}
                          {item.sub && (
                            <span className="text-[10px] text-muted-foreground">{item.sub}</span>
                          )}
                        </div>
                      </div>
                      <span className="text-xs font-bold tabular-nums shrink-0">{item.value}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Individual expense records */}
              {expenses && expenses.length > 0 && (
                <div className="mt-3">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">All Expenses</p>
                    <span className="text-[10px] text-muted-foreground">{expenses.length} items</span>
                  </div>
                  <ScrollArea className="max-h-[40vh]">
                    <div className="divide-y divide-border/30">
                      {expenses.map((exp) => (
                        <div key={exp.id} className="py-1.5 flex items-center justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-[11px] font-medium truncate">{exp.description}</p>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              <span className="text-[10px] text-muted-foreground">{fmtDate(exp.date)}</span>
                              {exp.category && (
                                <Badge variant="outline" className="text-[8px] h-3.5 capitalize">{exp.category}</Badge>
                              )}
                              {exp.vendor && (
                                <span className="text-[10px] text-muted-foreground/70">{exp.vendor}</span>
                              )}
                            </div>
                          </div>
                          <span className="text-[11px] font-bold tabular-nums shrink-0">{fmtMoney(exp.amount)}</span>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                  {/* Footer total + reconciliation */}
                  <div className="mt-2 pt-2 border-t border-border flex items-center justify-between">
                    <span className="text-[10px] font-semibold text-muted-foreground uppercase">Total</span>
                    <span className="text-xs font-bold tabular-nums">{fmtMoney(expenseTotal)}</span>
                  </div>
                  {expenseMatch === true && (
                    <p className="text-[10px] text-green-600 dark:text-green-400 mt-1">&#10003; Matches category total</p>
                  )}
                  {expenseMatch === false && (
                    <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1">&#9888; Discrepancy: {fmtMoney(discrepancy)}</p>
                  )}
                </div>
              )}

              {/* Individual task records */}
              {tasks && tasks.length > 0 && (
                <div className="mt-3">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Tasks</p>
                    <span className="text-[10px] text-muted-foreground">{tasks.length} items</span>
                  </div>
                  <ScrollArea className="max-h-[40vh]">
                    <div className="divide-y divide-border/30">
                      {tasks.map((t) => (
                        <div key={t.id} className="py-1.5 flex items-center justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className={`text-[11px] font-medium truncate ${t.status === "done" ? "line-through text-muted-foreground" : ""}`}>{t.title}</p>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              <Badge variant={t.status === "done" ? "secondary" : "outline"} className="text-[8px] h-3.5">{t.status === "done" ? "done" : "todo"}</Badge>
                              {t.priority && (
                                <Badge variant="outline" className={`text-[8px] h-3.5 ${PRIORITY_CLR[t.priority] || ""}`}>{t.priority}</Badge>
                              )}
                              {t.dueDate && (
                                <span className="text-[10px] text-muted-foreground">{fmtDate(t.dueDate)}</span>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              )}

              {/* Individual obligation records */}
              {obligations && obligations.length > 0 && (
                <div className="mt-3">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Obligations</p>
                    <span className="text-[10px] text-muted-foreground">{obligations.length} items</span>
                  </div>
                  <ScrollArea className="max-h-[40vh]">
                    <div className="divide-y divide-border/30">
                      {obligations.map((o) => (
                        <div key={o.id} className="py-1.5 flex items-center justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-[11px] font-medium truncate">{o.name}</p>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              {o.frequency && (
                                <Badge variant="outline" className="text-[8px] h-3.5 capitalize">{o.frequency}</Badge>
                              )}
                              {o.nextDueDate && (
                                <span className="text-[10px] text-muted-foreground">due {fmtDate(o.nextDueDate)}</span>
                              )}
                            </div>
                          </div>
                          <span className="text-[11px] font-bold tabular-nums shrink-0">{fmtMoney(o.amount)}</span>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                  <div className="mt-2 pt-2 border-t border-border flex items-center justify-between">
                    <span className="text-[10px] font-semibold text-muted-foreground uppercase">Total</span>
                    <span className="text-xs font-bold tabular-nums">{fmtMoney(obligations.reduce((s, o) => s + o.amount, 0))}</span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Tiny clickable KPI wrapper — makes any number look tappable */
export function InteractiveKPI({
  children,
  onClick,
  className = "",
}: {
  children: React.ReactNode;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-left w-full cursor-pointer hover:bg-muted/50 active:scale-[0.98] transition-all rounded-lg ${className}`}
      title="Tap for details"
    >
      {children}
    </button>
  );
}
