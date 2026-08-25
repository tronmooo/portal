// ── /profiles/list — the profiles index ──────────────────────────────────────
// The hub switcher only surfaces people, and /profiles resolves to the Self
// profile's Info tab, so there was no page that simply listed everything you
// own and everyone you track. /profiles/list used to 404. It reads the same
// lite endpoint the switcher and route dispatcher share, so it costs nothing
// extra once any of them has loaded.
//
// It is also where profiles get REMOVED. Deleting used to mean opening each
// profile and using the Delete button on its header, which is fine for one
// mistake and useless for clearing out five people you no longer track. Select
// mode turns this index into a multi-select: tick the profiles, confirm once,
// and the server cascades each one — the profile, its child profiles, and
// every expense, task, habit, tracker, event, document and note that hung off
// them. That is the "older data disappears" part; it is not a hide.
import { useState, useMemo, useEffect } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Search, Users, Trash2, X } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { BubbleSkeletonGrid } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { invalidateDomains } from "@/lib/cache-bus";
import { formatApiError } from "@/lib/formatError";

interface LiteProfile {
  id: string;
  name: string;
  type: string;
  avatar?: string | null;
}

// Groups are rendered in this order; anything with an unlisted type falls into
// "Other" so a new profile type can never vanish from the index.
const GROUP_ORDER: { key: string; label: string; types: string[] }[] = [
  { key: "people", label: "People", types: ["self", "person"] },
  { key: "pets", label: "Pets", types: ["pet"] },
  { key: "property", label: "Property & Vehicles", types: ["property", "vehicle"] },
  { key: "assets", label: "Assets & Accounts", types: ["asset", "account", "investment", "business"] },
  { key: "money", label: "Liabilities & Subscriptions", types: ["loan", "liability", "subscription", "insurance"] },
  { key: "services", label: "Services", types: ["medical"] },
];

const TYPE_OF_GROUP = new Map<string, string>(
  GROUP_ORDER.flatMap(g => g.types.map(t => [t, g.key] as [string, string])),
);

interface BulkDeleteResult {
  success: boolean;
  deleted: { id: string; name: string }[];
  failed: { id: string; name: string; reason: string }[];
}

