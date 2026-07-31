/**
 * ASSET OVERVIEW REBUILD (2026-05-26)
 *
 * Shipped alongside Phases 1–9 of the asset profile redesign. Everything in
 * this file is purpose-built for the asset-profile experience:
 *
 *   - ProfileBreadcrumb      — Owner > … > Parent > Self trail
 *   - OwnershipTree          — mini up-chain + 1-level-down preview
 *   - AssetSummaryCard       — header facts: owner, parent, value, liabilities, net
 *   - TopChildrenPreview     — first 3 child assets w/ "View all" jump
 *   - FinancialsBreakdown    — itemised per-child rollup table (Phase 7)
 *   - OwnerCountTowardToggle — Phase 6 "count toward owner / parent chain"
 *   - AdoptAsChildDialog     — Phase 1 hardened picker w/ preview + confirm
 *   - ChildActionsMenu       — Phase 4 per-row View/Edit/Move/Remove
 *
 * Keep this file UI-only. All math comes from shared/asset-rollup.ts.
 * The legacy ChildAssetsCard / ValueRollupCard / MaintenanceCard / InfoTab
 * code in profile-detail.tsx still exists — this rebuild wraps them where
 * useful and replaces them on the new Overview tab.
 */

import { useMemo, useState } from "react";
import { formatMoneyCompact } from "@/lib/format";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ChevronRight,
  Link as LinkIcon,
  MoreVertical,
  Move,
  Eye,
  Pencil,
  Trash2,
  AlertTriangle,
  Home as HomeIcon,
  Package,
  Coins,
  Users,
  ArrowUpRight,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { OwnershipEditor } from "@/components/OwnershipEditor";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  computeAssetRollup,
  type AssetRollupRow,
} from "../../../../shared/asset-rollup";

// ---------------------------------------------------------------------------
// Shared types — kept loose because profile-detail's local types are coupled
// to a huge ProfileDetail interface we don't want to re-export.
// ---------------------------------------------------------------------------

type AnyProfile = {
  id: string;
  name: string;
  type: string;
  fields?: Record<string, any>;
  parentProfileId?: string | null;
  childProfiles?: AnyProfile[];
};

type TreeNodeLite = {
  id: string;
  name: string;
  type: string;
  fields?: Record<string, any>;
  parentProfileId?: string | null;
  children: TreeNodeLite[];
};

const NESTED_ASSET_TYPES = ["vehicle", "property", "investment", "asset", "account"];
const PERSON_TYPES = new Set(["person", "self", "pet"]);

// Was a local copy; formatMoneyCompact carries the identical thresholds.
const formatCurrency = formatMoneyCompact;

function flattenTree(node: TreeNodeLite | undefined | null): AnyProfile[] {
  if (!node) return [];
  const out: AnyProfile[] = [];
  const walk = (n: TreeNodeLite) => {
    for (const c of n.children || []) {
      out.push({
        id: c.id,
        name: c.name,
        type: c.type,
        fields: c.fields,
        parentProfileId: c.parentProfileId,
      });
      walk(c);
    }
  };
  walk(node);
  return out;
}

/** Walk up the parent chain producing [owner, ..., parent, self]. */
function walkAncestry(
  profile: AnyProfile,
  allProfiles: AnyProfile[],
  maxDepth = 32,
): AnyProfile[] {
  const byId = new Map(allProfiles.map((p) => [p.id, p]));
  const chain: AnyProfile[] = [profile];
  let cur: AnyProfile | undefined = profile;
  let depth = 0;
  while (cur && depth < maxDepth) {
    const pid = cur.parentProfileId;
    if (!pid) break;
    const parent = byId.get(pid);
    if (!parent) break;
    chain.unshift(parent);
    cur = parent;
    depth++;
  }
  return chain;
}

