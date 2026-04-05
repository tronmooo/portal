import { Link, useLocation } from "wouter";
import { MessageSquare, LayoutDashboard, Link2, Users, Calendar } from "lucide-react";

const TABS = [
  { label: "Chat", href: "/", icon: MessageSquare },
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Linked", href: "/trackers", icon: Link2 },
  { label: "Calendar", href: "/calendar", icon: Calendar },
  { label: "Profiles", href: "/profiles", icon: Users },
];

export function MobileBottomNav() {
  const [location] = useLocation();

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-background/95 backdrop-blur-sm border-t border-border z-50" role="navigation" aria-label="Main navigation">
      <div className="flex items-center justify-around h-[var(--mobile-nav-height)]">
        {TABS.map((tab) => {
          const isActive = location === tab.href || (tab.href !== "/" && location.startsWith(tab.href));
          return (
            <Link key={tab.href} href={tab.href}>
              <button
                className={`flex flex-col items-center justify-center gap-0.5 min-h-[44px] min-w-[44px] px-3 py-1.5 rounded-lg transition-colors ${
                  isActive
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                data-testid={`mobile-nav-${tab.label.toLowerCase()}`}
                aria-current={isActive ? "page" : undefined}
              >
                <tab.icon className="h-5 w-5" />
                <span className="text-xs font-medium">{tab.label}</span>
              </button>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
