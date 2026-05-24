// Standalone Obligations page — preserved for backward compat with existing
// deep links. The full management UI lives in <ObligationsManager />, which
// is also embedded as a tab on /calendar.
//
// Why this page owns its own filter state (and passes it down) instead of
// just relying on the global filter store: the filter button used to be
// wired with `onChange={() => {}}` AND ObligationsManager subscribed to the
// global store. In theory that should have worked end-to-end via the event
// bus — but the perceived behavior was \"clicking the filter does literally
// nothing\". Now this page owns the local state and pushes it down via
// externalFilter* props so there is exactly one source of truth and no
// reliance on the global event bus for this view.
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Link } from "wouter";
import ObligationsManager from "@/components/ObligationsManager";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
import { getProfileFilter, type FilterMode } from "@/lib/profileFilter";

export default function ObligationsPage() {
  useEffect(() => { document.title = "Obligations — Portol"; }, []);

  // Seed from the persisted global filter so navigating here from another
  // page that set a filter keeps it visible.
  const [filterMode, setFilterMode] = useState<FilterMode>(() => getProfileFilter().mode);
  const [filterIds, setFilterIds] = useState<string[]>(() => getProfileFilter().selectedIds);

  return (
    <div className="h-full overflow-y-auto pb-24 px-2 py-2 md:px-4 md:py-3" data-testid="obligations-page">
      <div className="flex items-center gap-2 mb-3">
        <Link href="/calendar" className="inline-flex items-center gap-1 rounded-md px-2 h-7 hover:bg-muted transition-colors text-xs text-muted-foreground" data-testid="button-back" aria-label="Back to Calendar">
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Calendar</span>
        </Link>
        <MultiProfileFilter
          compact
          onChange={({ mode, selectedIds }) => { setFilterMode(mode); setFilterIds(selectedIds); }}
        />
        <Link href="/calendar?tab=obligations" className="ml-auto text-xs text-muted-foreground hover:text-foreground transition-colors" data-testid="link-go-to-calendar-tab">
          Manage on Calendar →
        </Link>
      </div>
      <ObligationsManager
        showHeader
        compact={false}
        externalFilterMode={filterMode}
        externalFilterIds={filterIds}
      />
    </div>
  );
}