/** Top of the parent chain — the owning person (or self/pet). */
function findOwner(
  profile: AnyProfile,
  allProfiles: AnyProfile[],
): AnyProfile | null {
  const chain = walkAncestry(profile, allProfiles);
  for (const node of chain) {
    if (PERSON_TYPES.has(node.type)) return node;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase 2 — ProfileBreadcrumb
// ---------------------------------------------------------------------------

export function ProfileBreadcrumb({
  profile,
  allProfiles,
  className,
  omitCurrent = false,
}: {
  profile: AnyProfile;
  allProfiles: AnyProfile[];
  className?: string;
  /**
   * Drop the trailing node — the profile you're already on. Set this wherever
   * the page title above the trail is that same name, which is where it read as
   * "iPhone 17 Pro Max" followed a line later by "… › iPhone 17 Pro Max".
   */
  omitCurrent?: boolean;
}) {
  const [, setLocation] = useLocation();
  const full = walkAncestry(profile, allProfiles);
  const chain = omitCurrent ? full.slice(0, -1) : full;
  if (full.length <= 1 || chain.length === 0) return null;

  return (
    <nav
      aria-label="breadcrumb"
      className={`flex items-center gap-1 flex-wrap text-[11px] text-muted-foreground ${className || ""}`}
      data-testid="profile-breadcrumb"
    >
      {chain.map((node, i) => {
        // With `omitCurrent` the trail is all ancestors, so nothing in it is
        // "self" — every crumb stays a link you can walk back up.
        const isLast = !omitCurrent && i === chain.length - 1;
        return (
          <span key={node.id} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="h-3 w-3 opacity-60" />}
            {isLast ? (
              <span
                className="font-semibold text-foreground truncate max-w-[140px]"
                data-testid={`crumb-self`}
                title={node.name}
              >
                {node.name}
              </span>
            ) : (
              <button
                className="hover:text-foreground hover:underline truncate max-w-[120px]"
                onClick={() => setLocation(`/profiles/${node.id}`)}
                data-testid={`crumb-${node.id}`}
                title={node.name}
              >
                {node.name}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Phase 8 — OwnershipTree
// Shows the full up-chain rooted at the owner with a 1-level-down expansion
// of the current asset's children. Highlights the current asset.
// ---------------------------------------------------------------------------

export function OwnershipTree({
  profile,
  allProfiles,
  treeData,
}: {
  profile: AnyProfile;
  allProfiles: AnyProfile[];
  treeData?: TreeNodeLite | null;
}) {
  const [, setLocation] = useLocation();

  // Actual owner shares (asset_party_links, role = owner/co_owner). When this
  // resolves with rows, it IS the source of truth for who owns the asset —
  // the tree renders one row per owner with their share. The parentProfileId
  // chain is only a fallback when no explicit owner links exist (legacy
  // implicit ownership). This is exactly what the user expected: after
  // splitting Mike's House 50/50 in the Ownership editor, the tree should
  // show "Mike 50% / Test 50% → Mike\'s House".
  const partyLinksQuery = useQuery<any[]>({
    queryKey: ["/api/asset-party-links"],
    queryFn: () => apiRequest("GET", "/api/asset-party-links").then((r) => r.json()),
  });
  const ownerRows = useMemo(() => {
    const rows = (partyLinksQuery.data || [])
      .filter((l: any) => l.assetProfileId === profile.id)
      .filter((l: any) => {
        const r = String(l.role || "owner").toLowerCase();
        return r === "owner" || r === "co_owner" || r === "co-owner";
      });
    const profileById = new Map(allProfiles.map((p) => [p.id, p] as const));
    return rows
      .map((l: any) => ({
        owner: profileById.get(l.partyProfileId) as AnyProfile | undefined,
        pct: Number(l.ownershipPercentage ?? 0),
      }))
      .filter((r) => !!r.owner)
      // Largest share first; alphabetical for ties.
      .sort((a, b) => b.pct - a.pct || (a.owner!.name || "").localeCompare(b.owner!.name || ""));
  }, [partyLinksQuery.data, profile.id, allProfiles]);

  const chain = walkAncestry(profile, allProfiles);
  const directChildren =
    treeData?.children?.filter((c) =>
      NESTED_ASSET_TYPES.includes(c.type),
    ) || [];

  const hasExplicitOwners = ownerRows.length > 0;

  return (
    <Card data-testid="card-ownership-tree">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Users className="h-4 w-4 text-primary" /> Ownership Tree
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="space-y-0.5 font-mono text-xs leading-relaxed">
          {hasExplicitOwners ? (
            <>
              {ownerRows.map((row) => (
                <button
                  key={row.owner!.id}
                  onClick={() => setLocation(`/profiles/${row.owner!.id}`)}
                  className="flex items-center gap-1.5 w-full text-left rounded px-1 py-1 hover:bg-muted text-foreground"
                  style={{ paddingLeft: 4 }}
                  data-testid={`tree-owner-${row.owner!.id}`}
                >
                  <span className="truncate">{row.owner!.name}</span>
                  <span className="text-[11px] opacity-60 capitalize">· {row.owner!.type}</span>
                  <span className="ml-auto text-[11px] opacity-80 font-semibold pr-1">{row.pct}%</span>
                </button>
              ))}
              {/* The asset itself — one level deeper than the owners. */}
              <div
                className="flex items-center gap-1.5 w-full rounded px-1 py-1 bg-primary/10 text-primary font-semibold"
                style={{ paddingLeft: 18 }}
                data-testid={`tree-node-${profile.id}`}
              >
                <span className="opacity-50">└─</span>
                <span className="truncate">{profile.name}</span>
                <span className="text-[11px] opacity-60 capitalize">· {profile.type}</span>
              </div>
            </>
          ) : (
            chain.map((node, i) => {
              const indent = i * 14;
              const isSelf = node.id === profile.id;
              return (
                <button
                  key={node.id}
                  disabled={isSelf}
                  onClick={() => setLocation(`/profiles/${node.id}`)}
                  className={`flex items-center gap-1.5 w-full text-left rounded px-1 py-1 ${
                    isSelf
                      ? "bg-primary/10 text-primary font-semibold cursor-default"
                      : "hover:bg-muted text-foreground"
                  }`}
                  style={{ paddingLeft: indent + 4 }}
                  data-testid={`tree-node-${node.id}`}
                >
                  {i > 0 && <span className="opacity-50">└─</span>}
                  <span className="truncate">{node.name}</span>
                  <span className="text-[11px] opacity-60 capitalize">· {node.type}</span>
                </button>
              );
            })
          )}
          {directChildren.map((child) => {
            // Children indent under the asset row: 32px when we have
            // explicit owners (asset at level 1), or past the full
            // ancestry chain otherwise.
            const indent = hasExplicitOwners ? 32 : chain.length * 14;
            return (
              <button
                key={child.id}
                onClick={() => setLocation(`/profiles/${child.id}`)}
                className="flex items-center gap-1.5 w-full text-left rounded px-1 py-1 hover:bg-muted text-muted-foreground"
                style={{ paddingLeft: indent + 4 }}
                data-testid={`tree-child-${child.id}`}
              >
                <span className="opacity-50">└─</span>
                <span className="truncate">{child.name}</span>
                <span className="text-[11px] opacity-60 capitalize">· {child.type}</span>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// AssetSummaryCard — answers the four core questions on Overview at-a-glance
// "What is it? Who owns it? What's it inside? What's inside it?"
// ---------------------------------------------------------------------------

export function AssetSummaryCard({
  profile,
  allProfiles,
  treeData,
}: {
  profile: AnyProfile;
  allProfiles: AnyProfile[];
  treeData?: TreeNodeLite | null;
}) {
  const [, setLocation] = useLocation();
  const owner = findOwner(profile, allProfiles);
  const parentId =
    profile.parentProfileId;
  const parent = parentId
    ? allProfiles.find((p) => p.id === parentId)
    : null;
  const descendants = flattenTree(treeData);
  // "Own" rollup = THIS asset only (no descendants). "Full" rollup = with
  // descendants. We surface OWN values on the Overview Summary so the user
  // doesn't see Bob's whole net worth bleeding into a single asset card.
  // The full rollup lives on the Financials tab.
  const ownRollup = computeAssetRollup(profile as any, []);
  const fullRollup = computeAssetRollup(profile as any, descendants as any);
  const directChildren = (treeData?.children || []).filter((c) =>
    NESTED_ASSET_TYPES.includes(c.type),
  );

  // Heuristic warning: if a child is ≥5x the asset's own value, the
  // parent→child relationship is almost certainly reversed (e.g. Home
  // accidentally nested under a Gaming PC). Surface a banner that links
  // the user to the Contained tab where they can fix it.
  const reversedSuspect = useMemo(() => {
    if (ownRollup.totalValue <= 0) return null;
    for (const c of directChildren) {
      const cv =
        Number(
          (c.fields as any)?.currentValue ??
            (c.fields as any)?.value ??
            (c.fields as any)?.purchasePrice ??
            (c.fields as any)?.balance ??
            0,
        ) || 0;
      if (cv >= ownRollup.totalValue * 5) {
        return { name: c.name, id: c.id, value: cv };
      }
    }
    return null;
  }, [directChildren, ownRollup.totalValue]);

  const switchToContained = () => {
    const el = document.querySelector(
      '[data-testid="tab-contained"]',
    ) as HTMLButtonElement | null;
    if (el) el.click();
  };

  return (
    <Card data-testid="card-asset-summary">
      <CardContent className="p-4 space-y-3">
        {/* Owner + parent */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="micro-label text-muted-foreground font-medium">
              Owner
            </p>
            {owner ? (
              <button
                className="text-sm font-semibold hover:underline text-left flex items-center gap-1"
                onClick={() => setLocation(`/profiles/${owner.id}`)}
                data-testid="summary-owner"
              >
                {owner.name}
                <ArrowUpRight className="h-3 w-3 opacity-60" />
              </button>
            ) : (
              <p className="text-sm font-semibold text-muted-foreground italic">
                Unassigned
              </p>
            )}
          </div>
          <div>
            <p className="micro-label text-muted-foreground font-medium">
              Inside
            </p>
            {parent ? (
              <button
                className="text-sm font-semibold hover:underline text-left flex items-center gap-1"
                onClick={() => setLocation(`/profiles/${parent.id}`)}
                data-testid="summary-parent"
              >
                {parent.name}
                <ArrowUpRight className="h-3 w-3 opacity-60" />
              </button>
            ) : (
              <p className="text-sm font-semibold text-muted-foreground italic">
                Top level
              </p>
            )}
          </div>
        </div>

        {/* Financials trio — THIS asset only (not the rollup). The full
            rollup including children lives on the Financials tab. */}
        <div className="grid grid-cols-3 gap-2 pt-2 border-t">
          <div className="text-center">
            <p className="text-base font-bold tabular-nums text-green-600 dark:text-green-400" data-testid="summary-own-value">
              {formatCurrency(ownRollup.totalValue)}
            </p>
            <p className="text-[11px] text-muted-foreground">Value</p>
          </div>
          <div className="text-center">
            <p className="text-base font-bold tabular-nums text-red-500" data-testid="summary-own-liabilities">
              {ownRollup.totalLoans > 0
                ? `-${formatCurrency(ownRollup.totalLoans)}`
                : "—"}
            </p>
            <p className="text-[11px] text-muted-foreground">Liabilities</p>
          </div>
          <div className="text-center">
            <p
              className={`text-base font-bold tabular-nums ${
                ownRollup.netValue >= 0
                  ? "text-green-600 dark:text-green-400"
                  : "text-red-500"
              }`}
              data-testid="summary-own-net"
            >
              {formatCurrency(ownRollup.netValue)}
            </p>
            <p className="text-[11px] text-muted-foreground">Net</p>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground text-center -mt-1">
          This asset only. See Financials tab for the full rollup including children.
        </p>

        {/* Count info + rollup hint */}
        {(directChildren.length > 0 || fullRollup.descendantCount > 0) && (
          <button
            onClick={switchToContained}
            className="w-full text-[11px] text-muted-foreground text-center hover:underline pt-1"
            data-testid="summary-children-count"
          >
            Contains {directChildren.length} direct ·{" "}
            {fullRollup.descendantCount} total nested
            {fullRollup.totalValue > ownRollup.totalValue && (
              <>
                {" · +"}
                {formatCurrency(fullRollup.totalValue - ownRollup.totalValue)}{" "}
                from children
              </>
            )}
          </button>
        )}

        {/* Reversed-parent warning */}
        {reversedSuspect && (
          <div
            className="flex items-start gap-2 p-2 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800"
            data-testid="reversed-parent-warning"
          >
            <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-semibold text-amber-900 dark:text-amber-200">
                Possible reversed parent
              </p>
              <p className="text-[11px] text-amber-800 dark:text-amber-300">
                {reversedSuspect.name} ({formatCurrency(reversedSuspect.value)}) is
                much larger than {profile.name}. It may have been nested the wrong
                way around. Open Contained to move it.
              </p>
              <button
                onClick={switchToContained}
                className="mt-1 text-[11px] font-semibold text-amber-900 dark:text-amber-200 hover:underline"
              >
                Open Contained →
              </button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// TopChildrenPreview — top 3 children w/ "view all" jump
// ---------------------------------------------------------------------------

export function TopChildrenPreview({
  profile,
  treeData,
  onSeeAll,
}: {
  profile: AnyProfile;
  treeData?: TreeNodeLite | null;
  onSeeAll: () => void;
}) {
  const [, setLocation] = useLocation();
  const directChildren = (treeData?.children || []).filter((c) =>
    NESTED_ASSET_TYPES.includes(c.type),
  );
  if (directChildren.length === 0) return null;

  // Top 3 by base value descending.
  const sorted = [...directChildren]
    .map((c) => ({
      c,
      v: (c.fields as any)?.currentValue || (c.fields as any)?.value || 0,
    }))
    .sort((a, b) => Number(b.v) - Number(a.v))
    .slice(0, 3);

  return (
    <Card data-testid="card-top-children">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Package className="h-4 w-4 text-muted-foreground" /> What's Inside
          </CardTitle>
          {directChildren.length > 3 && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs gap-1"
              onClick={onSeeAll}
              data-testid="button-see-all-children"
            >
              See all {directChildren.length}
              <ChevronRight className="h-3 w-3" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-1">
        {sorted.map(({ c, v }) => (
          <button
            key={c.id}
            onClick={() => setLocation(`/profiles/${c.id}`)}
            className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg border hover:bg-muted/30 transition-colors text-left min-h-[44px]"
            data-testid={`top-child-${c.id}`}
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{c.name}</p>
              <p className="text-[11px] text-muted-foreground capitalize">{c.type}</p>
            </div>
            {Number(v) > 0 && (
              <span className="text-xs font-semibold tabular-nums shrink-0">
                {formatCurrency(Number(v))}
              </span>
            )}
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          </button>
        ))}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Phase 7 — FinancialsBreakdown table
// ---------------------------------------------------------------------------

export function FinancialsBreakdown({
  profile,
  treeData,
}: {
  profile: AnyProfile;
  treeData?: TreeNodeLite | null;
}) {
  const [, setLocation] = useLocation();
  const descendants = flattenTree(treeData);
  const rollup = computeAssetRollup(profile as any, descendants as any);

  // Linked liabilities secured by this asset (e.g. an auto loan) live in the
  // liability_asset_links junction, NOT in the asset's own fields — so
  // computeAssetRollup (which only reads fields) can't see them and the Liab.
  // column would read "—". Fold the secured balances into the breakdown here so
  // Net reflects real equity. Display-only: the shared rollup is untouched.
  const { data: assetLiabLinks = [] } = useQuery<any[]>({
    queryKey: ["/api/assets", (profile as any).id, "liabilities"],
    queryFn: () => apiRequest("GET", `/api/assets/${(profile as any).id}/liabilities`).then((r) => r.json()),
    enabled: !!(profile as any).id,
  });
  const { data: allProfilesForLiab = [] } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then((r) => r.json()),
  });
  const linkedLiabRows = (assetLiabLinks || []).map((link: any) => {
    const lp = (allProfilesForLiab || []).find((p: any) => p.id === link.liabilityProfileId);
    if (!lp) return null;
    const f = lp.fields || {}; const fin = f.finance || {};
    const bal = Number(f.currentBalance ?? f.remainingBalance ?? f.loanBalance ?? f.balance ?? fin.remainingBalance ?? fin.loanBalance ?? fin.balance ?? 0);
    const pct = Number(link.ownershipPercentage ?? 100);
    return { id: lp.id, name: lp.name || "Liability", secured: (bal * pct) / 100 };
  }).filter(Boolean) as Array<{ id: string; name: string; secured: number }>;
  const linkedLiabTotal = linkedLiabRows.reduce((s, r) => s + r.secured, 0);
  const grandLiab = rollup.totalLoans + linkedLiabTotal;
  const grandNet = rollup.netValue - linkedLiabTotal;

  return (
    <Card data-testid="card-financials-breakdown">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Coins className="h-4 w-4 text-primary" /> Financial Breakdown
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left micro-label text-muted-foreground border-b">
                <th className="pb-2 font-medium">Item</th>
                <th className="pb-2 font-medium text-right">Value</th>
                <th className="pb-2 font-medium text-right">Liab.</th>
                <th className="pb-2 font-medium text-right">Net</th>
              </tr>
            </thead>
            <tbody>
              {rollup.breakdown.map((row: AssetRollupRow) => (
                <tr
                  key={row.id}
                  className={`border-b last:border-0 ${
                    row.isSelf ? "bg-primary/5 font-semibold" : "hover:bg-muted/30"
                  }`}
                  data-testid={`breakdown-row-${row.id}`}
                >
                  <td className="py-2">
                    <button
                      className="flex items-center gap-1 hover:underline text-left"
                      onClick={() => setLocation(`/profiles/${row.id}`)}
                      disabled={row.isSelf}
                      style={{ paddingLeft: row.depth * 12 }}
                    >
                      {row.depth > 0 && (
                        <span className="opacity-40">└</span>
                      )}
                      <span className="truncate">{row.name}</span>
                      <span className="text-[11px] text-muted-foreground capitalize">
                        ({row.type})
                      </span>
                    </button>
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {row.baseValue > 0 ? formatCurrency(row.baseValue) : "—"}
                  </td>
                  <td className="py-2 text-right tabular-nums text-red-500">
                    {row.baseLoans > 0 ? `-${formatCurrency(row.baseLoans)}` : "—"}
                  </td>
                  <td
                    className={`py-2 text-right tabular-nums font-medium ${
                      row.netValue >= 0
                        ? "text-green-600 dark:text-green-400"
                        : "text-red-500"
                    }`}
                  >
                    {formatCurrency(row.netValue)}
                  </td>
                </tr>
              ))}
              {/* Linked liabilities (loans this asset secures) — not in the
                  asset tree, so surfaced as their own rows and folded into the
                  totals below. */}
              {linkedLiabRows.map((r) => (
                <tr key={r.id} className="border-b last:border-0 hover:bg-muted/30" data-testid={`breakdown-liab-${r.id}`}>
                  <td className="py-2">
                    <button
                      className="flex items-center gap-1 hover:underline text-left"
                      onClick={() => setLocation(`/profiles/${r.id}`)}
                    >
                      <span className="opacity-40">⛓</span>
                      <span className="truncate">{r.name}</span>
                      <span className="text-[11px] text-muted-foreground">(loan)</span>
                    </button>
                  </td>
                  <td className="py-2 text-right tabular-nums">—</td>
                  <td className="py-2 text-right tabular-nums text-red-500">
                    {r.secured > 0 ? `-${formatCurrency(r.secured)}` : "—"}
                  </td>
                  <td className="py-2 text-right tabular-nums font-medium text-red-500">
                    {r.secured > 0 ? `-${formatCurrency(r.secured)}` : "—"}
                  </td>
                </tr>
              ))}
              <tr className="font-bold border-t-2">
                <td className="pt-2">Total</td>
                <td className="pt-2 text-right tabular-nums text-green-600 dark:text-green-400">
                  {formatCurrency(rollup.totalValue)}
                </td>
                <td className="pt-2 text-right tabular-nums text-red-500">
                  {grandLiab > 0
                    ? `-${formatCurrency(grandLiab)}`
                    : "—"}
                </td>
                <td
                  className={`pt-2 text-right tabular-nums ${
                    grandNet >= 0
                      ? "text-green-600 dark:text-green-400"
                      : "text-red-500"
                  }`}
                >
                  {formatCurrency(grandNet)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        {rollup.monthlyExpense > 0 && (
          <p className="text-[11px] text-muted-foreground mt-3">
            Recurring monthly cost across this tree:{" "}
            <span className="font-semibold tabular-nums">
              {formatCurrency(rollup.monthlyExpense)}/mo
            </span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Phase 6 — Owner field + countToward toggle + mismatch banner
// ---------------------------------------------------------------------------

// OwnerControl now delegates to the redesigned, percentage-based OwnershipEditor
// (sliders + manual % + live 100% validation + history). The old single-owner
// picker and the "Counts toward: Owner's net worth / Parent chain" toggle are
// gone: net worth is driven purely by the explicit ownership shares, and an
// asset with no owners belongs to Self at 100%. Nesting is location-only.
export function OwnerControl({
  profile,
  allProfiles,
  onSaved,
}: {
  profile: AnyProfile;
  allProfiles: AnyProfile[];
  onSaved: () => void;
}) {
  return <OwnershipEditor profile={profile as any} allProfiles={allProfiles as any} onSaved={onSaved} />;
}

// ---------------------------------------------------------------------------
// Phase 1 — Adopt-as-Child dialog (replaces ambiguous "Link Existing")
// Adds per-row preview + two-step confirm. Cycle-block client-side too.
// ---------------------------------------------------------------------------

export function AdoptAsChildDialog({
  profile,
  open,
  onOpenChange,
  onAdopted,
}: {
  profile: AnyProfile;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdopted: () => void;
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);

  const { data: allProfiles } = useQuery<AnyProfile[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then((r) => r.json()),
    enabled: open,
  });

  const { data: subtree } = useQuery<TreeNodeLite>({
    queryKey: ["/api/profiles", profile.id, "tree"],
    queryFn: () =>
      apiRequest("GET", `/api/profiles/${profile.id}/tree`).then((r) => r.json()),
    enabled: open,
  });

  const descendantIds = useMemo(() => {
    const ids = new Set<string>();
    if (!subtree) return ids;
    const walk = (n: TreeNodeLite) => {
      for (const c of n.children || []) {
        ids.add(c.id);
        walk(c);
      }
    };
    walk(subtree);
    return ids;
  }, [subtree]);

  const candidates = useMemo(() => {
    if (!allProfiles) return [];
    return allProfiles
      .filter((p) => {
        if (!NESTED_ASSET_TYPES.includes(p.type)) return false;
        if (p.id === profile.id) return false;
        if (descendantIds.has(p.id)) return false;          // would create cycle
        if ((p.fields as any)?.deleted) return false;
        const parentId =
          p.parentProfileId;
        if (parentId === profile.id) return false;          // already child
        return true;
      })
      .filter((p) =>
        !search.trim()
          ? true
          : (p.name || "").toLowerCase().includes(search.toLowerCase()) ||
            (p.type || "").toLowerCase().includes(search.toLowerCase()),
      )
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }, [allProfiles, descendantIds, profile.id, search]);

  const previewCandidate = useMemo(
    () => candidates.find((c) => c.id === previewId) || null,
    [candidates, previewId],
  );

  const adoptMut = useMutation({
    mutationFn: async (childId: string) => {
      const res = await apiRequest("PATCH", `/api/profiles/${childId}`, {
        parentProfileId: profile.id,
      });
      return res.json();
    },
    onSuccess: (_d, childId) => {
      const c = candidates.find((p) => p.id === childId);
      toast({
        title: `"${c?.name || "Asset"}" is now a child of "${profile.name}"`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({
        queryKey: ["/api/profiles", profile.id, "detail"],
      });
      queryClient.invalidateQueries({
        queryKey: ["/api/profiles", profile.id, "tree"],
      });
      const oldParent =
        c?.parentProfileId;
      if (oldParent) {
        queryClient.invalidateQueries({
          queryKey: ["/api/profiles", oldParent, "detail"],
        });
      }
      setPreviewId(null);
      setSearch("");
      onOpenChange(false);
      onAdopted();
    },
    onError: (err: Error) =>
      toast({
        title: "Couldn't adopt",
        description: err.message,
        variant: "destructive",
      }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-sm max-h-[80vh] flex flex-col"
        data-testid="dialog-adopt-as-child"
      >
        <DialogHeader>
          <DialogTitle>Adopt an existing asset</DialogTitle>
          <DialogDescription>
            Pick an asset to <strong>become a child of "{profile.name}"</strong>.
            It will move under here in the ownership tree.
          </DialogDescription>
        </DialogHeader>

        {/* Two-step UX: list → preview → confirm */}
        {!previewCandidate ? (
          <div className="flex-1 overflow-hidden flex flex-col gap-2 min-h-0">
            <Input
              placeholder="Search assets..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-10 text-sm"
              data-testid="input-adopt-search"
            />
            <div
              className="flex-1 overflow-y-auto space-y-1 pr-1"
              data-testid="list-adopt-candidates"
            >
              {candidates.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-6">
                  {allProfiles ? "No eligible assets found" : "Loading..."}
                </p>
              ) : (
                candidates.map((p) => {
                  const parentRef = (allProfiles || []).find(
                    (x) => x.id === (p.parentProfileId),
                  );
                  return (
                    <button
                      key={p.id}
                      className="w-full text-left px-3 py-3 rounded-lg text-xs hover:bg-muted transition-colors min-h-[44px] border"
                      onClick={() => setPreviewId(p.id)}
                      data-testid={`option-adopt-${p.id}`}
                    >
                      <p className="font-medium truncate">{p.name}</p>
                      <p className="text-[11px] text-muted-foreground capitalize mt-0.5">
                        {p.type}
                        {parentRef ? ` · currently under ${parentRef.name}` : " · top-level"}
                      </p>
                      <p className="text-[11px] text-primary mt-1">
                        <strong>{p.name}</strong> will become a child of{" "}
                        <strong>{profile.name}</strong>
                      </p>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col gap-3" data-testid="adopt-preview">
            <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
              <p className="micro-label text-muted-foreground">
                Confirm move
              </p>
              <p className="text-sm">
                <strong>{previewCandidate.name}</strong>{" "}
                <span className="capitalize text-muted-foreground">
                  ({previewCandidate.type})
                </span>{" "}
                will become a child of <strong>{profile.name}</strong>.
              </p>
              <p className="text-[11px] text-muted-foreground">
                It will no longer appear at the top of /linked. Its previous
                location will be cleared and rollups will update automatically.
              </p>
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          {previewCandidate ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-10"
                onClick={() => setPreviewId(null)}
                data-testid="button-adopt-back"
              >
                Back
              </Button>
              <Button
                size="sm"
                className="h-10"
                onClick={() => adoptMut.mutate(previewCandidate.id)}
                disabled={adoptMut.isPending}
                data-testid="button-adopt-confirm"
              >
                {adoptMut.isPending ? "Moving..." : "Confirm move"}
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-10"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Phase 4 — Per-row child actions: View / Edit / Move / Remove From Parent
// ---------------------------------------------------------------------------

export function ChildActionsMenu({
  child,
  parent,
  onChanged,
}: {
  child: AnyProfile;
  parent: AnyProfile;
  onChanged: () => void;
}) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [moveOpen, setMoveOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  // Where to put child when removed: the parent's owner (top of chain).
  // Falls back to null (top-level) if no owner can be found.
  const { data: allProfiles } = useQuery<AnyProfile[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then((r) => r.json()),
    enabled: confirmRemove,
  });
  const removeTarget = useMemo(() => {
    if (!allProfiles) return null;
    return findOwner(parent, allProfiles);
  }, [allProfiles, parent]);

  const removeMut = useMutation({
    mutationFn: async () => {
      const newParent = removeTarget?.id || null;
      const res = await apiRequest("PATCH", `/api/profiles/${child.id}`, {
        parentProfileId: newParent,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: `"${child.name}" removed from "${parent.name}"`,
        description: removeTarget
          ? `Re-parented to ${removeTarget.name}`
          : "Now top-level",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({
        queryKey: ["/api/profiles", parent.id, "detail"],
      });
      queryClient.invalidateQueries({
        queryKey: ["/api/profiles", parent.id, "tree"],
      });
      queryClient.invalidateQueries({
        queryKey: ["/api/profiles", child.id, "detail"],
      });
      setConfirmRemove(false);
      onChanged();
    },
    onError: (err: Error) =>
      toast({
        title: "Couldn't remove",
        description: err.message,
        variant: "destructive",
      }),
  });

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0"
            aria-label="Child actions"
            data-testid={`child-actions-${child.id}`}
            onClick={(e) => e.stopPropagation()}
          >
            <MoreVertical className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-44 p-1"
          align="end"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="w-full text-left text-xs px-2 py-2 rounded hover:bg-muted flex items-center gap-2 min-h-[36px]"
            onClick={() => setLocation(`/profiles/${child.id}`)}
            data-testid={`child-action-view-${child.id}`}
          >
            <Eye className="h-3.5 w-3.5" /> View
          </button>
          <button
            className="w-full text-left text-xs px-2 py-2 rounded hover:bg-muted flex items-center gap-2 min-h-[36px]"
            onClick={() => setLocation(`/profiles/${child.id}?edit=1`)}
            data-testid={`child-action-edit-${child.id}`}
          >
            <Pencil className="h-3.5 w-3.5" /> Edit
          </button>
          <button
            className="w-full text-left text-xs px-2 py-2 rounded hover:bg-muted flex items-center gap-2 min-h-[36px]"
            onClick={() => setMoveOpen(true)}
            data-testid={`child-action-move-${child.id}`}
          >
            <Move className="h-3.5 w-3.5" /> Move
          </button>
          <button
            className="w-full text-left text-xs px-2 py-2 rounded hover:bg-red-500/10 text-red-600 flex items-center gap-2 min-h-[36px]"
            onClick={() => setConfirmRemove(true)}
            data-testid={`child-action-remove-${child.id}`}
          >
            <Trash2 className="h-3.5 w-3.5" /> Remove from parent
          </button>
        </PopoverContent>
      </Popover>

      {/* Move dialog: reuse Adopt-as-Child but PATCHing the *child* to a new parent.
          We bound the picker to the child's perspective by passing it as `profile`. */}
      <MoveChildDialog
        child={child}
        currentParent={parent}
        open={moveOpen}
        onOpenChange={setMoveOpen}
        onMoved={onChanged}
      />

      {/* Confirm remove-from-parent */}
      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent data-testid="dialog-confirm-remove">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove "{child.name}" from "{parent.name}"?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget ? (
                <>
                  It will move to <strong>{removeTarget.name}</strong> (top of the
                  ownership chain) and appear at the top of <code>/linked</code>{" "}
                  again. No data is deleted.
                </>
              ) : (
                <>
                  It will become a top-level asset and appear at the top of{" "}
                  <code>/linked</code>. No data is deleted.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => removeMut.mutate()}
              data-testid="confirm-remove-button"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// MoveChildDialog — re-parent a child to a different parent. Same UX shape as
// AdoptAsChildDialog: search → preview → confirm.
// ---------------------------------------------------------------------------

function MoveChildDialog({
  child,
  currentParent,
  open,
  onOpenChange,
  onMoved,
}: {
  child: AnyProfile;
  currentParent: AnyProfile;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMoved: () => void;
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);

  const { data: allProfiles } = useQuery<AnyProfile[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then((r) => r.json()),
    enabled: open,
  });

  // Block parents that are descendants of `child` (avoid cycles).
  const { data: childTree } = useQuery<TreeNodeLite>({
    queryKey: ["/api/profiles", child.id, "tree"],
    queryFn: () =>
      apiRequest("GET", `/api/profiles/${child.id}/tree`).then((r) => r.json()),
    enabled: open,
  });
  const blockedIds = useMemo(() => {
    const ids = new Set<string>([child.id]);
    if (!childTree) return ids;
    const walk = (n: TreeNodeLite) => {
      for (const c of n.children || []) {
        ids.add(c.id);
        walk(c);
      }
    };
    walk(childTree);
    return ids;
  }, [child.id, childTree]);

  const candidates = useMemo(() => {
    if (!allProfiles) return [];
    return allProfiles
      .filter((p) => {
        if (blockedIds.has(p.id)) return false;
        if (p.id === currentParent.id) return false;
        if ((p.fields as any)?.deleted) return false;
        const isAsset = NESTED_ASSET_TYPES.includes(p.type);
        const isPerson = PERSON_TYPES.has(p.type);
        return isAsset || isPerson;
      })
      .filter((p) =>
        !search.trim()
          ? true
          : (p.name || "").toLowerCase().includes(search.toLowerCase()),
      )
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }, [allProfiles, blockedIds, currentParent.id, search]);

  const previewParent = candidates.find((c) => c.id === previewId) || null;

  // Old path = walk current parent up
  const oldChain = useMemo(
    () => (allProfiles ? walkAncestry(child, allProfiles) : []),
    [allProfiles, child],
  );
  const newChain = useMemo(() => {
    if (!previewParent || !allProfiles) return [] as AnyProfile[];
    return [...walkAncestry(previewParent, allProfiles), child];
  }, [previewParent, allProfiles, child]);

  const moveMut = useMutation({
    mutationFn: async () => {
      if (!previewParent) throw new Error("no parent");
      const res = await apiRequest("PATCH", `/api/profiles/${child.id}`, {
        parentProfileId: previewParent.id,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: `"${child.name}" moved to "${previewParent!.name}"`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({
        queryKey: ["/api/profiles", currentParent.id, "detail"],
      });
      queryClient.invalidateQueries({
        queryKey: ["/api/profiles", previewParent!.id, "detail"],
      });
      queryClient.invalidateQueries({
        queryKey: ["/api/profiles", child.id, "detail"],
      });
      setPreviewId(null);
      setSearch("");
      onOpenChange(false);
      onMoved();
    },
    onError: (err: Error) =>
      toast({
        title: "Couldn't move",
        description: err.message,
        variant: "destructive",
      }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-sm max-h-[80vh] flex flex-col"
        data-testid="dialog-move-child"
      >
        <DialogHeader>
          <DialogTitle>Move "{child.name}"</DialogTitle>
          <DialogDescription>
            Pick a new parent. Path preview will appear before you confirm.
          </DialogDescription>
        </DialogHeader>

        {!previewParent ? (
          <div className="flex-1 overflow-hidden flex flex-col gap-2 min-h-0">
            <Input
              placeholder="Search assets or people..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-10 text-sm"
              data-testid="input-move-search"
            />
            <div className="flex-1 overflow-y-auto space-y-1 pr-1">
              {candidates.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-6">
                  {allProfiles ? "No eligible parents" : "Loading..."}
                </p>
              ) : (
                candidates.map((p) => (
                  <button
                    key={p.id}
                    className="w-full text-left px-3 py-3 rounded-lg text-xs hover:bg-muted min-h-[44px] border"
                    onClick={() => setPreviewId(p.id)}
                    data-testid={`option-move-${p.id}`}
                  >
                    <p className="font-medium truncate">{p.name}</p>
                    <p className="text-[11px] text-muted-foreground capitalize">
                      {p.type}
                    </p>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col gap-3" data-testid="move-preview">
            <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
              <p className="micro-label text-muted-foreground">
                Current path
              </p>
              <p className="text-xs line-through opacity-60">
                {oldChain.map((n) => n.name).join(" > ")}
              </p>
              <p className="micro-label text-muted-foreground pt-1">
                New path
              </p>
              <p className="text-sm font-semibold text-primary">
                {newChain.map((n) => n.name).join(" > ")}
              </p>
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          {previewParent ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-10"
                onClick={() => setPreviewId(null)}
              >
                Back
              </Button>
              <Button
                size="sm"
                className="h-10"
                onClick={() => moveMut.mutate()}
                disabled={moveMut.isPending}
                data-testid="button-move-confirm"
              >
                {moveMut.isPending ? "Moving..." : "Confirm move"}
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-10"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// PathPreviewLine — small reusable line for any form that wants
// "Will be saved here: Terrance > House > Gaming PC > <new>"
// ---------------------------------------------------------------------------

export function PathPreviewLine({
  parent,
  allProfiles,
  childName,
}: {
  parent: AnyProfile | null;
  allProfiles: AnyProfile[];
  childName?: string;
}) {
  if (!parent) {
    return (
      <p className="text-[11px] text-muted-foreground">
        Will be saved at the top level
        {childName ? <> as <strong>{childName}</strong></> : ""}.
      </p>
    );
  }
  const chain = walkAncestry(parent, allProfiles);
  const path = chain.map((n) => n.name).join(" > ");
  return (
    <p
      className="text-[11px] text-muted-foreground"
      data-testid="path-preview"
    >
      Will be saved at:{" "}
      <span className="text-foreground font-medium">{path}</span>
      {childName ? (
        <>
          {" > "}
          <strong>{childName}</strong>
        </>
      ) : null}
    </p>
  );
}
