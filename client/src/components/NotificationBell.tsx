import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Bell,
  FileText,
  ListTodo,
  DollarSign,
  Flame,
  Trophy,
  Target,
  X,
  CheckCheck,
  BellOff,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useProfileScope } from "@/hooks/useProfileScope";

interface Notification {
  id: string;
  type: "document_expiring" | "task_overdue" | "task_due_today" | "bill_due" | "habit_at_risk" | "streak_milestone" | "goal_at_risk" | "goal_completed" | "reminder";
  severity: "critical" | "warning" | "info";
  title: string;
  message: string;
  entityId?: string;
  entityType?: string;
  dueDate?: string;
  dismissed?: boolean;
}

function getRelativeTime(dueDate?: string): string {
  if (!dueDate) return "";
  try {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const target = new Date(dueDate);
    if (isNaN(target.getTime())) return "";
    target.setHours(0, 0, 0, 0);
    const diffMs = target.getTime() - now.getTime();
    const days = Math.round(diffMs / 86400000);
    if (days === 0) return "today";
    if (days === 1) return "tomorrow";
    if (days === -1) return "yesterday";
    if (days > 0) return `in ${days} days`;
    return `${Math.abs(days)} days ago`;
  } catch {
    return "";
  }
}

function getIcon(type: Notification["type"]) {
  switch (type) {
    case "document_expiring":
      return FileText;
    case "task_overdue":
    case "task_due_today":
      return ListTodo;
    case "bill_due":
      return DollarSign;
    case "habit_at_risk":
      return Flame;
    case "streak_milestone":
      return Trophy;
    case "goal_at_risk":
    case "goal_completed":
      return Target;
    case "reminder":
      return Bell;
    default:
      return Bell;
  }
}

function getSeverityStyles(severity: Notification["severity"]) {
  switch (severity) {
    case "critical":
      return {
        border: "border-l-red-500",
        bg: "bg-red-500/5 dark:bg-red-500/10",
        iconColor: "text-red-500",
        dot: "bg-red-500",
      };
    case "warning":
      return {
        border: "border-l-amber-500",
        bg: "bg-amber-500/5 dark:bg-amber-500/10",
        iconColor: "text-amber-500",
        dot: "bg-amber-500",
      };
    case "info":
      return {
        border: "border-l-blue-500",
        bg: "bg-blue-500/5 dark:bg-blue-500/10",
        iconColor: "text-blue-500",
        dot: "bg-blue-500",
      };
  }
}

// Persist dismissed IDs to the preferences API so they survive page reloads
const DISMISSED_PREF_KEY = "dismissed_notifications";
// Shared query slot: seeded by /api/dashboard-bootstrap and also read by the
// Executive Brief (ExecutiveBriefing.tsx). One fetch serves all three surfaces
// instead of the bell firing its own GET on the login critical path.
const DISMISSED_QUERY_KEY = ["/api/preferences/dismissed_notifications"];

async function saveDismissedIds(ids: string[]): Promise<void> {
  // Keep the shared cache slot in sync so the Executive Brief's alert list
  // agrees with the bell without a refetch.
  try { queryClient.setQueryData(DISMISSED_QUERY_KEY, ids); } catch { /* ignore */ }
  try {
    // Audit fix: raw fetch bypassed the bearer-token interceptor and the PUT
    // silently 401'd, so dismissals never persisted across reloads.
    // apiRequest() runs through the auth interceptor with the bearer token.
    await apiRequest("PUT", `/api/preferences/${DISMISSED_PREF_KEY}`, {
      value: JSON.stringify(ids),
    });
  } catch {
    // Silently fail — local state is still correct
  }
}

