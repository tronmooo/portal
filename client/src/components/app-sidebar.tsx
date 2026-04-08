import { Link, useLocation } from "wouter";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";
import { MessageSquare, LayoutDashboard, Link2, Users, Settings, Calendar, Circle } from "lucide-react";
import { useAuth } from "@/lib/auth";

const NAV_ITEMS = [
  { label: "Chat",      href: "/",          icon: MessageSquare,  accent: "188 55% 50%" },
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard,accent: "262 65% 62%" },
  { label: "Linked",    href: "/linked",    icon: Link2,          accent: "155 60% 44%" },
  { label: "Calendar",  href: "/calendar",  icon: Calendar,       accent: "215 70% 58%" },
  { label: "Profiles",  href: "/profiles",  icon: Users,          accent: "310 45% 58%" },
];

export function AppSidebar() {
  const [location] = useLocation();
  const { user } = useAuth();
  const email = user?.email || "";
  const initials = email.slice(0, 2).toUpperCase();

  return (
    <Sidebar>
      <SidebarHeader className="px-4 py-4 border-b border-border/40">
        <div className="flex items-center gap-2.5">
          <img
            src="/portol-logo.png"
            alt="Portol"
            className="w-8 h-8 object-contain"
            style={{ filter: 'drop-shadow(0 0 6px rgba(0,200,220,0.5))' }}
          />
          <div>
            <span className="font-bold text-sm tracking-tight text-foreground">Portol</span>
            <p className="text-xs text-muted-foreground leading-none mt-0.5">Life OS</p>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent className="flex flex-col justify-between py-2">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => {
                const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
                const Icon = item.icon;
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild data-testid={`nav-${item.label.toLowerCase()}`}>
                      <Link href={item.href} aria-current={isActive ? "page" : undefined}>
                        <div
                          className="flex items-center gap-2.5 w-full px-2 py-2 rounded-lg transition-all duration-150 relative"
                          style={isActive ? {
                            background: `hsl(${item.accent} / 0.12)`,
                            color: `hsl(${item.accent})`,
                          } : {}}
                        >
                          {/* Active left border */}
                          {isActive && (
                            <div
                              className="absolute left-0 top-1 bottom-1 w-0.5 rounded-full"
                              style={{ background: `hsl(${item.accent})`, boxShadow: `0 0 8px hsl(${item.accent})` }}
                            />
                          )}
                          <div
                            className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                            style={isActive ? { background: `hsl(${item.accent} / 0.2)` } : { background: 'transparent' }}
                          >
                            <Icon className="h-4 w-4" style={isActive ? { color: `hsl(${item.accent})` } : {}} />
                          </div>
                          <span className={`text-sm ${isActive ? 'font-semibold' : 'font-medium text-muted-foreground'}`}>
                            {item.label}
                          </span>
                        </div>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Settings */}
        <SidebarGroup className="mt-auto">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild data-testid="nav-settings">
                  <Link href="/settings">
                    <div className="flex items-center gap-2.5 px-2 py-2 rounded-lg transition-all hover:bg-muted/60 w-full">
                      <div className="w-7 h-7 rounded-lg bg-muted/50 flex items-center justify-center">
                        <Settings className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <span className="text-sm font-medium text-muted-foreground">Settings</span>
                    </div>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* User mini-card at bottom */}
      <SidebarFooter className="border-t border-border/40 px-3 py-3">
        <div className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 text-white"
            style={{ background: 'linear-gradient(135deg, hsl(188 55% 50%), hsl(262 65% 62%))' }}
          >
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium truncate text-foreground">{email.split("@")[0]}</p>
            <div className="flex items-center gap-1 mt-0.5">
              <Circle className="h-1.5 w-1.5 fill-green-500 text-green-500" />
              <span className="text-xs text-muted-foreground">Online</span>
            </div>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
