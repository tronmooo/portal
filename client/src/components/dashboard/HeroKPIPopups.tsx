/**
 * HeroKPIPopups — the popups for the three hero KPI tiles on the dashboard.
 *
 * - NetWorthPopup   → Assets · Liabilities tabs with CRUD
 * - CashFlowPopup   → Income · Recurring Out · One-time Out with clickable rows
 * - BudgetPopup     → Per-category $ + %, add / edit / delete, live progress
 *
 * Filter-aware. All endpoints already exist on the server.
 */
import { useMemo, useState } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";
import { isInScope as scopeIsInScope, selfIdsFrom, withAncestorOwnerIds } from "@shared/scope";
import { resolveAssetValue, resolveLiabilityBalance } from "@shared/asset-value";
import { isRecurringBill } from "@shared/liability-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { invalidateDomain } from "@/lib/cache-bus";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Wallet, TrendingUp, TrendingDown, PieChart as PieChartIcon, Plus, Pencil, Trash2,
  CreditCard, Building2, Car, Banknote, RefreshCw, Receipt, ChevronRight, Loader2,
  ArrowDownToLine, ArrowUpFromLine, ExternalLink,
} from "lucide-react";
import { isTestEntity } from "@shared/test-data";
import { useShowTestData } from "@/lib/showTestData";
import { netWorthView } from "@/lib/net-worth-view";
import { EmptyState } from "@/components/ui/empty-state";
import { BubbleModal } from "@/components/ui/bubble-modal";

// P1.2 remediation: the asset/liability value resolvers are imported from
// @shared/asset-value (the single source of truth) instead of the hand-copied
// local versions that previously lived here and drifted from the server's.

const fmt = (n: number) => Math.round(n).toLocaleString();
// BUG-NW-1 fix (2026-06-03): `subscription` removed — subscriptions are
// recurring expenses, not balance-sheet items. They were leaking $cost into
// the Net Worth popup as if they were assets.
const ASSET_TYPES = new Set(["vehicle", "asset", "investment", "property", "account"]);
const LIABILITY_TYPES = new Set(["liability", "loan"]);

function iconForProfile(type: string) {
  if (type === "vehicle") return Car;
  if (type === "property") return Building2;
  if (type === "investment" || type === "account") return Banknote;
  if (type === "liability" || type === "loan") return CreditCard;
  if (type === "subscription") return RefreshCw;
  return Wallet;
}

