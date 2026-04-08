import { Link, useLocation } from "wouter";
import { MessageSquare, LayoutDashboard, Link2, Users, Calendar } from "lucide-react";

const TABS = [
  { label: "Chat",      href: "/",          icon: MessageSquare,  accent: "188 50% 52%" },
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard,accent: "262 65% 62%" },
  { label: "Linked",    href: "/linked",    icon: Link2,          accent: "155 60% 44%" },
  { label: "Calendar",  href: "/calendar",  icon: Calendar,       accent: "215 70% 58%" },
  { label: "Profiles",  href: "/profiles",  icon: Users,          accent: "310 45% 58%" },
];

export function MobileBottomNav() {
  const [location] = useLocation();

  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-50 border-t border-border/50"
      style={{ background: "hsl(var(--background) / 0.92)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)" }}
      role="navigation"
      aria-label="Main navigation"
    >
      <div className="flex items-center justify-around h-[var(--mobile-nav-height)] px-1">
        {TABS.map((tab) => {
          const isActive = location === tab.href || (tab.href !== "/" && location.startsWith(tab.href));
          const Icon = tab.icon;
          const color = `hsl(${tab.accent})`;
          return (
            <Link key={tab.href} href={tab.href}>
              <button
                className="relative flex flex-col items-center justify-center gap-0.5 min-h-[44px] min-w-[52px] px-2 py-1.5 rounded-xl transition-all duration-200"
                style={isActive ? {
                  background: `hsl(${tab.accent} / 0.13)`,
                  color,
                } : { color: "hsl(var(--muted-foreground))" }}
                data-testid={`mobile-nav-${tab.label.toLowerCase()}`}
                aria-current={isActive ? "page" : undefined}
              >
                {/* Active indicator dot */}
                {isActive && (
                  <span
                    className="absolute top-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full status-dot-pulse"
                    style={{ background: color, boxShadow: `0 0 5px ${color}` }}
                  />
                )}
                <Icon
                  className="h-5 w-5 transition-transform duration-200"
                  style={isActive ? { transform: "scale(1.12)" } : {}}
                />
                <span className={`text-xs transition-all duration-200 ${isActive ? "font-semibold" : "font-medium"}`}>
                  {tab.label}
                </span>
              </button>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
