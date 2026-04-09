import { useEffect, useState } from "react";
import CalendarView from "@/components/CalendarView";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
import { getProfileFilter } from "@/lib/profileFilter";
import { ArrowLeft } from "lucide-react";
import { Link } from "wouter";

export default function CalendarPage() {
  useEffect(() => { document.title = "Calendar — Portol"; }, []);
  const [filterIds, setFilterIds] = useState<string[]>(() => getProfileFilter().selectedIds);
  const [filterMode, setFilterMode] = useState(() => getProfileFilter().mode);

  return (
    <div className="h-full overflow-y-auto pb-24 px-2 py-2 md:px-4 md:py-3" data-testid="calendar-page">
      <div className="flex items-center gap-2 mb-2">
        <Link href="/dashboard">
          <button className="inline-flex items-center gap-1 rounded-md px-2 h-7 hover:bg-muted transition-colors text-xs text-muted-foreground" aria-label="Back to Dashboard" data-testid="button-back">
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Dashboard</span>
          </button>
        </Link>
        <MultiProfileFilter
          onChange={({ mode, selectedIds }) => { setFilterMode(mode); setFilterIds(selectedIds); }}
          compact
        />
      </div>
      <CalendarView externalFilterIds={filterIds} externalFilterMode={filterMode} />
    </div>
  );
}
