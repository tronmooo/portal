import { Link, useLocation } from "wouter";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";
import {
  MessageSquare,
  LayoutDashboard,
  BarChart3,
  Users,
  DollarSign,
  Flame,
  CreditCard,
  BookHeart,
  Calendar,
  ListTodo,
  FileText,
  Settings,
} from "lucide-react";

const CORE_NAV = [
  { label: "Chat", href: "/", icon: MessageSquare },
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
];

const MANAGE_NAV = [
  { label: "Tasks", href: "/tasks", icon: ListTodo },
  { label: "Trackers", href: "/trackers", icon: BarChart3 },
  { label: "Habits", href: "/habits", icon: Flame },
  { label: "Calendar", href: "/calendar", icon: Calendar },
  { label: "Profiles", href: "/profiles", icon: Users },
];

const FINANCE_NAV = [
  { label: "Expenses", href: "/finance", icon: DollarSign },
  { label: "Bills", href: "/obligations", icon: CreditCard },
];

const NOTES_NAV = [
  { label: "Journal", href: "/journal", icon: BookHeart },
  { label: "Notes", href: "/artifacts", icon: FileText },
];

function NavGroup({ items, label }: { items: typeof CORE_NAV; label?: string }) {
  const [location] = useLocation();
  return (
    <SidebarGroup>
      {label && <SidebarGroupLabel>{label}</SidebarGroupLabel>}
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            return (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton asChild isActive={isActive} data-testid={`nav-${item.label.toLowerCase()}`}>
                  <Link href={item.href}>
                    <item.icon className="h-4 w-4" />
                    <span>{item.label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function AppSidebar() {
  const [location] = useLocation();

  return (
    <Sidebar>
      <SidebarHeader className="px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-primary" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v6l4 2" />
            </svg>
          </div>
          <span className="font-semibold text-sm tracking-tight">LifeOS</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <NavGroup items={CORE_NAV} />
        <NavGroup items={MANAGE_NAV} label="Manage" />
        <NavGroup items={FINANCE_NAV} label="Finance" />
        <NavGroup items={NOTES_NAV} label="Notes" />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={location === "/settings"} data-testid="nav-settings">
              <Link href="/settings">
                <Settings className="h-4 w-4" />
                <span>Settings</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
