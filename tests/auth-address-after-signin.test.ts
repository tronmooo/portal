/**
 * Signing in at /auth lands in the app, not on "Page not found" (2026-11-12).
 *
 * portol.me/auth is the sign-in address (and where sign-out leaves you). The
 * sign-in screen is rendered by the auth gate, outside the router; once the
 * session exists the router takes over at the SAME address — and had no route
 * for it. Observed on production: sign in at /auth → "Page not found · /auth".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "../client/src/App.tsx"), "utf8");
const router = src.slice(src.indexOf("function AppRouter()"), src.indexOf("const sidebarStyle"));

describe("the signed-in router has somewhere to send every sign-in address", () => {
  it("reads the real route table", () => {
    expect(router).toContain('<Route path="/dashboard" component={DashboardPage} />');
    expect(router).toContain("<Route component={NotFound} />");
  });
  it.each(["/auth", "/auth/:rest*", "/login", "/signin", "/signup"])("%s redirects home", (path) => {
    expect(router).toContain(`<Route path="${path}" component={RootRedirect} />`);
  });
  it("declares them before the catch-all", () => {
    expect(router.indexOf('<Route path="/auth" component={RootRedirect} />')).toBeLessThan(router.indexOf("<Route component={NotFound} />"));
  });
});
