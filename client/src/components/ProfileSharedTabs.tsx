/**
 * Shared tab components used by both asset and liability profile pages.
 * Extracted here to avoid circular imports between profile-detail.tsx and
 * liability-detail.tsx.
 */

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Clock, RefreshCw, Share2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatApiError } from "@/lib/formatError";
import { hashNavigate } from "@/lib/hashNavigate";

// ─── Connections Tab (radial SVG graph) ──────────────────────────────────────

export function ConnectionsTab({ profileId }: { profileId: string }) {
  const [hops, setHops] = useState<1 | 2>(1);

  const { data: graph, isLoading } = useQuery<any>({
    queryKey: ["/api/relationships/graph", profileId, hops],
    queryFn: () =>
      apiRequest("GET", `/api/relationships/graph/${profileId}?hops=${hops}`).then((r) =>
        r.json()
      ),
  });

  if (isLoading) {
    return (
      <div className="text-center py-10 text-sm text-muted-foreground">
        Loading graph...
      </div>
    );
  }
  if (!graph || !graph.nodes || graph.nodes.length === 0) {
    return (
      <div className="text-center py-10">
        <Share2 className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">No connections found</p>
      </div>
    );
  }

  const rootId = graph.rootId;
  const nodes: any[] = graph.nodes || [];
  const edges: any[] = graph.edges || [];

  // Build hop distance map via BFS
  const hopDist = new Map<string, number>();
  hopDist.set(rootId, 0);
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from)!.push(e.to);
    adj.get(e.to)!.push(e.from);
  }
  const queue = [rootId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const d = hopDist.get(cur)!;
    for (const nb of adj.get(cur) || []) {
      if (!hopDist.has(nb)) {
        hopDist.set(nb, d + 1);
        queue.push(nb);
      }
    }
  }

  const hop1 = nodes.filter((n) => n.id !== rootId && hopDist.get(n.id) === 1);
  const hop2 = nodes.filter((n) => n.id !== rootId && hopDist.get(n.id) === 2);
  const otherNodes = nodes.filter(
    (n) => n.id !== rootId && hopDist.get(n.id) !== 1 && hopDist.get(n.id) !== 2
  );

  const R1 = 160;
  const R2 = 300;

  const pos = new Map<string, { x: number; y: number }>();
  pos.set(rootId, { x: 0, y: 0 });

  hop1.forEach((n, i) => {
    const angle = (i * 2 * Math.PI) / Math.max(1, hop1.length) - Math.PI / 2;
    pos.set(n.id, { x: Math.cos(angle) * R1, y: Math.sin(angle) * R1 });
  });

  const parentAngles = new Map<string, number>();
  hop1.forEach((n, i) => {
    parentAngles.set(n.id, (i * 2 * Math.PI) / Math.max(1, hop1.length) - Math.PI / 2);
  });

  const childrenOf = new Map<string, any[]>();
  for (const n of hop2) {
    const parent = edges.find(
      (e) =>
        (e.from === n.id && hop1.some((h) => h.id === e.to)) ||
        (e.to === n.id && hop1.some((h) => h.id === e.from))
    );
    const parentId = parent
      ? hop1.some((h) => h.id === parent.from)
        ? parent.from
        : parent.to
      : null;
    if (parentId) {
      if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
      childrenOf.get(parentId)!.push(n);
    } else {
      if (!childrenOf.has("__unattached")) childrenOf.set("__unattached", []);
      childrenOf.get("__unattached")!.push(n);
    }
  }

  childrenOf.forEach((children, parentId) => {
    const baseAngle = parentAngles.get(parentId) ?? 0;
    const spread = Math.PI / 4;
    children.forEach((n, i) => {
      const offset =
        children.length > 1 ? (i / (children.length - 1) - 0.5) * spread : 0;
      const angle = baseAngle + offset;
      pos.set(n.id, { x: Math.cos(angle) * R2, y: Math.sin(angle) * R2 });
    });
  });

  const unattached = childrenOf.get("__unattached") || [];
  unattached.forEach((n, i) => {
    const angle = (i * 2 * Math.PI) / Math.max(1, unattached.length);
    pos.set(n.id, { x: Math.cos(angle) * R2, y: Math.sin(angle) * R2 });
  });

  otherNodes.forEach((n, i) => {
    if (!pos.has(n.id)) {
      const angle = (i * 2 * Math.PI) / Math.max(1, otherNodes.length) + Math.PI / 6;
      pos.set(n.id, {
        x: Math.cos(angle) * (R2 + 60),
        y: Math.sin(angle) * (R2 + 60),
      });
    }
  });

  function nodeColor(typeKey: string) {
    if (["asset", "vehicle", "property"].includes(typeKey)) return "#10b981";
    if (["liability", "loan"].includes(typeKey)) return "#ef4444";
    return "#3b82f6";
  }

  function edgeColor(kind: string) {
    if (kind === "asset_party") return "#10b981";
    if (kind === "liability_party") return "#3b82f6";
    if (kind === "liability_asset") return "#f59e0b";
    return "#6b7280";
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-center">
        <span className="text-xs text-muted-foreground">Hops:</span>
        <Button
          size="sm"
          variant={hops === 1 ? "default" : "outline"}
          className="h-7 text-xs"
          onClick={() => setHops(1)}
        >
          1 hop
        </Button>
        <Button
          size="sm"
          variant={hops === 2 ? "default" : "outline"}
          className="h-7 text-xs"
          onClick={() => setHops(2)}
        >
          2 hops
        </Button>
      </div>
      <div className="border rounded-lg overflow-hidden bg-muted/10">
        <svg
          viewBox="-400 -400 800 800"
          width="100%"
          height="600"
          style={{ display: "block" }}
        >
          {edges.map((e: any, i: number) => {
            const fp = pos.get(e.from);
            const tp = pos.get(e.to);
            if (!fp || !tp) return null;
            return (
              <line
                key={i}
                x1={fp.x}
                y1={fp.y}
                x2={tp.x}
                y2={tp.y}
                stroke={edgeColor(e.kind)}
                strokeWidth={2}
                strokeOpacity={0.6}
              />
            );
          })}
          {nodes.map((n: any) => {
            const p = pos.get(n.id);
            if (!p) return null;
            const isRoot = n.id === rootId;
            const color = nodeColor(n.typeKey || n.type || "person");
            const label =
              (n.name || "").length > 14
                ? (n.name || "").slice(0, 13) + "…"
                : n.name || "";
            return (
              <g
                key={n.id}
                style={{ cursor: "pointer" }}
                onClick={() => {
                  hashNavigate(`/profiles/${n.id}`);
                }}
              >
                <title>
                  {n.name} ({n.typeKey || n.type})
                </title>
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={isRoot ? 28 : 22}
                  fill={color}
                  fillOpacity={isRoot ? 1 : 0.75}
                  stroke={isRoot ? "#fff" : color}
                  strokeWidth={isRoot ? 3 : 1.5}
                />
                <text
                  x={p.x}
                  y={p.y + (isRoot ? 28 : 22) + 12}
                  textAnchor="middle"
                  fontSize={isRoot ? 11 : 10}
                  fill="currentColor"
                  className="fill-foreground"
                  fontWeight={isRoot ? "600" : "400"}
                >
                  {label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="flex gap-4 text-xs text-muted-foreground flex-wrap">
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-full bg-emerald-500 inline-block" />
          Asset
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-full bg-red-500 inline-block" />
          Liability
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-full bg-blue-500 inline-block" />
          Person/Business
        </span>
      </div>
    </div>
  );
}

// ─── History Tab (ownership audit log + undo) ────────────────────────────────

export function HistoryTab({ profileId }: { profileId: string }) {
  const { toast } = useToast();

  const { data: entries = [], refetch } = useQuery<any[]>({
    queryKey: ["/api/ownership-history", profileId],
    queryFn: () =>
      apiRequest(
        "GET",
        `/api/ownership-history?subjectId=${profileId}&limit=200`
      ).then((r) => r.json()),
  });

  const undoMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/ownership-history/${id}`);
    },
    onSuccess: () => {
      toast({ title: "Reverted" });
      refetch();
      queryClient.invalidateQueries({ queryKey: ["/api/rel-people"] });
      queryClient.invalidateQueries({ queryKey: ["/api/rel-assets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/rel-liabilities"] });
    },
    onError: (err: Error) =>
      toast({
        title: "Undo failed",
        description: formatApiError(err),
        variant: "destructive",
      }),
  });

  if (entries.length === 0) {
    return (
      <div className="text-center py-10">
        <Clock className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">No ownership history</p>
      </div>
    );
  }

  // The server returns the ownership_history timestamp as `changedAt`
  // (camelCase, see rowToOwnershipHistory in supabase-storage.ts). The original
  // code read `createdAt`, which is undefined → `new Date(undefined)` → 'Invalid
  // Date' showing up in the asset / liability History tab. Read `changedAt`
  // first, fall back to legacy fields for safety, and skip rows with no
  // parseable timestamp instead of rendering 'Invalid Date'.
  const tsOf = (e: any): number => {
    const raw = e?.changedAt ?? e?.changed_at ?? e?.createdAt ?? e?.created_at;
    if (!raw) return 0;
    const t = new Date(raw).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  const grouped = new Map<string, any[]>();
  const sorted = [...entries].sort((a, b) => tsOf(b) - tsOf(a));
  for (const e of sorted) {
    const t = tsOf(e);
    if (!t) continue; // skip rows without a usable timestamp
    const day = new Date(t).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    if (!grouped.has(day)) grouped.set(day, []);
    grouped.get(day)!.push(e);
  }

  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;

  return (
    <div className="space-y-4">
      {Array.from(grouped.entries()).map(([day, dayEntries]) => (
        <div key={day}>
          <p className="micro-label text-muted-foreground mb-2">
            {day}
          </p>
          <div className="space-y-2">
            {dayEntries.map((e: any) => {
              const tms = tsOf(e);
              const time = new Date(tms).toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
              });
              const canUndo = now - tms < ONE_DAY;
              const changedByBadge =
                (e.changedBy || "user") === "ai" ? "AI" : "user";

              let description = "";
              if (
                e.fieldChanged &&
                e.oldValue !== undefined &&
                e.newValue !== undefined
              ) {
                description = `${e.fieldChanged}: ${e.oldValue ?? "none"} → ${
                  e.newValue ?? "none"
                }`;
              } else if (e.action) {
                description = String(e.action);
              }

              return (
                <div
                  key={e.id}
                  className="flex items-start gap-3 p-2.5 rounded-lg bg-muted/30 hover:bg-muted/50"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium">
                      {time} —{" "}
                      {description ||
                        e.note ||
                        `${e.action || "change"} (${e.linkKind || "link"})`}
                    </p>
                    <div className="flex gap-2 mt-0.5 items-center">
                      <Badge variant="outline" className="text-xs h-4 px-1">
                        {changedByBadge}
                      </Badge>
                      {e.note && (
                        <span className="text-xs text-muted-foreground truncate">
                          {e.note}
                        </span>
                      )}
                    </div>
                  </div>
                  {canUndo && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-xs px-2 shrink-0"
                      onClick={() => undoMutation.mutate(e.id)}
                      disabled={undoMutation.isPending}
                    >
                      <RefreshCw className="h-3 w-3 mr-1" />
                      Undo
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
