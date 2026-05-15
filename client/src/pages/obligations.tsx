// Standalone Obligations page — preserved for backward compat with existing
// deep links. The full management UI now lives in
// <ObligationsManager />, which is also embedded as a tab on /calendar.
import { useEffect } from "react";
import { ArrowLeft } from "lucide-react";
import { Link } from "wouter";
import ObligationsManager from "@/components/ObligationsManager";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";

export default function ObligationsPage() {
  useEffect(() => { document.title = "Obligations — Portol"; }, []);

  return (
    <div className="h-full overflow-y-auto pb-24 px-2 py-2 md:px-4 md:py-3" data-testid="obligations-page">
      <div className="flex items-center gap-2 mb-3">
        <Link href="/calendar" className="inline-flex items-center gap-1 rounded-md px-2 h-7 hover:bg-muted transition-colors text-xs text-muted-foreground" data-testid="button-back" aria-label="Back to Calendar">
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Calendar</span>
        </Link>
        <MultiProfileFilter compact onChange={() => {}} />
        <Link href="/calendar#obligations" className="ml-auto text-xs text-muted-foreground hover:text-foreground transition-colors" data-testid="link-go-to-calendar-tab">
          Manage on Calendar →
        </Link>
      </div>
      <ObligationsManager showHeader compact={false} />
    </div>
  );
}
