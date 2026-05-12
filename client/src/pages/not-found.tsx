import { useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle, ArrowLeft, LayoutDashboard, MessageSquare, Calendar, FolderOpen, Link2 } from "lucide-react";
import { Link, useLocation } from "wouter";

// Friendlier 404 — shows the bad path, a back button, and quick links to the
// main pages so the user is never stranded on a dead page. Replaces the old
// "Did you forget to add the page to the router?" developer error message.
export default function NotFound() {
  const [location] = useLocation();
  useEffect(() => { document.title = "Page not found — Portol"; }, []);

  const quickLinks = [
    { href: "/", label: "Chat", icon: MessageSquare },
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/linked", label: "Linked", icon: Link2 },
    { href: "/calendar", label: "Calendar", icon: Calendar },
    { href: "/artifacts", label: "Artifacts", icon: FolderOpen },
  ];

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardContent className="pt-6">
          <div className="flex items-center gap-3 mb-4">
            <Link href="/" className="inline-flex items-center justify-center rounded-md w-8 h-8 hover:bg-muted transition-colors" aria-label="Back" data-testid="button-back">
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <h1 className="text-xl font-semibold">Page not found</h1>
          </div>

          <div className="flex items-start gap-3 mb-4">
            <AlertCircle className="h-6 w-6 text-red-500 mt-0.5 flex-shrink-0" />
            <div className="text-sm text-muted-foreground">
              <p>We couldn't find a page for:</p>
              <code className="block mt-1 px-2 py-1 bg-muted rounded text-xs break-all" data-testid="text-bad-path">
                {location}
              </code>
            </div>
          </div>

          <p className="text-xs text-muted-foreground mb-3">Try one of these instead:</p>
          <div className="grid grid-cols-2 gap-2">
            {quickLinks.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className="flex items-center gap-2 px-3 py-2 rounded-md bg-muted/50 hover:bg-muted text-sm transition-colors"
                data-testid={`link-quick-${label.toLowerCase()}`}
              >
                <Icon className="w-4 h-4 text-muted-foreground" />
                <span>{label}</span>
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
