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
    <div className="h-full overflow-y-auto pb-24" data-testid="calendar-page">
      <div className="p-4 md:p-6">
        <div className="flex items-center gap-3 mb-4">
          <Link href="/dashboard">
            <button className="inline-flex items-center justify-center rounded-md w-8 h-8 hover:bg-muted transition-colors" aria-label="Back" data-testid="button-back">
              <ArrowLeft className="w-4 h-4" />
            </button>
          </Link>
          <h1 className="text-xl font-semibold">Calendar</h1>
          <MultiProfileFilter
            onChange={({ mode, selectedIds }) => { setFilterMode(mode); setFilterIds(selectedIds); }}
            compact
          />
        </div>
      </div>
      <CalendarView externalFilterIds={filterIds} externalFilterMode={filterMode} />
    </div>
  );
}
