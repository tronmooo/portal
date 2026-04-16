import { useLocation } from "wouter";
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
import { MessageSquare, LayoutDashboard, Link2, Archive, Settings, Calendar, Circle } from "lucide-react";
import { useAuth } from "@/lib/auth";

const NAV_ITEMS = [
  { label: "Chat",      href: "/",          icon: MessageSquare,  accent: "188 55% 50%" },
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard,accent: "262 65% 62%" },
  { label: "Linked",    href: "/linked",    icon: Link2,          accent: "155 60% 44%" },
  { label: "Calendar",  href: "/calendar",  icon: Calendar,       accent: "215 70% 58%" },
  { label: "Artifacts", href: "/artifacts", icon: Archive,        accent: "310 45% 58%" },
];

export function AppSidebar() {
  const [location, navigate] = useLocation();
  const { user } = useAuth();
  const email = user?.email || "";
  const initials = email.slice(0, 2).toUpperCase();

  return (
    <Sidebar>
      <SidebarHeader className="px-4 py-4 border-b border-border/40">
        <div className="flex items-center gap-2.5">
          <img
            src="/portol-logo-clean.png"
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
                    <SidebarMenuButton
                      data-testid={`nav-${item.label.toLowerCase()}`}
                      onClick={() => { window.location.hash = item.href; }}
                      aria-current={isActive ? "page" : undefined}
                      style={{ WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation' }}
                      className="flex items-center gap-2.5 w-full px-2 py-2 rounded-lg relative cursor-pointer"
                    >
                        <div
                          className="absolute inset-0 rounded-lg"
                          style={isActive ? { background: `hsl(${item.accent} / 0.12)` } : {}}
                        />
                        {isActive && (
                          <div className="absolute left-0 top-1 bottom-1 w-0.5 rounded-full z-10"
                            style={{ background: `hsl(${item.accent})`, boxShadow: `0 0 8px hsl(${item.accent})` }} />
                        )}
                        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 relative z-10"
                          style={isActive ? { background: `hsl(${item.accent} / 0.2)` } : {}}>
                          <Icon className="h-4 w-4" style={{ color: isActive ? `hsl(${item.accent})` : undefined }} />
                        </div>
                        <span className={`text-sm relative z-10 ${isActive ? 'font-semibold' : 'font-medium text-muted-foreground'}`}
                          style={isActive ? { color: `hsl(${item.accent})` } : {}}>
                          {item.label}
                        </span>
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
                  <button onClick={() => { window.location.hash = '/settings'; }}
                    style={{ WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation' }}
                    className="flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-muted/60 w-full text-left">
                    <div className="w-7 h-7 rounded-lg bg-muted/50 flex items-center justify-center">
                      <Settings className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <span className="text-sm font-medium text-muted-foreground">Settings</span>
                  </button>
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
