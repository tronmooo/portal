import { useEffect, useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
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

  // v2 summary band — Today / This Week / Total events.
  const profileParam = filterMode === "selected" && filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";
  const { data: events = [] } = useQuery<any[]>({
    queryKey: ["/api/events", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/events${profileParam}`).then(r => r.json()).catch(() => []),
  });
  const evSummary = useMemo(() => {
    const todayStr = new Date().toLocaleDateString("en-CA");
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    let today = 0, week = 0;
    const list = Array.isArray(events) ? events : [];
    for (const e of list) {
      const d = String(e.date || "").slice(0, 10);
      if (!d) continue;
      if (d === todayStr) today++;
      const dd = new Date(`${d}T12:00:00`);
      const diff = Math.round((dd.getTime() - t0.getTime()) / 86400000);
      if (diff >= 0 && diff <= 7) week++;
    }
    return { today, week, total: list.length };
  }, [events]);

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

      {/* v2 summary band */}
      <div className="grid grid-cols-3 gap-2 mb-2" data-testid="calendar-summary">
        {[
          { label: "Today", value: evSummary.today, color: "200 80% 55%" },
          { label: "This Week", value: evSummary.week, color: "262 70% 62%" },
          { label: "Total", value: evSummary.total, color: "155 60% 48%" },
        ].map(s => (
          <div key={s.label} className="rounded-xl border border-border/50 bg-card/60 p-2.5 text-center">
            <p className="text-lg font-bold tabular-nums leading-none" style={{ color: `hsl(${s.color})` }}>{s.value}</p>
            <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">{s.label}</p>
          </div>
        ))}
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