export function NotificationBell() {
  const [, setLocation] = useLocation();
  const [open, setOpen] = useState(false);
  // Persisted dismissals come from the SHARED query slot the bootstrap seeds
  // (see bootstrap-seed-keys.ts) and the Executive Brief also reads — so the
  // bell no longer fires its own /api/preferences GET on the login critical
  // path, and the two surfaces can't disagree about what's dismissed.
  // Local state stays the authority for THIS session's dismissals (they must
  // apply instantly, before the PUT lands); the query result seeds it.
  const [localDismissed, setLocalDismissed] = useState<Set<string>>(new Set());
  const { data: persistedDismissed = [], isPending: dismissedPending } = useQuery<string[]>({
    queryKey: DISMISSED_QUERY_KEY,
    queryFn: () => apiRequest("GET", `/api/preferences/${DISMISSED_PREF_KEY}`)
      .then(r => r.json())
      .then(d => { try { const p = JSON.parse(d?.value || "[]"); return Array.isArray(p) ? p : []; } catch { return []; } })
      .catch(() => []),
  });
  const dismissedIds = useMemo(
    () => new Set<string>([...persistedDismissed, ...Array.from(localDismissed)]),
    [persistedDismissed, localDismissed],
  );
  // Whether the persisted dismissal list has arrived. The badge stays hidden
  // until it has: rendering in between shows a count that is about to drop for
  // no reason the user can see (QA 2026-07-29 CRUD-T1-004 watched the badge run
  // 7 → 8 → 20 → 19 → 7 with no matching event). Seeded from the bootstrap on
  // the happy path, so this is normally true on first render.
  const dismissedReady = !dismissedPending;

  // Record a dismissal locally AND persist it (shared slot + preferences PUT).
  const addDismissed = useCallback((ids: string[]) => {
    setLocalDismissed(prev => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    const merged = Array.from(new Set([...persistedDismissed, ...Array.from(localDismissed), ...ids]));
    saveDismissedIds(merged);
  }, [persistedDismissed, localDismissed]);

  // Read the active profile scope from the ONE reactive store binding. The bell
  // previously mirrored the store into local state, so during a profile switch
  // it briefly rendered the old scope's count against the new scope's data —
  // the other half of the fluctuating badge.
  const { mode: filterMode, selectedIds: filterIds } = useProfileScope();
  const notifProfileParam = filterMode === "selected" && filterIds.length > 0
    ? `?profileIds=${filterIds.join(",")}` : "";
  const { data: notifications = [], isLoading } = useQuery<Notification[]>({
    queryKey: ["/api/notifications", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/notifications${notifProfileParam}`).then(r => r.json()),
    // Notifications are derived from due dates and expiries — they change on
    // the scale of hours, not seconds, and every mutation that could add one
    // already invalidates this key through the cache bus. The 60s poll was a
    // request per minute per open tab (each one a serverless invocation)
    // competing with whatever the user was actually doing.
    refetchInterval: 5 * 60_000,
    // Keep the previous scope's list on screen while the new one loads instead
    // of flashing an empty (or default-keyed) count in between.
    placeholderData: keepPreviousData,
  });

  // Filter out dismissed notifications
  const visibleNotifications = notifications.filter(n => !dismissedIds.has(n.id));
  // ONE number for this surface. The badge used to count only critical +
  // warning while the panel header counted everything, so the bell and the list
  // it opens disagreed by design. The badge is "how many are waiting" — the
  // same thing the panel lists.
  const totalCount = visibleNotifications.length;

  const handleDismissAll = useCallback(() => {
    addDismissed(notifications.map(n => n.id));
  }, [notifications, addDismissed]);

  const handleDismiss = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    addDismissed([id]);
  }, [addDismissed]);

  const handleNotificationClick = useCallback(
    (notification: Notification) => {
      // Mark as read (same persistence as the X button) so badge count decrements
      // and the item disappears from the unread list after click.
      if (!dismissedIds.has(notification.id)) addDismissed([notification.id]);
      // Deep-link based on notification type/entity
      switch (notification.type) {
        case "task_overdue":
        case "task_due_today":
          setLocation("/dashboard/tasks");
          break;
        case "bill_due":
          // Bills live on the Bills page. This pointed at Finance — the
          // expenses screen — which does not list the bill you tapped, so an
          // "Overdue bill: …" row appeared to go nowhere (QA 2026-08-05).
          setLocation("/dashboard/obligations");
          break;
        case "reminder":
          setLocation("/calendar");
          break;
        case "habit_at_risk":
          setLocation("/dashboard/habits");
          break;
        case "streak_milestone":
        case "goal_at_risk":
        case "goal_completed":
          setLocation("/dashboard");
          setTimeout(() => {
            const goalsSection = document.querySelector('[data-testid="section-goals"]');
            if (goalsSection) goalsSection.scrollIntoView({ behavior: 'smooth' });
          }, 300);
          break;
        case "document_expiring":
          // Deep-link directly to the owning entity so the user can update or
          // renew the expiry date in-place. Documents → /documents/:id, profile
          // field expiries → /profiles/:id. Falls back to /linked if entity is
          // missing.
          if (notification.entityType === "document" && notification.entityId) {
            setLocation(`/documents/${notification.entityId}`);
          } else if (notification.entityType === "profile" && notification.entityId) {
            setLocation(`/profiles/${notification.entityId}`);
          } else {
            setLocation("/linked");
          }
          break;
        default:
          setLocation("/dashboard");
          break;
      }
      setOpen(false);
    },
    [setLocation, dismissedIds, addDismissed]
  );


  // Group by severity
  const criticalNotifs = visibleNotifications.filter(n => n.severity === "critical");
  const warningNotifs = visibleNotifications.filter(n => n.severity === "warning");
  const infoNotifs = visibleNotifications.filter(n => n.severity === "info");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 relative"
          data-testid="button-notification-bell"
          aria-label="Notifications"
        >
          <Bell className="h-4 w-4" />
          {dismissedReady && totalCount > 0 && !open && (
            <span
              className="absolute -top-0.5 -right-0.5 flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full bg-red-500 text-white text-xs font-bold leading-none animate-pulse"
              data-testid="badge-notification-count"
            >
              {totalCount > 99 ? "99+" : totalCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[380px] p-0 rounded-xl shadow-lg"
        data-testid="panel-notifications"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-semibold">
              Notifications
            </span>
            {totalCount > 0 && (
              <span className="text-xs text-muted-foreground">
                ({totalCount})
              </span>
            )}
          </div>
          {totalCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground hover:text-foreground"
              onClick={handleDismissAll}
              data-testid="button-dismiss-all"
            >
              <CheckCheck className="h-3 w-3 mr-1" />
              Dismiss all
            </Button>
          )}
        </div>

        {/* Notification List */}
        <ScrollArea className="max-h-[400px]">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin h-5 w-5 border-2 border-muted-foreground border-t-transparent rounded-full" />
            </div>
          ) : totalCount === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 px-4" data-testid="empty-notifications">
              <BellOff className="h-8 w-8 text-muted-foreground/40 mb-2" />
              <p className="text-sm text-muted-foreground">All clear! No notifications.</p>
            </div>
          ) : (
            <div className="py-1">
              {criticalNotifs.length > 0 && (
                <NotificationGroup
                  label="Critical"
                  notifications={criticalNotifs}
                  onDismiss={handleDismiss}
                  onClick={handleNotificationClick}
                />
              )}
              {warningNotifs.length > 0 && (
                <NotificationGroup
                  label="Attention"
                  notifications={warningNotifs}
                  onDismiss={handleDismiss}
                  onClick={handleNotificationClick}
                />
              )}
              {infoNotifs.length > 0 && (
                <NotificationGroup
                  label="Info"
                  notifications={infoNotifs}
                  onDismiss={handleDismiss}
                  onClick={handleNotificationClick}
                />
              )}
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

function NotificationGroup({
  label,
  notifications,
  onDismiss,
  onClick,
}: {
  label: string;
  notifications: Notification[];
  onDismiss: (id: string, e: React.MouseEvent) => void;
  onClick: (n: Notification) => void;
}) {
  return (
    <div className="mb-1">
      <div className="px-4 py-1.5">
        <span className="micro-label text-muted-foreground">
          {label}
        </span>
      </div>
      {notifications.map((notif) => (
        <NotificationItem
          key={notif.id}
          notification={notif}
          onDismiss={onDismiss}
          onClick={onClick}
        />
      ))}
    </div>
  );
}

function NotificationItem({
  notification,
  onDismiss,
  onClick,
}: {
  notification: Notification;
  onDismiss: (id: string, e: React.MouseEvent) => void;
  onClick: (n: Notification) => void;
}) {
  const styles = getSeverityStyles(notification.severity);
  const Icon = getIcon(notification.type);
  const relativeTime = getRelativeTime(notification.dueDate);

  return (
    <div
      className={cn(
        "flex items-start gap-3 px-4 py-2.5 cursor-pointer transition-colors hover:bg-accent/50 border-l-2",
        styles.border,
        styles.bg
      )}
      onClick={() => onClick(notification)}
      data-testid={`notification-item-${notification.id}`}
    >
      <div className={cn("mt-0.5 shrink-0", styles.iconColor)}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium leading-tight truncate" data-testid={`notification-title-${notification.id}`}>
          {notification.title}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
          {notification.message}
        </p>
        {relativeTime && (
          <span className="text-xs-loose text-muted-foreground/70 mt-1 inline-block">
            {relativeTime}
          </span>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0 mt-0.5 opacity-50 hover:opacity-100 focus:opacity-100"
        onClick={(e) => onDismiss(notification.id, e)}
        data-testid={`button-dismiss-${notification.id}`}
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}