export default function ProfilesListPage() {
  const [search, setSearch] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { toast } = useToast();

  useEffect(() => { document.title = "Profiles — Portol"; }, []);

  const fullProfilesCache = queryClient.getQueryData<LiteProfile[]>(["/api/profiles"]);
  const { data: profiles, isLoading } = useQuery<LiteProfile[]>({
    queryKey: ["/api/profiles", "lite"],
    queryFn: async () => (await apiRequest("GET", "/api/profiles/lite")).json(),
    initialData: fullProfilesCache,
    staleTime: 30_000,
  });

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = (profiles || []).filter(p => !q || p.name?.toLowerCase().includes(q));
    const byGroup = new Map<string, LiteProfile[]>();
    for (const p of matches) {
      const key = TYPE_OF_GROUP.get(p.type) ?? "other";
      const bucket = byGroup.get(key);
      if (bucket) bucket.push(p); else byGroup.set(key, [p]);
    }
    const ordered = [...GROUP_ORDER, { key: "other", label: "Other", types: [] }];
    return ordered
      .map(g => ({ ...g, items: (byGroup.get(g.key) ?? []).sort((a, b) => a.name.localeCompare(b.name)) }))
      .filter(g => g.items.length > 0);
  }, [profiles, search]);

  const total = profiles?.length ?? 0;

  // Your own profile is the account's root — the hub switcher, /profiles and
  // most AI context resolve through it — so it is never selectable here. The
  // server refuses it too; this only keeps the UI honest about that.
  const isSelf = (p: LiteProfile) => p.type === "self";

  // Everything currently on screen that CAN be deleted, for "Select all".
  const selectableVisible = useMemo(
    () => groups.flatMap(g => g.items).filter(p => !isSelf(p)),
    [groups],
  );
  const allVisibleSelected =
    selectableVisible.length > 0 && selectableVisible.every(p => selected.has(p.id));

  // Names are resolved for the confirmation and the toast BEFORE the delete,
  // because after it the rows are gone from the list they'd be read from.
  const selectedProfiles = useMemo(
    () => (profiles || []).filter(p => selected.has(p.id)),
    [profiles, selected],
  );

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelected(new Set());
  }

  const deleteMutation = useMutation<BulkDeleteResult, Error, string[]>({
    mutationFn: async (ids: string[]) => {
      const res = await apiRequest("POST", "/api/profiles/bulk-delete", { ids });
      return res.json();
    },
    onSuccess: (result) => {
      const goneIds = new Set(result.deleted.map(d => d.id));
      // Drop the deleted rows from both cached shapes of the profile list so
      // the page settles immediately instead of after the refetch lands.
      const prune = (old: LiteProfile[] | undefined) =>
        old?.filter(p => !goneIds.has(p.id)) ?? old;
      queryClient.setQueryData(["/api/profiles", "lite"], prune);
      queryClient.setQueryData(["/api/profiles"], prune as any);

      if (result.deleted.length > 0) {
        const names = result.deleted.map(d => d.name).join(", ");
        toast({
          title: result.deleted.length === 1
            ? `Deleted ${result.deleted[0].name}`
            : `Deleted ${result.deleted.length} profiles`,
          description: `${names} — and all linked data — have been permanently removed.`,
        });
      }
      if (result.failed.length > 0) {
        toast({
          title: result.failed.length === 1 ? "One profile wasn't deleted" : `${result.failed.length} profiles weren't deleted`,
          description: result.failed.map(f => `${f.name}: ${f.reason}`).join(" · "),
          variant: "destructive",
        });
      }
      // A cascade reaches into nearly every table, so invalidate broadly
      // rather than guessing which domains this particular profile fed.
      invalidateDomains("everything");
      setConfirmOpen(false);
      exitSelectMode();
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: formatApiError(err), variant: "destructive" });
      setConfirmOpen(false);
    },
  });

  const selectedCount = selected.size;

  return (
    <PageContainer testId="page-profiles-list">
      <PageHeader
        title="Profiles"
        subtitle={selectMode
          ? `${selectedCount} selected`
          : `${total} ${total === 1 ? "profile" : "profiles"}`}
        icon={Users}
        accent="213 90% 62%"
        actions={
        <div className="flex items-center gap-2">
          <div className="relative sm:w-56">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search profiles"
              aria-label="Search profiles"
              className="pl-8 h-9"
              data-testid="input-profiles-search"
            />
          </div>
          {selectMode ? (
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1"
              onClick={exitSelectMode}
              data-testid="button-profiles-select-cancel"
            >
              <X className="h-3.5 w-3.5" /> Cancel
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1"
              onClick={() => setSelectMode(true)}
              disabled={total === 0}
              data-testid="button-profiles-select"
            >
              <Trash2 className="h-3.5 w-3.5" /> Select
            </Button>
          )}
        </div>
        }
      />

      {selectMode && (
        <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2 mb-4">
          <p className="text-xs text-muted-foreground">
            Pick the profiles to remove. Deleting one also deletes everything linked to it.
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs shrink-0"
            disabled={selectableVisible.length === 0}
            onClick={() => setSelected(prev => {
              if (allVisibleSelected) {
                const next = new Set(prev);
                for (const p of selectableVisible) next.delete(p.id);
                return next;
              }
              const next = new Set(prev);
              for (const p of selectableVisible) next.add(p.id);
              return next;
            })}
            data-testid="button-profiles-select-all"
          >
            {allVisibleSelected ? "Clear all" : "Select all"}
          </Button>
        </div>
      )}

      {isLoading && <BubbleSkeletonGrid count={4} rows={1} height={92} />}

      {!isLoading && groups.length === 0 && (
        <p className="text-sm text-muted-foreground py-8 text-center">
          {total === 0 ? "No profiles yet." : `No profiles match "${search}".`}
        </p>
      )}

      <div className={`space-y-6 ${selectMode && selectedCount > 0 ? "pb-24" : ""}`}>
        {groups.map(group => (
          <section key={group.key} data-testid={`profiles-group-${group.key}`}>
            <h2 className="micro-label text-muted-foreground mb-2">
              {group.label}
            </h2>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {group.items.map(p => {
                const self = isSelf(p);
                const checked = selected.has(p.id);
                const body = (
                  <Card
                    className={`p-3 flex items-center gap-3 transition-colors ${
                      selectMode
                        ? self
                          ? "opacity-60"
                          : `cursor-pointer ${checked ? "bg-destructive/10 border-destructive/40" : "hover:bg-accent/50"}`
                        : "hover:bg-accent/50 cursor-pointer"
                    }`}
                    onClick={selectMode && !self ? () => toggle(p.id) : undefined}
                    data-testid={`profile-card-${p.id}`}
                  >
                    {selectMode && (
                      <Checkbox
                        checked={checked}
                        disabled={self}
                        onCheckedChange={() => !self && toggle(p.id)}
                        onClick={e => e.stopPropagation()}
                        aria-label={self ? `${p.name} (your own profile, can't be deleted)` : `Select ${p.name}`}
                        data-testid={`checkbox-profile-${p.id}`}
                      />
                    )}
                    <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-xs font-bold shrink-0 overflow-hidden">
                      {p.avatar
                        ? <img src={p.avatar} alt="" className="h-full w-full object-cover" />
                        : (p.name?.charAt(0).toUpperCase() || "?")}
                    </div>
                    <span className="text-sm font-medium truncate flex-1">{p.name}</span>
                    <Badge variant="secondary" className="text-[11px] h-5 capitalize shrink-0">
                      {selectMode && self ? "you" : p.type}
                    </Badge>
                  </Card>
                );
                // In select mode the card selects instead of navigating —
                // wrapping it in a Link would make every tick a page change.
                return selectMode
                  ? <div key={p.id}>{body}</div>
                  : <Link key={p.id} href={`/profiles/${p.id}`}>{body}</Link>;
              })}
            </div>
          </section>
        ))}
      </div>

      {/* Action bar — only once something is actually selected, so it never
          covers the list for nothing. */}
      {selectMode && selectedCount > 0 && (
        <div className="fixed bottom-0 inset-x-0 z-40 border-t bg-background/95 backdrop-blur px-4 py-3">
          <div className="mx-auto max-w-5xl flex items-center justify-between gap-3">
            <span className="text-sm font-medium" data-testid="text-profiles-selected-count">
              {selectedCount} selected
            </span>
            <Button
              variant="destructive"
              size="sm"
              className="gap-1.5"
              onClick={() => setConfirmOpen(true)}
              data-testid="button-profiles-bulk-delete"
            >
              <Trash2 className="h-4 w-4" />
              Delete {selectedCount === 1 ? "profile" : `${selectedCount} profiles`}
            </Button>
          </div>
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={o => !deleteMutation.isPending && setConfirmOpen(o)}>
        <AlertDialogContent data-testid="dialog-confirm-bulk-delete">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {selectedCount === 1
                ? `Delete "${selectedProfiles[0]?.name ?? ""}"?`
                : `Delete ${selectedCount} profiles?`}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  This permanently removes {selectedCount === 1 ? "this profile" : "these profiles"} and
                  everything linked to {selectedCount === 1 ? "it" : "them"} — expenses, tasks, habits,
                  trackers, events, documents, notes and any nested assets, accounts or subscriptions.
                  It cannot be undone.
                </p>
                {selectedCount > 1 && (
                  <ul className="text-xs list-disc pl-4 max-h-32 overflow-y-auto">
                    {selectedProfiles.slice(0, 12).map(p => (
                      <li key={p.id}>{p.name} <span className="capitalize opacity-70">({p.type})</span></li>
                    ))}
                    {selectedProfiles.length > 12 && (
                      <li>and {selectedProfiles.length - 12} more</li>
                    )}
                  </ul>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending} data-testid="button-cancel-bulk-delete">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={e => {
                // Keep the dialog up while the cascade runs — closing it on
                // click would leave a long delete with no visible progress.
                e.preventDefault();
                deleteMutation.mutate([...selected]);
              }}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-bulk-delete"
            >
              {deleteMutation.isPending
                ? "Deleting..."
                : selectedCount === 1 ? "Delete profile" : `Delete ${selectedCount} profiles`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  );
}
