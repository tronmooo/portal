// The four main destinations — one list for the mobile bottom bar and the
// desktop sidebar, so the two can't drift (they had: Chat was 188 50% 52% on
// one and 188 55% 50% on the other).
import { MessageSquare, LayoutDashboard, Archive, Calendar, type LucideIcon } from "lucide-react";

export interface NavTab { label: string; href: string; icon: LucideIcon; accent: string }

// Hub consolidation (2026-07): Linked merged into the Dashboard hub; its old
// routes still light up Dashboard via isHubLocationForNav.
export const NAV_TABS: NavTab[] = [
  { label: "Chat",      href: "/chat",      icon: MessageSquare,   accent: "188 55% 50%" },
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, accent: "262 65% 62%" },
  { label: "Calendar",  href: "/calendar",  icon: Calendar,        accent: "215 70% 58%" },
  { label: "Artifacts", href: "/artifacts", icon: Archive,         accent: "310 45% 58%" },
];
