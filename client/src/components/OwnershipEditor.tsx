// ─────────────────────────────────────────────────────────────────────────────
// OwnershipEditor — the single, canonical control for fractional ownership.
//
// Replaces the old single-owner "Change Owner" dialog + "Counts toward /
// parent chain" toggle. Writes through the atomic, validated endpoint
// PUT /api/profiles/:id/owners (server uses shared/ownership-model). Uses the
// SAME model on the client for live validation, so the rules can never drift.
//
// Rules surfaced here (see shared/ownership-model.ts):
//   • Owners are explicit fractional shares; when any owner is set they MUST
//     total exactly 100%. Nothing is ever auto-split silently.
//   • With NO owners, the asset belongs to "Me" (Self) at 100% — shown as
//     "Ownership not set".
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateDomain } from "@/lib/cache-bus";
import { useToast } from "@/hooks/use-toast";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Users, Plus, X, Scale, History, Check, Loader2 } from "lucide-react";
import {
  validateOwnership,
  distributeEvenly,
  roundPct,
  type OwnershipLink,
} from "@shared/ownership-model";
import { APP_LOCALE } from "@/lib/format";

interface Row {
  partyProfileId: string;
  pct: number;
}

const PERSON_TYPES = new Set(["self", "person", "pet"]);

export function OwnershipEditor({
  profile,
  allProfiles,
  onSaved,
  kind = "asset",
}: {
  profile: { id: string; name?: string; type?: string; parentProfileId?: string | null };
  allProfiles: Array<{ id: string; name?: string; type?: string; fields?: any; parentProfileId?: string | null }>;
  onSaved?: () => void;
  /**
   * Which junction table this editor manages. "asset" → asset_party_links via
   * PUT /api/profiles/:id/owners (asset analogue). "liability" →
   * liability_profile_links via PUT /api/profiles/:id/liability-owners. Both
   * endpoints atomically replace the OWNER-role set and validate that it
   * totals exactly 100% — the only safe way to mutate ownership under the
   * post-2026-06-05 model (where the DB-side guard rejects partial states
   * whose sum exceeds 100). Defaults to "asset" for backward compatibility
   * with existing call sites.
   */
  kind?: "asset" | "liability";
}) {
  const { toast } = useToast();
  const [showHistory, setShowHistory] = useState(false);

  // Candidate owners: people/pets (and Self), never the asset itself.
  const candidates = useMemo(
    () =>
      allProfiles
        .filter((p) => PERSON_TYPES.has(p.type || "") && p.id !== profile.id && !(p.fields as any)?.deleted)
        .sort((a, b) => (a.name || "").localeCompare(b.name || "")),
    [allProfiles, profile.id],
  );
  const selfProfile = useMemo(() => allProfiles.find((p) => p.type === "self"), [allProfiles]);
  const nameFor = (id: string) => candidates.find((c) => c.id === id)?.name || selfProfile?.name || "Unknown";
  // The profile this asset is NESTED under (location), if that container is a
  // person/pet. Nesting is NOT ownership — but it's the most likely intended
  // owner, so we offer a one-click way to assign them.
  const parentPerson = useMemo(
    () => (profile.parentProfileId ? candidates.find((c) => c.id === profile.parentProfileId) : undefined),
    [candidates, profile.parentProfileId],
  );

  // Current owner links for this asset/liability. Asset and liability links
  // live in different junction tables; pick the right endpoint and the right
  // foreign-key field per kind.
  const linksEndpoint = kind === "liability" ? "/api/liability-profile-links" : "/api/asset-party-links";
  const linkSubjectField = kind === "liability" ? "liabilityProfileId" : "assetProfileId";
  const { data: allLinks = [] } = useQuery<any[]>({
    queryKey: [linksEndpoint],
    queryFn: () => apiRequest("GET", linksEndpoint).then((r) => r.json()),
  });
  const savedRows: Row[] = useMemo(() => {
    return (allLinks || [])
      .filter((l) => l[linkSubjectField] === profile.id && ["owner", "co_owner", "co-owner"].includes(String(l.role || "owner").toLowerCase()))
      .map((l) => ({ partyProfileId: l.partyProfileId, pct: roundPct(Number(l.ownershipPercentage ?? 0)) }));
  }, [allLinks, profile.id, linkSubjectField]);

  // Editable draft overlaid on the saved state. `null` = no local edits (show
  // saved). Whenever the saved set changes (initial load, after save, external
  // update), drop local edits so we reflect server truth.
  const [draft, setDraft] = useState<Row[] | null>(null);
  const currentSeedKey = savedRows.map((r) => `${r.partyProfileId}:${r.pct}`).join("|");
  useEffect(() => {
    setDraft(null);
  }, [currentSeedKey]);
  const rows: Row[] = draft ?? savedRows;

  const setRows = (next: Row[]) => setDraft(next);
  const resetDraft = () => setDraft(null);

  const total = roundPct(rows.reduce((s, r) => s + (Number(r.pct) || 0), 0));
  const asLinks: OwnershipLink[] = rows.map((r) => ({ partyProfileId: r.partyProfileId, ownershipPercentage: r.pct, role: "owner" }));
  const validation = validateOwnership(asLinks);
  const dirty = JSON.stringify(rows) !== JSON.stringify(savedRows);

  const updatePct = (idx: number, pct: number) => {
    const clamped = Math.max(0, Math.min(100, roundPct(pct)));
    setRows(rows.map((r, i) => (i === idx ? { ...r, pct: clamped } : r)));
  };
  const removeRow = (idx: number) => setRows(rows.filter((_, i) => i !== idx));
  const addOwner = (partyProfileId: string) => {
    if (!partyProfileId || rows.some((r) => r.partyProfileId === partyProfileId)) return;
    const remaining = Math.max(0, roundPct(100 - total));
    setRows([...rows, { partyProfileId, pct: remaining }]);
  };
  const splitEvenly = () => {
    if (rows.length === 0) return;
    const split = distributeEvenly(rows.length);
    setRows(rows.map((r, i) => ({ ...r, pct: split[i] })));
  };

  const saveMut = useMutation({
    mutationFn: async () => {
      const owners = rows.map((r) => ({ partyProfileId: r.partyProfileId, ownershipPercentage: r.pct }));
      const path = kind === "liability"
        ? `/api/profiles/${profile.id}/liability-owners`
        : `/api/profiles/${profile.id}/owners`;
      const res = await apiRequest("PUT", path, { owners });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Ownership updated" });
      resetDraft();
      // Recalculate everything that depends on ownership. We invalidate BOTH
      // junction-table queries so the editor refreshes cleanly even if a page
      // is reading both tables (e.g. Linked filter logic).
      queryClient.invalidateQueries({ queryKey: ["/api/asset-party-links"] });
      queryClient.invalidateQueries({ queryKey: ["/api/liability-profile-links"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profile.id, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ownership-history"] });
      // Co-ownership changes which rows every scoped list holds (a person's
      // tasks, bills, documents, trackers, budgets and the dashboard seeds all
      // widen with the assets and loans they co-own), so the whole cache
      // ripples — not just the profile keys above.
      void invalidateDomain("everything");
      // Liability detail page reads from these:
      if (kind === "liability") {
        queryClient.invalidateQueries({ queryKey: ["/api/liabilities", profile.id, "parties"] });
      } else {
        queryClient.invalidateQueries({ queryKey: ["/api/assets", profile.id, "parties"] });
      }
      onSaved?.();
    },
    onError: (err: Error) => toast({ title: "Couldn't save ownership", description: err.message, variant: "destructive" }),
  });

  const availableToAdd = candidates.filter((c) => !rows.some((r) => r.partyProfileId === c.id));
  const unconfigured = rows.length === 0;

  return (
    <Card data-testid="card-ownership-editor">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" /> Ownership
          </span>
          <span
            className={`text-sm font-bold tabular-nums px-2.5 py-1 rounded-full ${
              unconfigured
                ? "bg-muted text-muted-foreground"
                : validation.valid
                  ? "bg-green-500/15 text-green-600 dark:text-green-400"
                  : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
            }`}
            data-testid="ownership-total"
          >
            {unconfigured ? "Not set" : `${total}%`}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {parentPerson && (
          <p className="text-[11px] text-muted-foreground" data-testid="ownership-parent-note">
            Filed under <span className="font-medium text-foreground">{parentPerson.name}</span> — that's
            location, not ownership.{" "}
            {!(rows.length === 1 && rows[0].partyProfileId === parentPerson.id && rows[0].pct === 100) && (
              <button
                className="text-primary hover:underline font-medium"
                onClick={() => setRows([{ partyProfileId: parentPerson.id, pct: 100 }])}
                data-testid="ownership-assign-parent"
              >
                Assign {parentPerson.name} 100%
              </button>
            )}
          </p>
        )}
        {unconfigured && (
          <p className="text-xs text-muted-foreground" data-testid="ownership-default-note">
            Ownership not set — this counts toward{" "}
            <span className="font-medium text-foreground">{selfProfile?.name || "you"}</span> at 100%.
            Add owners below to split it.
          </p>
        )}

        {rows.map((row, idx) => (
          <div key={row.partyProfileId} className="flex items-center gap-2" data-testid={`owner-row-${row.partyProfileId}`}>
            <span className="text-xs font-medium w-24 truncate" title={nameFor(row.partyProfileId)}>
              {nameFor(row.partyProfileId)}
            </span>
            <Slider
              value={[row.pct]}
              min={0}
              max={100}
              step={1}
              onValueChange={(v) => updatePct(idx, v[0])}
              className="flex-1"
              data-testid={`owner-slider-${row.partyProfileId}`}
            />
            {/* Big, always-legible percentage with an inline editable field. */}
            <div className="flex items-center gap-1 shrink-0">
              <Input
                type="number"
                min={0}
                max={100}
                value={String(row.pct)}
                onChange={(e) => updatePct(idx, Number(e.target.value))}
                className="h-9 w-16 text-base font-semibold text-center tabular-nums px-1 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                data-testid={`owner-input-${row.partyProfileId}`}
              />
              <span className="text-base font-semibold text-muted-foreground w-3">%</span>
            </div>
            <button
              onClick={() => removeRow(idx)}
              className="p-1 rounded-md hover:bg-muted text-muted-foreground shrink-0"
              aria-label={`Remove ${nameFor(row.partyProfileId)}`}
              data-testid={`owner-remove-${row.partyProfileId}`}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}

        {/* Validation message */}
        {!unconfigured && !validation.valid && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400" data-testid="ownership-error">
            {validation.errors[0]}
          </p>
        )}

        {/* Add owner + split evenly */}
        <div className="flex flex-wrap items-center gap-2">
          {availableToAdd.length > 0 && (
            <select
              className="h-8 text-xs bg-background border border-border rounded-md px-2 max-w-[160px]"
              value=""
              onChange={(e) => addOwner(e.target.value)}
              data-testid="owner-add-select"
            >
              <option value="">+ Add owner…</option>
              {availableToAdd.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.type === "self" ? "me" : c.type})
                </option>
              ))}
            </select>
          )}
          {rows.length > 1 && (
            <Button variant="ghost" size="sm" className="h-8 text-xs gap-1" onClick={splitEvenly} data-testid="owner-split-evenly">
              <Scale className="h-3 w-3" /> Split evenly
            </Button>
          )}
          {rows.length > 0 && (
            <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground" onClick={() => setRows([])} data-testid="owner-clear">
              Clear
            </Button>
          )}
        </div>

        {/* Save / reset */}
        {dirty && (
          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              className="h-8 text-xs gap-1"
              disabled={!validation.valid || saveMut.isPending}
              onClick={() => saveMut.mutate()}
              data-testid="owner-save"
            >
              {saveMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              Save ownership
            </Button>
            <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={resetDraft} disabled={saveMut.isPending} data-testid="owner-reset">
              Reset
            </Button>
          </div>
        )}

        {/* History / audit trail */}
        <button
          onClick={() => setShowHistory((s) => !s)}
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          data-testid="owner-history-toggle"
        >
          <History className="h-3 w-3" /> {showHistory ? "Hide" : "Show"} ownership history
        </button>
        {showHistory && <OwnershipHistory subjectId={profile.id} nameFor={(id) => candidates.find((c) => c.id === id)?.name || selfProfile?.name || id.slice(0, 6)} />}
      </CardContent>
    </Card>
  );
}

// An audit trail, deliberately capped — but a capped list that does not say so
// reads as the whole history, and "there are only 25 changes on record" is a
// different statement from "here are the last 25".
const OWNERSHIP_HISTORY_LIMIT = 25;

function OwnershipHistory({ subjectId, nameFor }: { subjectId: string; nameFor: (id: string) => string }) {
  const { data: history = [], isLoading } = useQuery<any[]>({
    queryKey: ["/api/ownership-history", subjectId],
    queryFn: () => apiRequest("GET", `/api/ownership-history?subjectId=${subjectId}&limit=${OWNERSHIP_HISTORY_LIMIT}`).then((r) => r.json()),
  });
  if (isLoading) return <p className="text-[11px] text-muted-foreground">Loading history…</p>;
  if (!history.length) return <p className="text-[11px] text-muted-foreground">No ownership changes recorded yet.</p>;
  const describe = (h: any): string => {
    const who = nameFor(h.counterpartyId || "");
    if (h.action === "create") return `Added ${who}`;
    if (h.action === "delete") return `Removed ${who}`;
    if (h.action === "update" && h.fieldChanged === "ownership_percentage") return `${who}: ${h.oldValue}% → ${h.newValue}%`;
    if (h.action === "update") return `${who}: ${h.fieldChanged} changed`;
    return `${h.action} ${who}`;
  };
  return (
    <ul className="space-y-1 border-l border-border pl-3" data-testid="ownership-history-list">
      {history.map((h: any) => (
        <li key={h.id} className="text-[11px] text-muted-foreground flex items-baseline justify-between gap-2">
          <span className="text-foreground/80">{describe(h)}</span>
          <span className="tabular-nums shrink-0">{h.changedAt ? new Date(h.changedAt).toLocaleDateString(APP_LOCALE) : ""}</span>
        </li>
      ))}
      {history.length >= OWNERSHIP_HISTORY_LIMIT && (
        <li className="text-[11px] text-muted-foreground/70 italic pt-0.5" data-testid="ownership-history-truncated">
          Showing the {OWNERSHIP_HISTORY_LIMIT} most recent changes.
        </li>
      )}
    </ul>
  );
}
