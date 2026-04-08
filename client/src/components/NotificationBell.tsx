import { useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
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
  X,
  CheckCheck,
  BellOff,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";

interface Notification {
  id: string;
  type: "document_expiring" | "task_overdue" | "task_due_today" | "bill_due" | "habit_at_risk" | "streak_milestone";
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

export function NotificationBell() {
  const [, setLocation] = useLocation();
  const [open, setOpen] = useState(false);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  const { data: notifications = [], isLoading } = useQuery<Notification[]>({
    queryKey: ["/api/notifications"],
    refetchInterval: 60000,
  });

  // Filter out dismissed notifications
  const visibleNotifications = notifications.filter(n => !dismissedIds.has(n.id));
  const urgentCount = visibleNotifications.filter(
    n => n.severity === "critical" || n.severity === "warning"
  ).length;
  const totalCount = visibleNotifications.length;

  const handleDismissAll = useCallback(() => {
    setDismissedIds(new Set(notifications.map(n => n.id)));
  }, [notifications]);

  const handleDismiss = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDismissedIds(prev => { const next = new Set(Array.from(prev)); next.add(id); return next; });
  }, []);

  const handleNotificationClick = useCallback(
    (notification: Notification) => {
      if (!notification.entityId) return;
      switch (notification.entityType) {
        case "document":
          setLocation(`/documents/${notification.entityId}`);
          break;
        case "profile":
          setLocation(`/profiles/${notification.entityId}`);
          break;
        case "task":
          setLocation(`/dashboard`);
          break;
        case "obligation":
          setLocation(`/dashboard`);
          break;
        case "habit":
          setLocation(`/dashboard`);
          break;
        default:
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
        >
          <Bell className="h-4 w-4" />
          {urgentCount > 0 && !open && (
            <span
              className="absolute -top-0.5 -right-0.5 flex items-center justify-center h-4 min-w-[16px] px-1 rounded-full bg-red-500 text-white text-xs font-bold leading-none animate-pulse"
              data-testid="badge-notification-count"
            >
              {urgentCount > 99 ? "99+" : urgentCount}
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
        <span className="text-xs-loose font-medium uppercase tracking-wider text-muted-foreground">
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
