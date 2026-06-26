import { useEffect, useState } from "react";
import CalendarView from "@/components/CalendarView";
import ObligationsManager from "@/components/ObligationsManager";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
import { useProfileScope } from "@/hooks/useProfileScope";
import { ArrowLeft, CalendarDays, Repeat } from "lucide-react";
import { Link } from "wouter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type TabKey = "calendar" | "obligations";

// The app uses wouter's hash router, so window.location.hash holds the
// ROUTE (e.g. "#/calendar"). We piggy-back the active tab onto a query param
// (`?tab=obligations`) instead of fighting the hash router for the same slot.
function readInitialTab(): TabKey {
  if (typeof window === "undefined") return "calendar";
  try {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("tab");
    if (t === "obligations" || t === "calendar") return t;
  } catch {}
  // Backwards-compat: older links like /calendar#obligations encoded the
  // tab in the route hash. With the hash router enabled the hash now looks
  // like "#/calendar" or "#/calendar?tab=obligations", but external deep
  // links may still arrive without the leading "/". Best-effort parse:
  const raw = window.location.hash.replace(/^#\/?/, "");
  // raw might be: "calendar", "calendar?tab=obligations", "obligations", ""
  const [path, query] = raw.split("?");
  if (query) {
    const t = new URLSearchParams(query).get("tab");
    if (t === "obligations" || t === "calendar") return t;
  }
  if (path === "obligations") return "obligations";
  return "calendar";
}

export default function CalendarPage() {
  useEffect(() => { document.title = "Calendar — Portol"; }, []);
  // Single source of truth: active scope read reactively.
  const { mode: filterMode, selectedIds: filterIds } = useProfileScope();
  const [tab, setTab] = useState<TabKey>(readInitialTab);

  // Keep ?tab= synced WITHOUT touching window.location.hash, because the
  // hash holds the wouter route. Touching it would knock the router back
  // to "/" (Chat). We mutate URLSearchParams only.
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const current = url.searchParams.get("tab");
      const desired = tab === "calendar" ? null : tab;
      if (current !== desired) {
        if (desired) url.searchParams.set("tab", desired);
        else url.searchParams.delete("tab");
        window.history.replaceState(null, "", url.toString());
      }
    } catch {}
  }, [tab]);

  return (
    <div className="h-full overflow-y-auto pb-24 px-2 py-2 md:px-4 md:py-3" data-testid="calendar-page">
      <div className="flex items-center gap-2 mb-2">
        <Link href="/dashboard" className="inline-flex items-center gap-1 rounded-md px-2 h-7 hover:bg-muted transition-colors text-xs text-muted-foreground" aria-label="Back to Dashboard" data-testid="button-back">
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Dashboard</span>
        </Link>
        <MultiProfileFilter
          onChange={() => {}}
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
