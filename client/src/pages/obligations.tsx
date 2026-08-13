// Bills page — /dashboard/obligations.
//
// Renders the SAME <BillsView /> the Executive tab's Bills popup shows
// (user rule 2026-08-13: one data type = one canonical UI). The old
// ObligationsManager interface that used to live here is deleted — deep links
// (notifications, attention rows, "View All Bills") all land on this one
// Bills interface now.
import { useEffect } from "react";
import { ArrowLeft, Receipt } from "lucide-react";
import { Link } from "wouter";
import { BillsView } from "@/components/dashboard/BriefingPopups";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";

export default function ObligationsPage() {
  useEffect(() => { document.title = "Bills — Portol"; }, []);

  return (
    <div className="h-full overflow-y-auto pb-24 px-3 py-3 md:px-6 md:py-4" data-testid="obligations-page">
      <div className="flex items-center gap-2 mb-3">
        <Link href="/calendar" className="inline-flex items-center gap-1 rounded-md px-2 h-7 hover:bg-muted transition-colors text-xs text-muted-foreground" data-testid="button-back" aria-label="Back to Calendar">
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Calendar</span>
        </Link>
        <MultiProfileFilter compact onChange={() => {}} />
      </div>
      <div className="flex items-center gap-2.5 mb-3">
        <span
          className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: "hsl(155 65% 45% / 0.15)", color: "hsl(155 65% 45%)" }}
          aria-hidden="true"
        >
          <Receipt className="h-[18px] w-[18px]" strokeWidth={2.1} />
        </span>
        <div>
          <h1 className="text-lg font-bold leading-tight">Bills</h1>
          <p className="text-[12px] text-muted-foreground">Track and manage your bills</p>
        </div>
      </div>
      <div className="max-w-2xl">
        <BillsView />
      </div>
    </div>
  );
}
