// client/src/lib/notification-route.ts — where a notification lands.
//
// Rule 24 (2026-09-22): the bell and the dashboard's Notifications section
// each had their own switch on notification type; the bell sent "Overdue
// bill" to Finance for a while, and neither used the entity the notification
// names. One helper now: an entity → its canonical record (shared/entity-
// routes); no entity → the list page for the notification's type; nothing
// known → the dashboard.

import { routeForEntity, listRouteForEntity, normalizeEntityType } from "@shared/entity-routes";
import { hashNavigate } from "@/lib/hashNavigate";

export interface RoutableNotification {
  type?: string;
  entityType?: string;
  entityId?: string;
}

/** The list page each notification type falls back to when it names no record. */
const TYPE_ENTITY: Record<string, string> = {
  task_overdue: "task",
  task_due_today: "task",
  bill_due: "obligation",
  reminder: "event",
  habit_at_risk: "habit",
  streak_milestone: "habit",
  goal_at_risk: "goal",
  goal_completed: "goal",
  document_expiring: "document",
};

export function notificationRoute(n: RoutableNotification): string {
  const entityType = normalizeEntityType(n.entityType);
  if (entityType && n.entityId) return routeForEntity(entityType, n.entityId);
  const byType = normalizeEntityType(TYPE_ENTITY[String(n.type || "")]);
  if (byType) return listRouteForEntity(byType);
  if (n.type === "document_expiring") return "/linked";
  return "/dashboard";
}

/**
 * Navigate to a route that may carry a query. wouter's hash navigate hoists
 * "?highlight=…" out of the hash ("?highlight=x#/dashboard/tasks"), so
 * query-carrying targets go through hashNavigate (same rule as CommandSearch
 * and the hub tab chips).
 */
export function navigateToRoute(navigate: (to: string) => void, path: string): void {
  if (path.includes("?")) hashNavigate(path);
  else navigate(path);
}
