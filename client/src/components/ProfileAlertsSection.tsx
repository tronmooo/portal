// client/src/components/ProfileAlertsSection.tsx
//
// The bottom of a profile's Info tab: the two things you do TO a record rather
// than to its contents — clear the alerts it is producing, or delete it.
//
// USER REPORT (2026-08-26): "there's gotta be a way that you can clear this as
// well — clear the notification — in the info tab there should be a button all
// the way down where it says delete this person."
//
// Clearing was previously only reachable per row, inside an expanded card in a
// dashboard popup. A record that keeps announcing an expired date needs one
// obvious place to say "stop telling me", next to the other decisions you make
// about the record itself.
//
// A cleared alert is a 30-day snooze, not a deletion: the date stays on the
// document, the countdown keeps running, and Restore brings it back
// immediately. Snoozes are keyed by document id, which every document-dates
// surface honours alongside the per-rule key (lib/docSnooze).

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BellOff, Bell, Trash2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { loadDocSnoozeMap, saveDocSnoozeMap } from "@/lib/docSnooze";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

const SNOOZE_MS = 30 * 86400000;

/** "person" for people, otherwise the record's own noun ("vehicle", "property"). */
export function recordNoun(type: string | undefined): string {
  const t = String(type || "").replace(/_/g, " ").trim();
  if (!t || t === "self" || t === "person") return "person";
  return t;
}

export function ProfileAlertsSection({
  profileId,
  profileType,
  onDelete,
}: {
  profileId: string;
  profileType?: string;
  /** Opens the existing delete confirmation — this section never deletes directly. */
  onDelete: () => void;
}) {
  const { toast } = useToast();
  const [snoozeMap, setSnoozeMap] = useState<Record<string, number>>(() => loadDocSnoozeMap());

  // The documents this record carries — the things producing its date alerts.
  const { data: docs = [] } = useQuery<any[]>({
    queryKey: ["/api/profiles", profileId, "documents"],
    queryFn: () => apiRequest("GET", `/api/profiles/${profileId}/documents`).then((r) => r.json()),
    enabled: !!profileId,
    staleTime: 60_000,
  });

  const docIds = useMemo(
    () => (Array.isArray(docs) ? docs : []).map((d: any) => String(d?.id)).filter(Boolean),
    [docs],
  );
  const clearedCount = useMemo(
    () => docIds.filter((id) => snoozeMap[id] > Date.now()).length,
    [docIds, snoozeMap],
  );

  const clearAll = () => {
    if (docIds.length === 0) return;
    const until = Date.now() + SNOOZE_MS;
    const next = { ...snoozeMap };
    for (const id of docIds) next[id] = until;
    setSnoozeMap(next);
    saveDocSnoozeMap(next);
    toast({
      title: `Cleared alerts for ${docIds.length} document${docIds.length === 1 ? "" : "s"}`,
      description: "Hidden from document alerts for 30 days. The dates stay on the records.",
    });
  };

  const restoreAll = () => {
    const next = { ...snoozeMap };
    for (const id of docIds) delete next[id];
    setSnoozeMap(next);
    saveDocSnoozeMap(next);
    toast({ title: "Alerts restored", description: "This record's document dates are visible again." });
  };

  const noun = recordNoun(profileType);

  return (
    <div className="mt-6 bubble p-4 space-y-4" data-testid="profile-alerts-section">
      <div>
        <h3 className="micro-label text-muted-foreground">Alerts</h3>
        <p className="text-xs text-muted-foreground mt-1">
          {docIds.length === 0
            ? "No documents on this record, so nothing is producing date alerts."
            : clearedCount > 0
              ? `${clearedCount} of ${docIds.length} document${docIds.length === 1 ? "" : "s"} cleared. Dates stay on the records — only the alerts are hidden.`
              : `${docIds.length} document${docIds.length === 1 ? "" : "s"} can raise due and expiring alerts.`}
        </p>
        <div className="flex flex-wrap gap-2 mt-2.5">
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs gap-1.5"
            onClick={clearAll}
            disabled={docIds.length === 0}
            data-testid="button-clear-document-alerts"
          >
            <BellOff className="h-3.5 w-3.5" />
            Clear document alerts
          </Button>
          {clearedCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={restoreAll}
              data-testid="button-restore-document-alerts"
            >
              <Bell className="h-3.5 w-3.5" />
              Restore alerts
            </Button>
          )}
        </div>
      </div>

      <div className="pt-3 border-t border-border/60">
        <h3 className="micro-label text-muted-foreground">Danger zone</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Permanently removes this {noun} and everything filed under it. This cannot be undone.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs gap-1.5 mt-2.5 text-destructive hover:text-destructive border-destructive/40"
          onClick={onDelete}
          data-testid="button-delete-profile-info-tab"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete this {noun}
        </Button>
      </div>
    </div>
  );
}
