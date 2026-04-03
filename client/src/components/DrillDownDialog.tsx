import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";

interface DrillDownItem {
  label: string;
  value: string | number;
  sub?: string;
  category?: string;
  date?: string;
  profile?: string;
  id?: string;
}

interface DrillDownDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  total?: string | number;
  items: DrillDownItem[];
  emptyMessage?: string;
}

export function DrillDownDialog({ open, onClose, title, subtitle, total, items, emptyMessage }: DrillDownDialogProps) {
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
          {items.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-8">{emptyMessage || "No data"}</p>
          ) : (
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
