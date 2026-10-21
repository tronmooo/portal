import { useLocation } from "wouter";
import { isHubLocationForNav } from "@/components/hub/hub-routes";
import {
  preloadNavigationChunk,
  prefetchNavigationTarget,
} from "@/lib/navigation-prefetch";
import { NAV_TABS as TABS } from "@/lib/nav-tabs";

export function MobileBottomNav() {
  const [location, navigate] = useLocation();

  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-50 border-t border-border/50"
      style={{ background: "hsl(var(--background) / 0.92)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", WebkitTapHighlightColor: "transparent" }}
      role="navigation"
      aria-label="Main navigation"
    >
      <div className="flex items-center justify-around h-[var(--mobile-nav-height)] px-1">
        {TABS.map((tab) => {
          const isActive = tab.href === "/dashboard"
            ? isHubLocationForNav(location)
            : location === tab.href || (tab.href !== "/" && location.startsWith(tab.href));
          const Icon = tab.icon;
          const color = `hsl(${tab.accent})`;
          return (
            // Use a plain <a> element — no nested <button> inside <a> (invalid HTML breaks touch events)
            <a
              key={tab.href}
              href={`#${tab.href}`}
              onClick={(e) => { e.preventDefault(); navigate(tab.href); }}
              // Warm the destination's primary query the moment the finger/
              // pointer goes down — the fetch overlaps the tap→click delay and
              // the route transition instead of starting after mount.
              // (pointerdown covers mouse+touch on modern browsers; touchstart
              // is the fallback for older iOS. Duplicate calls are deduped by
              // react-query's in-flight tracking.)
              onPointerDown={() => prefetchNavigationTarget(tab.href)}
              onTouchStart={() => prefetchNavigationTarget(tab.href)}
              onFocus={() => preloadNavigationChunk(tab.href)}
              className="relative flex flex-col items-center justify-center gap-0.5 min-h-[44px] min-w-[52px] px-2 py-1.5 rounded-xl select-none"
              style={{
                WebkitTapHighlightColor: "transparent",
                touchAction: "manipulation",
                ...(isActive
                  ? { background: `linear-gradient(160deg, hsl(${tab.accent} / 0.20), hsl(${tab.accent} / 0.07))`, boxShadow: `inset 0 0 0 1px hsl(${tab.accent} / 0.28)`, color }
                  : { color: "hsl(var(--muted-foreground))" }),
              }}
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
                className="h-5 w-5"
                style={isActive ? { transform: "scale(1.12)" } : {}}
              />
              <span className={`text-xs ${isActive ? "font-semibold" : "font-medium"}`}>
                {tab.label}
              </span>
            </a>
          );
        })}
      </div>
    </nav>
  );
}
