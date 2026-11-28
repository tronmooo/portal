// The pages offered beside the AI modes (the More sheet, shared by the chat
// home and the chat box). Its own module so the modes menu and the composer
// can both read it without importing each other.
import { BarChart3, CalendarDays, FolderOpen, LayoutGrid, type LucideIcon } from "lucide-react";

/** The pages offered beside the workspaces, here and on the chat home. */
export const CHAT_APPS: Array<{ id: string; label: string; icon: LucideIcon; href: string; blurb: string }> = [
  { id: "documents", label: "Documents", icon: FolderOpen, href: "/artifacts", blurb: "Everything you have saved" },
  { id: "analyze", label: "Analyze", icon: BarChart3, href: "/insights", blurb: "Patterns across your records" },
  { id: "plan", label: "Plan", icon: CalendarDays, href: "/calendar", blurb: "Your calendar" },
  { id: "more", label: "More", icon: LayoutGrid, href: "/dashboard", blurb: "The full dashboard" },
];

