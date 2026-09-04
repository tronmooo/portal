import { useState, useEffect, useCallback, useRef } from "react";
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
import { apiRequest } from "@/lib/queryClient";
import { useProfileScope } from "@/hooks/useProfileScope";
import { daysFromToday } from "@/lib/dates";

interface Notification {
  id: string;
  type: "document_expiring" | "task_overdue" | "task_due_today" | "bill_due" | "habit_at_risk" | "streak_milestone" | "goal_at_risk" | "goal_completed" | "reminder";
  severity: "critical" | "warning" | "info";
  title: string;
  message: string;
  entityId?: string;
  entityType?: string;
  dueDate?: string;
  /** The DEADLINE this is about, shared by its "due soon" / "due today" /
   *  "overdue" phrasings — see server/notification-service.ts. Dismissing one
   *  has to silence all three, or the same deadline asks again tomorrow. */
  dismissKey?: string;
  dismissed?: boolean;
}

// Calendar-day distance via lib/dates: a bare "YYYY-MM-DD" is read as a LOCAL
// day there. `new Date("2026-09-02")` is UTC midnight, which is the evening of
// Sep 1 for every US user, so a task due today read "yesterday" in the bell.
export function getRelativeTime(dueDate?: string): string {
  const days = daysFromToday(dueDate);
  if (days === null) return "";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 0) return `in ${days} days`;
  return `${Math.abs(days)} days ago`;
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

async function loadDismissedIds(): Promise<string[]> {
  try {
    // Audit fix: this used raw fetch() which bypassed the auth interceptor,
    // so the request went unauthenticated, returned 401, and dismissed IDs
    // were never restored on reload — making 'Dismiss all' look broken.
    // apiRequest() runs through the auth interceptor with the bearer token.
    const res = await apiRequest("GET", `/api/preferences/${DISMISSED_PREF_KEY}`);
    const json = await res.json().catch(() => null);
    if (!json?.value) return [];
    const parsed = JSON.parse(json.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Sends only the ids being dismissed; the server merges them into the stored
 * list and answers with the whole list. Writing back the list this bell
 * loaded at mount overwrote dismissals made meanwhile in another tab, in the
 * briefing or by chat (D263). Resolves to the merged list, or null on failure.
 */
async function dismissOnServer(ids: string[]): Promise<string[] | null> {
  try {
    const res = await apiRequest("POST", "/api/notifications/dismiss", { ids });
    const json = await res.json().catch(() => null);
    return Array.isArray(json?.ids) ? json.ids : null;
  } catch {
    return null; // local state still hides the item for this session
  }
}

export function NotificationBell() {
  const [, setLocation] = useLocation();
  const [open, setOpen] = useState(false);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  // Whether the persisted dismissal list has come back yet. The badge stays
  // hidden until it has: dismissals load one round trip AFTER the notifications
  // do, so rendering in between shows a count that is about to drop for no
  // reason the user can see (QA 2026-07-29 CRUD-T1-004 watched the badge run
  // 7 → 8 → 20 → 19 → 7 with no matching event).
  const [dismissedReady, setDismissedReady] = useState(false);
  const dismissedLoaded = useRef(false);

  // Load persisted dismissed IDs on mount
  useEffect(() => {
    if (dismissedLoaded.current) return;
    dismissedLoaded.current = true;
    loadDismissedIds()
      .then(ids => { if (ids.length > 0) setDismissedIds(new Set(ids)); })
      .finally(() => setDismissedReady(true));
  }, []);

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
    refetchInterval: 60000,
    // Keep the previous scope's list on screen while the new one loads instead
    // of flashing an empty (or default-keyed) count in between.
    placeholderData: keepPreviousData,
  });

  // Filter out dismissed notifications — by id, and by the deadline key that
  // covers this notification's other phrasings.
  const isDismissed = (n: Notification) =>
    dismissedIds.has(n.id) || (!!n.dismissKey && dismissedIds.has(n.dismissKey));
  const visibleNotifications = notifications.filter(n => !isDismissed(n));
  // ONE number for this surface. The badge used to count only critical +
  // warning while the panel header counted everything, so the bell and the list
  // it opens disagreed by design. The badge is "how many are waiting" — the
  // same thing the panel lists.
  const totalCount = visibleNotifications.length;

  // Both keys go to the server: the id (so this exact row stays gone) and the
  // deadline key (so its other phrasings never appear).
  const keysFor = (n: Notification): string[] =>
    n.dismissKey && n.dismissKey !== n.id ? [n.id, n.dismissKey] : [n.id];

  const handleDismissAll = useCallback(() => {
    const allKeys = notifications.flatMap(keysFor);
    setDismissedIds(prev => new Set([...Array.from(prev), ...allKeys]));
    void dismissOnServer(allKeys).then((merged) => { if (merged) setDismissedIds(new Set(merged)); });
  }, [notifications]);

  const handleDismiss = useCallback((n: Notification, e: React.MouseEvent) => {
    e.stopPropagation();
    const keys = keysFor(n);
    void dismissOnServer(keys).then((merged) => { if (merged) setDismissedIds(new Set(merged)); });
    setDismissedIds(prev => {
      const next = new Set(Array.from(prev));
      for (const k of keys) next.add(k);
      return next;
    });
  }, []);

  const handleNotificationClick = useCallback(
    (notification: Notification) => {
      // Mark as read (same persistence as the X button) so badge count decrements
      // and the item disappears from the unread list after click.
      setDismissedIds(prev => {
        if (prev.has(notification.id)) return prev;
        const next = new Set(Array.from(prev));
        next.add(notification.id);
        return next;
      });
      void dismissOnServer([notification.id]).then((merged) => { if (merged) setDismissedIds(new Set(merged)); });
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
    [setLocation]
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
  onDismiss: (notification: Notification, e: React.MouseEvent) => void;
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
  onDismiss: (notification: Notification, e: React.MouseEvent) => void;
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
        onClick={(e) => onDismiss(notification, e)}
        aria-label="Dismiss notification"
        data-testid={`button-dismiss-${notification.id}`}
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}
