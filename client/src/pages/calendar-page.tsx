import { useEffect } from "react";
import CalendarView from "@/components/CalendarView";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
import { useProfileFilter } from "@/lib/profileFilter";
import { ArrowLeft } from "lucide-react";
import { Link } from "wouter";

export default function CalendarPage() {
  useEffect(() => { document.title = "Calendar — Portol"; }, []);
  const { filterIds, filterMode, onChange: onFilterChange } = useProfileFilter();

  return (
    <div className="h-full overflow-y-auto pb-24 px-2 py-2 md:px-4 md:py-3" data-testid="calendar-page">
      <div className="flex items-center gap-2 mb-2">
        <Link href="/dashboard">
          <button className="inline-flex items-center justify-center rounded-md w-7 h-7 hover:bg-muted transition-colors" aria-label="Back" data-testid="button-back">
            <ArrowLeft className="w-3.5 h-3.5" />
          </button>
        </Link>
        <h1 className="text-sm font-semibold">Calendar</h1>
        <MultiProfileFilter
          onChange={onFilterChange}
          compact
        />
      </div>
      <CalendarView externalFilterIds={filterIds} externalFilterMode={filterMode} />
    </div>
  );
}