// ─── Add asset / liability dialog (saves directly; no editor detour) ──────────
// Replaces the old `navigate("/editor/new/asset")` which is why "Add asset"
// "didn't save" — it just opened a route. This creates the profile via the API,
// scoped to the active/self profile, and refreshes every finance surface.
function AddHoldingDialog({
  open, kind, onClose, ownerProfileId,
}: {
  open: boolean;
  kind: "asset" | "liability";
  onClose: () => void;
  ownerProfileId: string;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const isLiab = kind === "liability";

  const mut = useMutation({
    mutationFn: async () => {
      const valNum = parseFloat(String(value).replace(/[^0-9.]/g, ""));
      const hasValue = value.trim() !== "" && isFinite(valNum) && valNum >= 0;
      // Store under the key both the client rollup and server net worth read.
      const fields = hasValue ? (isLiab ? { balance: valNum } : { currentValue: valNum }) : {};
      const res = await apiRequest("POST", "/api/profiles", {
        name: name.trim(),
        type: isLiab ? "liability" : "asset",
        ...(ownerProfileId ? { parentProfileId: ownerProfileId } : {}),
        fields,
        tags: [],
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: `${isLiab ? "Liability" : "Asset"} added`, description: name.trim() });
      // Net worth / assets / liabilities are derived — refresh every finance
      // surface via the cache bus's nuclear domain (same predicate, one shot).
      invalidateDomain("everything");
      onClose();
    },
    onError: (e: any) => toast({ title: "Couldn't save", description: e?.message || "Try again", variant: "destructive" }),
  });

  const submit = () => { if (name.trim() && !mut.isPending) mut.mutate(); };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xs" data-testid={`dialog-add-${kind}`}>
        <DialogHeader>
          <DialogTitle className="text-sm">{isLiab ? "Add liability" : "Add asset"}</DialogTitle>
          <DialogDescription className="text-xs">
            {isLiab ? "A debt — loan, credit card, or mortgage balance." : "Something you own — at its current value."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium">Name</label>
            <Input value={name} autoFocus placeholder={isLiab ? "e.g. Visa card" : "e.g. Savings, TV"}
              onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              data-testid={`input-add-${kind}-name`} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">{isLiab ? "Balance owed" : "Value"} <span className="text-muted-foreground font-normal">(optional)</span></label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">$</span>
              <Input type="text" inputMode="decimal" className="pl-7" value={value} placeholder="0.00"
                onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
                data-testid={`input-add-${kind}-value`} />
            </div>
          </div>
          <div className="flex gap-2 justify-end pt-1">
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" disabled={!name.trim() || mut.isPending} onClick={submit} data-testid={`btn-add-${kind}-save`}>
              {mut.isPending ? "Saving…" : "Add"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── shared shell ─────────────────────────────────────────────────────────────

interface ShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icon: any;
  iconColor: string;
  title: string;
  description?: string;
  total?: string;
  children: React.ReactNode;
  testId?: string;
}
// Thin wrapper over BubbleModal so NetWorth/CashFlow/Budget use the exact same
// shell as every other popup — medallion, bold title, one radius, one close
// button. This used to wrap ModalShell, a second shell with a squarer icon chip
// and a smaller title, which meant the popups reachable from the KPI strip
// looked like a different app from the ones reachable from a tab.
//
// `iconColor` arrives as a full `hsl(...)` string from the callers; BubbleModal
// wants the bare triple so it can derive tints from it.
const bareHsl = (c: string) => c.replace(/^hsl\(|\)$/g, "");

function MetricPopupShell({ open, onOpenChange, icon: Icon, iconColor, title, description, total, children, testId }: ShellProps) {
  return (
    <BubbleModal
      open={open}
      onClose={() => onOpenChange(false)}
      icon={Icon}
      accent={bareHsl(iconColor)}
      title={title}
      subtitle={description}
      testId={testId}
      headerRight={total ? <p className="metric-value text-lg leading-none" style={{ color: iconColor }}>{total}</p> : undefined}
    >
      {children}
    </BubbleModal>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// NET WORTH POPUP
// ═════════════════════════════════════════════════════════════════════════════

export interface FilterContext {
  filterMode: "all" | "selected" | "everyone";
  filterIds: string[];
}

export function NetWorthPopup({
  open, onOpenChange, filterMode, filterIds,
}: { open: boolean; onOpenChange: (o: boolean) => void } & FilterContext) {
  const [, navigate] = useLocation();
  // Close the dialog BEFORE navigating. Navigating while the Radix Dialog is
  // still open unmounts it without running its cleanup, which leaves
  // `pointer-events: none` stuck on <body> and makes the whole app unclickable.
  const go = (to: string) => { onOpenChange(false); setTimeout(() => navigate(to), 0); };

  // NOTE: /api/profiles ignores ?profileIds — fetch ALL and filter on the client
  // using the same semantics as trackers/dashboard (selected id OR child of selected parent).
  const { data: allProfiles = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/profiles", "net-worth"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/profiles`);
      const json = await res.json();
      return Array.isArray(json) ? json : (json?.data ?? []);
    },
    enabled: open,
  });

  // Add asset / liability dialog state. New holdings are owned by the active
  // single-selected profile, else the self profile.
  const [addKind, setAddKind] = useState<"asset" | "liability" | null>(null);
  const addOwnerProfileId = useMemo(() => {
    if (filterMode === "selected" && filterIds.length === 1) return filterIds[0];
    return (allProfiles.find((p: any) => p.type === "self")?.id) || "";
  }, [filterMode, filterIds, allProfiles]);

  // SCOPE CONTRACT: the server financeSnapshot is the single source of truth for
  // the headline/tab totals (party_links + parent-residual aware). The client
  // walk below still drives the per-line breakdown rows; only the displayed
  // totals are pinned to the server so this popup agrees with the Hero KPI tile
  // and the Finance card to the dollar.
  const param = filterMode === "selected" && filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";
  const { data: enhancedRes } = useQuery<any>({
    queryKey: ["/api/dashboard-enhanced", filterMode, ...filterIds, "networth"],
    queryFn: async () => (await apiRequest("GET", `/api/dashboard-enhanced${param}`)).json(),
    enabled: open,
  });

  // Net-worth history for the trend line + month-over-month delta.
  const histUrl = param ? `/api/net-worth/history${param}&lookbackDays=120` : `/api/net-worth/history?lookbackDays=120`;
  const { data: nwHistory = [] } = useQuery<any[]>({
    queryKey: ["/api/net-worth/history", filterMode, ...filterIds, "popup"],
    queryFn: async () => apiRequest("GET", histUrl).then(r => r.json()).catch(() => []),
    enabled: open,
  });

  // FIX 2: route through the canonical `isInScope` primitive so this popup
  //   answers the same question with the same logic as every other surface.
  //   Candidates come from one place only: the profile's own id and its
  //   `parentProfileId` column. Legacy in-JSON shapes (`fields.owners`,
  //   `fields.ownerIds`, `fields.linkedProfileIds`, `fields._parentProfileId`)
  //   are NOT consulted — they had 0 rows in production and their presence
  //   here let two readers silently agree on stale ghost-state.
  const selfIds = useMemo(() => selfIdsFrom(allProfiles as any[]), [allProfiles]);
  const isInScope = (p: any): boolean => {
    if (filterMode !== "selected" || filterIds.length === 0) return true;
    const candidates: string[] = [];
    if (p?.id) candidates.push(p.id);
    // The whole owner chain, not just the immediate parent (shared/scope).
    if (p?.parentProfileId) candidates.push(...withAncestorOwnerIds([p.parentProfileId], allProfiles as any[]));
    return scopeIsInScope(candidates, { selectedIds: filterIds, selfIds }, "out_of_scope");
  };

  // BUG-NW-2/3 fix (2026-06-03): the popup now renders the server-computed
  // breakdown arrays directly. Header total and per-row values come from one
  // source so they cannot drift. The earlier client walk produced rows whose
  // gross values didn't match the ownership-share-adjusted header (200% Home).
  // The client walk is kept ONLY as a one-tick fallback before the server
  // payload resolves so the popup never shows an empty list.
  const fallback = useMemo(() => {
    const assets: any[] = [];
    const liabilities: any[] = [];
    for (const p of allProfiles) {
      if (!isInScope(p)) continue;
      if (ASSET_TYPES.has(p.type)) {
        const v = resolveAssetValue(p);
        if (v > 0) assets.push({ id: p.id, name: p.name, type: p.type, grossValue: v, share: 100, value: v });
      }
      if ((LIABILITY_TYPES.has(p.type) || (p.type === "vehicle" || p.type === "property" || p.type === "asset")) && !isRecurringBill(p.type_key)) {
        const v = resolveLiabilityBalance(p);
        if (v > 0) liabilities.push({ id: p.id, name: p.name, type: p.type, grossValue: v, share: 100, value: v });
      }
    }
    assets.sort((a, b) => b.value - a.value);
    liabilities.sort((a, b) => b.value - a.value);
    return { assets, liabilities };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allProfiles, filterMode, filterIds.join(",")]);

  const snap = enhancedRes?.financeSnapshot;
  const showTestData = useShowTestData();
  // ONE derivation, shared with the Hero KPI tile (client/src/lib/net-worth-view).
  // Totals are the sum of the rows rendered below — including after the
  // synthetic-test-data filter removes rows — so the headline can never drift
  // from the list the way it did in the $150 KPI-vs-popup report.
  const sheet = useMemo(
    () => netWorthView(snap, showTestData, fallback),
    [snap, showTestData, fallback],
  );
  const { assets, liabilities, totalAssets: displayTotalA, totalLiabilities: displayTotalL, netWorth } = sheet;

  // Trend series (oldest→newest), pinned to the live net worth at the end.
  const nwSeries = useMemo(() => {
    const rows = Array.isArray(nwHistory) ? [...nwHistory] : [];
    rows.sort((a, b) => String(a.snapshotDate).localeCompare(String(b.snapshotDate)));
    const pts = rows.map((r: any) => Number(r.netWorth) || 0);
    if (pts.length === 0) return [netWorth];
    pts[pts.length - 1] = netWorth;
    return pts;
  }, [nwHistory, netWorth]);
  const nwTrend = useMemo(() => {
    if (nwSeries.length < 2) return null;
    const first = nwSeries[0], last = nwSeries[nwSeries.length - 1];
    if (!isFinite(first) || !isFinite(last)) return null;
    const delta = last - first;
    // BUG-4: only show a % when the baseline is non-trivial and the series
    // doesn't cross zero — otherwise a near-zero or sign-flipping baseline
    // yields a nonsensical percentage (e.g. "-109.9%"). Fall back to the $ delta.
    const baselineTooSmall = Math.abs(first) < 1;
    const signFlipped = (first < 0) !== (last < 0);
    const pct = baselineTooSmall || signFlipped ? null : (delta / Math.abs(first)) * 100;
    return { pct, up: delta >= 0, delta };
  }, [nwSeries]);
  const nwPath = useMemo(() => {
    const s = nwSeries.length >= 2 ? nwSeries : null;
    if (!s) return null;
    const min = Math.min(...s), max = Math.max(...s), span = (max - min) || 1;
    const W = 280, H = 40;
    return s.map((v, i) => `${i === 0 ? "M" : "L"}${((i / (s.length - 1)) * W).toFixed(1)},${(H - ((v - min) / span) * H + 2).toFixed(1)}`).join(" ");
  }, [nwSeries]);
  const ratio = displayTotalA > 0 ? Math.min(100, Math.round((displayTotalL / displayTotalA) * 100)) : 0;

  return (
    <MetricPopupShell
      open={open}
      onOpenChange={onOpenChange}
      icon={Wallet}
      iconColor="hsl(155 60% 44%)"
      title="Net Worth"
      description={`${assets.length} asset${assets.length !== 1 ? "s" : ""} · ${liabilities.length} liabilit${liabilities.length !== 1 ? "ies" : "y"}`}
      total={`$${fmt(netWorth)}`}
      testId="popup-net-worth"
    >
      {isLoading ? (
        <div className="px-4 py-10 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
        {/* Trend + summary */}
        <div className="px-4 pt-3 pb-2 border-b border-border">
          <div className="flex items-center justify-between">
            <div>
              <p className="micro-label text-muted-foreground">Net worth</p>
              <p className="text-xl font-bold tabular-nums leading-tight" style={{ color: netWorth < 0 ? "hsl(0 80% 60%)" : "hsl(155 60% 44%)" }}>
                {netWorth < 0 ? "-" : ""}${fmt(Math.abs(netWorth))}
              </p>
            </div>
            {nwTrend && (
              <div className="text-right" title={`Change since the start of the selected period (${nwSeries.length} days of snapshots)`}>
                <p className="text-[11px] font-semibold tabular-nums" style={{ color: nwTrend.up ? "hsl(155 60% 44%)" : "hsl(0 80% 60%)" }}>
                  {nwTrend.up ? "▲" : "▼"} {nwTrend.pct != null ? `${Math.abs(nwTrend.pct).toFixed(1)}%` : `$${fmt(Math.abs(nwTrend.delta))}`}
                </p>
                <p className="text-[11px] text-muted-foreground">{nwTrend.delta >= 0 ? "+" : "−"}${fmt(Math.abs(nwTrend.delta))} this period</p>
              </div>
            )}
          </div>
          {nwPath && (
            <svg viewBox="0 0 280 44" className="mt-1.5 h-10 w-full" preserveAspectRatio="none">
              <path d={nwPath} fill="none" stroke={`hsl(${nwTrend && !nwTrend.up ? "0 80% 60%" : "155 60% 44%"})`} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          {/* Assets vs liabilities split bar */}
          <div className="mt-1.5">
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
              <div style={{ width: `${100 - ratio}%`, background: "hsl(155 60% 44%)" }} />
              <div style={{ width: `${ratio}%`, background: "hsl(270 80% 65%)" }} />
            </div>
            <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
              <span><span className="inline-block h-2 w-2 rounded-full align-middle" style={{ background: "hsl(155 60% 44%)" }} /> Assets ${fmt(displayTotalA)}</span>
              <span>Liab ${fmt(displayTotalL)} <span className="inline-block h-2 w-2 rounded-full align-middle" style={{ background: "hsl(270 80% 65%)" }} /></span>
            </div>
          </div>
        </div>
        <Tabs defaultValue="assets" className="w-full">
          <TabsList className="grid w-full grid-cols-2 rounded-none border-b">
            <TabsTrigger value="assets" className="text-xs">
              Assets <span className="ml-1.5 text-muted-foreground tabular-nums">${fmt(displayTotalA)}</span>
            </TabsTrigger>
            <TabsTrigger value="liabilities" className="text-xs">
              Liabilities <span className="ml-1.5 text-muted-foreground tabular-nums">${fmt(displayTotalL)}</span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="assets" className="m-0">
            <EntityList
              items={assets}
              total={displayTotalA}
              emptyLabel="No assets yet"
              addLabel="Add asset"
              onAdd={() => setAddKind("asset")}
              onOpen={(p) => go(`/profiles/${p.id}`)}
            />
          </TabsContent>
          <TabsContent value="liabilities" className="m-0">
            <EntityList
              items={liabilities}
              total={displayTotalL}
              emptyLabel="No liabilities yet"
              addLabel="Add liability"
              onAdd={() => setAddKind("liability")}
              onOpen={(p) => go(`/profiles/${p.id}`)}
            />
          </TabsContent>
        </Tabs>
        </>
      )}
      {addKind && (
        <AddHoldingDialog
          open
          kind={addKind}
          ownerProfileId={addOwnerProfileId}
          onClose={() => setAddKind(null)}
        />
      )}
    </MetricPopupShell>
  );
}

function EntityList({
  items, total, emptyLabel, addLabel, onAdd, onOpen,
}: {
  items: any[];
  total: number;
  emptyLabel: string;
  addLabel: string;
  onAdd: () => void;
  onOpen: (p: any) => void;
}) {
  if (items.length === 0) {
    return <EmptyState icon={Wallet} label={emptyLabel} ctaLabel={addLabel} onCta={onAdd} />;
  }
  // User request: list assets/liabilities alphabetically by name (was value-desc).
  const sortedItems = [...items].sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  return (
    <div className="divide-y divide-border/60">
      {sortedItems.map((p) => {
        const Icon = iconForProfile(p.type);
        // BUG-NW-2 fix (2026-06-03): row value is the ownership-share-adjusted
        // amount from the server breakdown (the popup no longer multiplies a
        // gross value by share itself). `share` is the ownership %. The small
        // secondary number shows the ownership share (e.g. "50%" co-owner),
        // not "% of total" — the old formula produced 200% on a 50%-owned home.
        const rowValue = Number(p.value ?? p._value ?? 0);
        const sharePct = Number.isFinite(Number(p.share)) ? Math.round(Number(p.share)) : 100;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onOpen(p)}
            className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-muted/40 text-left transition-colors"
            data-testid={`entity-row-${p.id}`}
          >
            <div className="rounded-md p-1.5 bg-muted/60 shrink-0">
              <Icon className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium truncate">{p.name}</p>
              <p className="text-[11px] text-muted-foreground capitalize">{p.type}</p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-xs font-semibold tabular-nums">${fmt(rowValue)}</p>
              <p className="text-[11px] text-muted-foreground tabular-nums">{sharePct < 100 ? `${sharePct}% owned` : ""}</p>
            </div>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
          </button>
        );
      })}
      <div className="px-4 py-2 border-t border-border bg-muted/20">
        <Button size="sm" variant="ghost" className="w-full justify-start text-xs h-7" onClick={onAdd} data-testid="button-entity-add">
          <Plus className="h-3 w-3 mr-1.5" /> {addLabel}
        </Button>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// CASH FLOW — deleted (2026-08-13).
// The "Cash Flow — this month" list popup that lived here duplicated the
// canonical Cash Flow UI (finance/MoneyPopups CashFlowWaterfallPopup). One
// data type = one UI: every entry point now opens CashFlowView
// (components/finance/CashFlowView), which wraps the waterfall.
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// SPENDING BREAKDOWN (rendered at the top of the Budget popup)
// ═════════════════════════════════════════════════════════════════════════════

const SPEND_COLORS = ["#8b5cf6", "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#a855f7", "#06b6d4", "#ec4899", "#84cc16", "#94a3b8"];

function SpendingBreakdown({ filterMode, filterIds }: FilterContext) {
  const [period, setPeriod] = useState<"month" | "lastMonth" | "year">("month");
  const leading = filterMode === "selected" && filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";
  const { data: expRaw } = useQuery<any>({
    queryKey: ["/api/expenses", filterMode, ...filterIds, "spend-breakdown"],
    queryFn: () => apiRequest("GET", `/api/expenses${leading}`).then(r => r.json()).catch(() => []),
  });
  const expenses: any[] = Array.isArray(expRaw) ? expRaw : (expRaw?.items || []);

  const now = new Date();
  const ymNow = now.toLocaleDateString("en-CA", { timeZone: BROWSER_TIMEZONE }).slice(0, 7);
  const yearNow = ymNow.slice(0, 4);
  const lastDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const ymLast = `${lastDate.getFullYear()}-${String(lastDate.getMonth() + 1).padStart(2, "0")}`;

  const view = useMemo(() => {
    const inP = (d: string) => {
      const s = String(d || "").slice(0, 10);
      if (period === "month") return s.slice(0, 7) === ymNow;
      if (period === "lastMonth") return s.slice(0, 7) === ymLast;
      return s.slice(0, 4) === yearNow;
    };
    const periodExp = expenses.filter((e) => inP(e.date));
    const byCat: Record<string, number> = {};
    let total = 0;
    for (const e of periodExp) {
      const c = (e.category || "other");
      const a = Number(e.amount) || 0;
      byCat[c] = (byCat[c] || 0) + a;
      total += a;
    }
    const rows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
    const txns = periodExp.length;
    let days: number;
    if (period === "month") days = now.getDate();
    else if (period === "lastMonth") days = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
    else { const start = new Date(now.getFullYear(), 0, 0); days = Math.max(1, Math.ceil((now.getTime() - start.getTime()) / 86400000)); }
    const dailyAvg = days > 0 ? total / days : 0;
    // Trend vs the previous comparable period (only meaningful for the month view).
    let trendPct: number | null = null;
    if (period === "month") {
      const lastTotal = expenses.filter((e) => String(e.date || "").slice(0, 7) === ymLast).reduce((s, e) => s + (Number(e.amount) || 0), 0);
      if (lastTotal > 0) trendPct = Math.round(((total - lastTotal) / lastTotal) * 1000) / 10;
    }
    return { rows, total, txns, dailyAvg, trendPct, perDay: days > 0 ? txns / days : 0 };
  }, [expenses, period, ymNow, ymLast, yearNow]);

  const donutData = view.rows.slice(0, 8).map(([name, value], i) => ({ name, value, color: SPEND_COLORS[i % SPEND_COLORS.length] }));
  const otherTotal = view.rows.slice(8).reduce((s, [, v]) => s + v, 0);
  if (otherTotal > 0) donutData.push({ name: "Other", value: otherTotal, color: SPEND_COLORS[9] });
  const periodSub = period === "month" ? "This month" : period === "lastMonth" ? "Last month" : `${yearNow}`;

  return (
    <div className="p-3 space-y-3 border-b border-border">
      {/* Period tabs */}
      <div className="flex gap-1 rounded-xl bg-muted/50 p-1">
        {([["month", "This Month"], ["lastMonth", "Last Month"], ["year", "This Year"]] as const).map(([k, l]) => (
          <button key={k} type="button" onClick={() => setPeriod(k)}
            className={`flex-1 rounded-lg py-1.5 text-[11px] font-semibold transition-colors ${period === k ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
            {l}
          </button>
        ))}
      </div>

      {/* Summary stat cards */}
      <div className="grid grid-cols-3 gap-2">
        <div className="bubble p-2.5">
          <p className="text-[11px] text-muted-foreground">Total Spent</p>
          <p className="text-base font-bold tabular-nums leading-tight">${fmt(view.total)}</p>
          {view.trendPct != null && (
            <p className={`text-[11px] font-medium tabular-nums ${view.trendPct > 0 ? "text-red-500" : "text-green-500"}`}>
              {view.trendPct > 0 ? "▲" : "▼"} {Math.abs(view.trendPct)}% vs last
            </p>
          )}
        </div>
        <div className="bubble p-2.5">
          <p className="text-[11px] text-muted-foreground">Daily Average</p>
          <p className="text-base font-bold tabular-nums leading-tight">${fmt(view.dailyAvg)}</p>
        </div>
        <div className="bubble p-2.5">
          <p className="text-[11px] text-muted-foreground">Transactions</p>
          <p className="text-base font-bold tabular-nums leading-tight">{view.txns}</p>
          <p className="text-[11px] text-muted-foreground">~{view.perDay.toFixed(1)}/day</p>
        </div>
      </div>

      {/* Donut by category */}
      {view.total > 0 ? (
        <div className="bubble p-3">
          <p className="text-xs font-semibold mb-2">Spending by Category</p>
          <div className="flex items-center gap-3">
            <div className="relative shrink-0" style={{ width: 116, height: 116 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={donutData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={38} outerRadius={56} paddingAngle={2} stroke="none">
                    {donutData.map((d, i) => <Cell key={i} fill={d.color} />)}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <span className="text-[13px] font-bold tabular-nums leading-none">${fmt(view.total)}</span>
                <span className="micro-label text-muted-foreground mt-0.5">{periodSub}</span>
              </div>
            </div>
            <div className="flex-1 min-w-0 space-y-1">
              {donutData.map((d) => {
                const pct = view.total > 0 ? Math.round((d.value / view.total) * 100) : 0;
                return (
                  <div key={d.name} className="flex items-center gap-1.5 text-[11px]">
                    <span className="h-2 w-2 rounded-full shrink-0" style={{ background: d.color }} />
                    <span className="capitalize truncate flex-1">{d.name}</span>
                    <span className="tabular-nums text-muted-foreground shrink-0">{pct}%</span>
                    <span className="tabular-nums font-medium shrink-0 w-14 text-right">${fmt(d.value)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground text-center py-4">No spending recorded {periodSub.toLowerCase()}.</p>
      )}

      {/* Category details with bars */}
      {view.rows.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold">Category Details</p>
          <div className="rounded-xl border border-border divide-y divide-border/60">
            {view.rows.map(([cat, amt], i) => {
              const pct = view.total > 0 ? Math.round((amt / view.total) * 100) : 0;
              const color = SPEND_COLORS[i % SPEND_COLORS.length];
              return (
                <div key={cat} className="flex items-center gap-2.5 px-3 py-2">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" style={{ background: `${color}22` }}>
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium capitalize truncate">{cat}</p>
                      <p className="text-xs font-semibold tabular-nums shrink-0">${fmt(amt)}</p>
                    </div>
                    <p className="text-[11px] text-muted-foreground">{pct}% of total</p>
                    <div className="mt-1 h-1 rounded-full bg-muted/60 overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// BUDGET POPUP
// ═════════════════════════════════════════════════════════════════════════════

interface BudgetRow {
  id: string;
  category: string;
  amount: number;
  notes?: string;
}

export function BudgetPopup({
  open, onOpenChange, filterMode, filterIds, monthlyIncome,
}: { open: boolean; onOpenChange: (o: boolean) => void; monthlyIncome: number } & FilterContext) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const param = filterMode === "selected" && filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";

  // Round-6 fix (BUG-022): the popup previously fetched /api/budgets without
  // the active profile filter, so switching profiles didn't update what the
  // popup showed. Thread filterMode/filterIds the same way the Hero card and
  // Finance section do.
  // P1.1 remediation: use the browser timezone (same BROWSER_TIMEZONE every
  // request sends as the X-Timezone header), not a hardcoded zone. The server
  // computes month boundaries from that same header, so client and server
  // agree on what "this month" means for the user.
  const currentMonthForPopup = new Date().toLocaleDateString('en-CA', { timeZone: BROWSER_TIMEZONE }).slice(0, 7);
  const budgetsParam = filterMode === "selected" && filterIds.length > 0
    ? `?month=${currentMonthForPopup}&profileIds=${filterIds.join(",")}`
    : `?month=${currentMonthForPopup}`;
  const { data: budgetsResp } = useQuery<any>({
    queryKey: ["/api/budgets", "popup", currentMonthForPopup, filterMode, ...filterIds],
    queryFn: async () => (await apiRequest("GET", `/api/budgets${budgetsParam}`)).json(),
    enabled: open,
  });
  const budgets: BudgetRow[] = budgetsResp?.budgets ?? [];

  const { data: enhancedRes } = useQuery<any>({
    queryKey: ["/api/dashboard-enhanced", filterMode, ...filterIds, "budget"],
    queryFn: async () => (await apiRequest("GET", `/api/dashboard-enhanced${param}`)).json(),
    enabled: open,
  });

  const spendByCategory: Record<string, number> = enhancedRes?.financeSnapshot?.spendByCategory ?? {};

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState<string>("");
  const [editMode, setEditMode] = useState<"dollar" | "percent">("dollar");

  const [newCategory, setNewCategory] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [newMode, setNewMode] = useState<"dollar" | "percent">("dollar");
  const [showAdd, setShowAdd] = useState(false);

  const totalBudget = budgets.reduce((s, b) => s + b.amount, 0);
  // Round-6 fix (BUG-002/020): previous version summed only spend-in-budgeted-categories
  // which produced a wildly different headline % than the Hero KPI card and the Finance
  // section's Budget bar (both of which use total monthly spend / total budget). The
  // user reported Hero card 184% vs popup 69% which traced directly to that divergence.
  // Unify on totalMonthlySpend (the same number the Hero card displays) so the three
  // surfaces always agree.
  const totalMonthlySpend: number = enhancedRes?.financeSnapshot?.totalMonthlySpend
    ?? Object.values(spendByCategory).reduce((s, v) => s + (Number(v) || 0), 0);
  const totalSpent = totalMonthlySpend;
  const overallPct = totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0;

  // Invalidate every queryKey that derives from budgets.
  // Note: TanStack Query does prefix-match by array elements, so
  // ["/api/budgets"] does NOT match ["/api/budgets/summary", ...]. We need to
  // invalidate each prefix explicitly so the Dashboard Hero KPI and the
  // Finance page Budget banner re-render after an add / edit / delete.
  // (Fixes QA bugs BUG-004 "Dashboard Budget card stale" + BUG-008 "Finance
  // budget banner stale".)
  // Round-6 fix (BUG-012): previously invalidated /api/expenses and /api/stats on every
  // budget edit, which caused the Hero KPI Cash Flow tile to flicker / change values
  // because /api/dashboard-enhanced was refetched with a fresh server cache slice.
  // Editing a budget has zero effect on expenses, income, or finance snapshot — only
  // budget-derived queries actually need to refetch. Keeping scope tight prevents the
  // "unrelated tile changes when I edit budget" cross-tile flicker the user reported.
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["/api/budgets"] });
    qc.invalidateQueries({ queryKey: ["/api/budgets/summary"] });
  };

  const addMut = useMutation<any, Error, { category: string; amount: number }, { prev: [readonly unknown[], unknown][] }>({
    mutationFn: async (vars) => {
      return (await apiRequest("POST", "/api/budgets", vars)).json();
    },
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ["/api/budgets"] });
      const prev = qc.getQueriesData({ queryKey: ["/api/budgets"] });
      const temp = { id: `temp-${Date.now()}`, category: vars.category, amount: vars.amount, _optimistic: true };
      qc.setQueriesData({ queryKey: ["/api/budgets"] }, (old: any) => {
        if (!old) return old;
        if (Array.isArray(old)) return [temp, ...old];
        if (Array.isArray(old?.budgets)) return { ...old, budgets: [temp, ...old.budgets] };
        return old;
      });
      return { prev };
    },
    onSuccess: () => { invalidate(); toast({ title: "Budget added" }); },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) qc.setQueryData(key, data); }
      toast({ title: "Couldn't add", description: e?.message || "Try again", variant: "destructive" });
    },
  });

  const updateMut = useMutation<any, Error, { id: string; amount: number }, { prev: [readonly unknown[], unknown][] }>({
    mutationFn: async ({ id, amount }) => {
      return (await apiRequest("PATCH", `/api/budgets/${id}`, { amount })).json();
    },
    onMutate: async ({ id, amount }) => {
      await qc.cancelQueries({ queryKey: ["/api/budgets"] });
      const prev = qc.getQueriesData({ queryKey: ["/api/budgets"] });
      qc.setQueriesData({ queryKey: ["/api/budgets"] }, (old: any) => {
        if (!old) return old;
        if (Array.isArray(old)) return old.map((b: any) => b.id === id ? { ...b, amount } : b);
        if (Array.isArray(old?.budgets)) return { ...old, budgets: old.budgets.map((b: any) => b.id === id ? { ...b, amount } : b) };
        return old;
      });
      return { prev };
    },
    onSuccess: () => { invalidate(); toast({ title: "Budget updated" }); },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) qc.setQueryData(key, data); }
      toast({ title: "Couldn't update", description: e?.message || "Try again", variant: "destructive" });
    },
  });

  const deleteMut = useMutation<any, Error, string, { prev: [readonly unknown[], unknown][] }>({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/budgets/${id}`),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["/api/budgets"] });
      const prev = qc.getQueriesData({ queryKey: ["/api/budgets"] });
      qc.setQueriesData({ queryKey: ["/api/budgets"] }, (old: any) => {
        if (!old) return old;
        if (Array.isArray(old)) return old.filter((b: any) => b.id !== id);
        if (Array.isArray(old?.budgets)) return { ...old, budgets: old.budgets.filter((b: any) => b.id !== id) };
        return old;
      });
      return { prev };
    },
    onSuccess: () => { invalidate(); toast({ title: "Budget removed" }); },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) { for (const [key, data] of ctx.prev) qc.setQueryData(key, data); }
      toast({ title: "Couldn't delete", description: e?.message || "Try again", variant: "destructive" });
    },
  });

  const startEdit = (b: BudgetRow) => {
    setEditingId(b.id);
    setEditAmount(String(b.amount));
    setEditMode("dollar");
  };
  const saveEdit = (b: BudgetRow) => {
    let amt = Number(editAmount);
    if (editMode === "percent" && monthlyIncome > 0) amt = (amt / 100) * monthlyIncome;
    if (!isFinite(amt) || amt < 0) {
      toast({ title: "Invalid amount", variant: "destructive" });
      return;
    }
    updateMut.mutate({ id: b.id, amount: amt });
    setEditingId(null); // close edit row immediately
  };

  const handleAdd = () => {
    const amt = newMode === "percent"
      ? (monthlyIncome > 0 ? (Number(newAmount) / 100) * monthlyIncome : Number(newAmount))
      : Number(newAmount);
    if (!isFinite(amt) || amt <= 0) {
      toast({ title: "Enter a valid amount", variant: "destructive" });
      return;
    }
    if (!newCategory.trim()) {
      toast({ title: "Enter a category", variant: "destructive" });
      return;
    }
    addMut.mutate({ category: newCategory.trim(), amount: amt });
    setNewCategory(""); setNewAmount(""); setShowAdd(false);
  };

  // PR R: suppress all 0%/$0 framing when no budget exists; the empty state below
  // is the only thing the user should see.
  const hasBudget = totalBudget > 0;
  return (
    <MetricPopupShell
      open={open}
      onOpenChange={onOpenChange}
      icon={PieChartIcon}
      iconColor={overallPct > 100 ? "hsl(0 72% 52%)" : "hsl(43 85% 52%)"}
      title="Monthly Budget"
      description={hasBudget ? `$${fmt(totalSpent)} of $${fmt(totalBudget)} spent` : "No budget set for this scope"}
      total={hasBudget ? `${overallPct}%` : ""}
      testId="popup-budget"
    >
      {/* Spending Breakdown — period tabs, summary stats, donut, category details */}
      <SpendingBreakdown filterMode={filterMode} filterIds={filterIds} />

      <div className="p-3 space-y-2">
        <p className="micro-label text-muted-foreground">Budget</p>
        {/* Overall progress — only when a budget exists */}
        {hasBudget && (
          <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[11px] text-muted-foreground">Overall</p>
              <p className="text-[11px] tabular-nums">{overallPct}% of ${fmt(totalBudget)}</p>
            </div>
            <div className="h-2 rounded-full overflow-hidden bg-muted">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${Math.min(100, overallPct)}%`,
                  background: overallPct > 100 ? "hsl(0 72% 52%)" : overallPct >= 80 ? "hsl(43 85% 52%)" : "hsl(155 60% 44%)",
                }}
              />
            </div>
          </div>
        )}

        {/* Categories */}
        {budgets.length === 0 ? (
          <div className="px-4 py-8 flex flex-col items-center gap-2">
            <p className="text-xs text-muted-foreground">No budget categories yet</p>
            <Button size="sm" onClick={() => setShowAdd(true)} data-testid="budget-add-first">
              <Plus className="h-3.5 w-3.5 mr-1.5" /> Add first category
            </Button>
          </div>
        ) : (
          <div className="rounded-lg border border-border divide-y divide-border/60">
            {budgets.map((b) => {
              const spent = spendByCategory[b.category] || 0;
              const pct = b.amount > 0 ? Math.round((spent / b.amount) * 100) : 0;
              const incomePct = monthlyIncome > 0 ? Math.round((b.amount / monthlyIncome) * 100) : 0;
              const over = pct > 100;
              const editing = editingId === b.id;
              return (
                <div key={b.id} className="px-3 py-2" data-testid={`budget-row-${b.id}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <p className="text-xs font-medium capitalize flex-1 truncate">{b.category}</p>
                    {!editing && (
                      <>
                        <Badge variant="outline" className="text-[11px] px-1 py-0 tabular-nums">{incomePct}% inc</Badge>
                        <button
                          type="button"
                          onClick={() => startEdit(b)}
                          className="p-1 rounded hover:bg-muted text-muted-foreground"
                          aria-label="Edit"
                          data-testid={`budget-edit-${b.id}`}
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteMut.mutate(b.id)}
                          className="p-1 rounded hover:bg-muted text-muted-foreground"
                          aria-label="Delete"
                          data-testid={`budget-delete-${b.id}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </>
                    )}
                  </div>

                  {editing ? (
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <div className="inline-flex rounded-md border border-border overflow-hidden text-[11px]">
                        <button
                          type="button"
                          onClick={() => setEditMode("dollar")}
                          className={`px-1.5 py-0.5 ${editMode === "dollar" ? "bg-primary text-primary-foreground" : "bg-muted"}`}
                        >$</button>
                        <button
                          type="button"
                          onClick={() => setEditMode("percent")}
                          className={`px-1.5 py-0.5 ${editMode === "percent" ? "bg-primary text-primary-foreground" : "bg-muted"}`}
                          disabled={monthlyIncome <= 0}
                          title={monthlyIncome <= 0 ? "Add income to use %" : ""}
                        >%</button>
                      </div>
                      <Input
                        type="number"
                        value={editAmount}
                        onChange={(e) => setEditAmount(e.target.value)}
                        className="h-7 text-xs flex-1"
                        autoFocus
                      />
                      <Button size="sm" className="h-7 text-xs px-2" onClick={() => saveEdit(b)} disabled={updateMut.isPending}>
                        {updateMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 text-xs px-2" onClick={() => setEditingId(null)}>Cancel</Button>
                    </div>
                  ) : null}

                  <div className="h-1.5 rounded-full overflow-hidden bg-muted">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${Math.min(100, pct)}%`,
                        background: over ? "hsl(0 72% 52%)" : pct >= 80 ? "hsl(43 85% 52%)" : "hsl(155 60% 44%)",
                      }}
                    />
                  </div>
                  <div className="flex items-center justify-between mt-0.5">
                    <p className="text-[11px] text-muted-foreground tabular-nums">
                      ${fmt(spent)} / ${fmt(b.amount)}
                    </p>
                    <p className={`text-[11px] tabular-nums ${over ? "text-red-500 font-semibold" : "text-muted-foreground"}`}>{pct}%</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Add category */}
        {!showAdd ? (
          <Button size="sm" variant="outline" className="w-full text-xs h-8" onClick={() => setShowAdd(true)} data-testid="budget-show-add">
            <Plus className="h-3.5 w-3.5 mr-1.5" /> Add category
          </Button>
        ) : (() => {
          // QA BUG-007 — disable submit until required fields filled,
          // highlight invalid inputs in red, and never let the button flash
          // "Saving…" on an empty submit.
          const catOk = newCategory.trim().length > 0;
          const amtNum = Number(newAmount);
          const amtOk = newAmount !== "" && Number.isFinite(amtNum) && amtNum > 0;
          const canSubmit = catOk && amtOk && !addMut.isPending;
          return (
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-2 space-y-1.5">
            <Input
              placeholder="Category (e.g. groceries, rent)"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              className={`h-8 text-xs ${!catOk && newCategory.length > 0 ? "border-destructive focus-visible:ring-destructive" : ""}`}
              autoFocus
              aria-invalid={!catOk && newCategory.length > 0}
            />
            <div className="flex items-center gap-1.5">
              <div className="inline-flex rounded-md border border-border overflow-hidden text-[11px]">
                <button
                  type="button"
                  onClick={() => setNewMode("dollar")}
                  className={`px-1.5 py-1 ${newMode === "dollar" ? "bg-primary text-primary-foreground" : "bg-muted"}`}
                >$</button>
                <button
                  type="button"
                  onClick={() => setNewMode("percent")}
                  className={`px-1.5 py-1 ${newMode === "percent" ? "bg-primary text-primary-foreground" : "bg-muted"}`}
                  disabled={monthlyIncome <= 0}
                  title={monthlyIncome <= 0 ? "Add income to use %" : ""}
                >%</button>
              </div>
              <Input
                type="number"
                placeholder={newMode === "percent" ? "% of income" : "$ amount"}
                value={newAmount}
                onChange={(e) => setNewAmount(e.target.value)}
                className={`h-8 text-xs flex-1 ${!amtOk && newAmount.length > 0 ? "border-destructive focus-visible:ring-destructive" : ""}`}
                aria-invalid={!amtOk && newAmount.length > 0}
              />
              <Button size="sm" className="h-8 text-xs px-2" onClick={handleAdd} disabled={!canSubmit} data-testid="budget-add-submit">
                Add
              </Button>
              <Button size="sm" variant="ghost" className="h-8 text-xs px-2" onClick={() => { setShowAdd(false); setNewCategory(""); setNewAmount(""); }}>
                Cancel
              </Button>
            </div>
            {newMode === "percent" && monthlyIncome > 0 && newAmount && (
              <p className="text-[11px] text-muted-foreground">
                ≈ ${fmt((Number(newAmount) / 100) * monthlyIncome)} of your ${fmt(monthlyIncome)} monthly income
              </p>
            )}
          </div>
          );
        })()}
      </div>
    </MetricPopupShell>
  );
}
