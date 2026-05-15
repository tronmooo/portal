import { useEffect, useState } from "react";
import CalendarView from "@/components/CalendarView";
import ObligationsManager from "@/components/ObligationsManager";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
import { getProfileFilter } from "@/lib/profileFilter";
import { ArrowLeft, CalendarDays, Repeat } from "lucide-react";
import { Link, useLocation } from "wouter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type TabKey = "calendar" | "obligations";

function readInitialTab(): TabKey {
  if (typeof window === "undefined") return "calendar";
  const hash = window.location.hash.replace("#", "");
  if (hash === "obligations" || hash === "calendar") return hash;
  return "calendar";
}

export default function CalendarPage() {
  useEffect(() => { document.title = "Calendar — Portol"; }, []);
  const [filterIds, setFilterIds] = useState<string[]>(() => getProfileFilter().selectedIds);
  const [filterMode, setFilterMode] = useState(() => getProfileFilter().mode);
  const [tab, setTab] = useState<TabKey>(readInitialTab);
  const [, setLocation] = useLocation();

  // Keep ?tab= and #hash in sync so deep-links like /calendar#obligations and
  // /obligations both land on the right tab. /obligations is preserved as a
  // standalone page for backward compat (renders the same component).
  useEffect(() => {
    const next = tab === "calendar" ? "" : `#${tab}`;
    if (window.location.hash !== next) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${next}`);
    }
  }, [tab]);

  useEffect(() => {
    const onHashChange = () => setTab(readInitialTab());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <div className="h-full overflow-y-auto pb-24 px-2 py-2 md:px-4 md:py-3" data-testid="calendar-page">
      <div className="flex items-center gap-2 mb-2">
        <Link href="/dashboard" className="inline-flex items-center gap-1 rounded-md px-2 h-7 hover:bg-muted transition-colors text-xs text-muted-foreground" aria-label="Back to Dashboard" data-testid="button-back">
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Dashboard</span>
        </Link>
        <MultiProfileFilter
          onChange={({ mode, selectedIds }) => { setFilterMode(mode); setFilterIds(selectedIds); }}
          compact
        />
      </div>

      <Tabs value={tab} onValueChange={v => setTab(v as TabKey)} className="w-full">
        <TabsList className="mb-3" data-testid="calendar-tabs">
          <TabsTrigger value="calendar" data-testid="tab-calendar">
            <CalendarDays className="w-3.5 h-3.5 mr-1.5" /> Calendar
          </TabsTrigger>
          <TabsTrigger value="obligations" data-testid="tab-obligations">
            <Repeat className="w-3.5 h-3.5 mr-1.5" /> Obligations
          </TabsTrigger>
        </TabsList>
        <TabsContent value="calendar" className="mt-0">
          <CalendarView externalFilterIds={filterIds} externalFilterMode={filterMode} />
        </TabsContent>
        <TabsContent value="obligations" className="mt-0">
          <ObligationsManager showHeader compact={false} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
