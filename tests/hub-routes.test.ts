import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  HUB_TABS, activeHubTab, isHubRoute, isHubLocationForNav, infoTabRoute, reconcileInfoRoute,
} from "../client/src/components/hub/hub-routes";

describe("HUB_TABS", () => {
  it("has the 8 mockup tabs in order", () => {
    expect(HUB_TABS.map(t => t.id)).toEqual([
      "executive", "trackers", "finance", "wellness", "assets", "liabilities", "documents", "info",
    ]);
  });

  it("every tab's default route is itself a hub route that activates that tab", () => {
    for (const tab of HUB_TABS) {
      expect(isHubRoute(tab.route), `${tab.id} route in hub`).toBe(true);
      expect(activeHubTab(tab.route), `${tab.id} route activates itself`).toBe(tab.id);
    }
  });
});

describe("activeHubTab", () => {
  it("maps canonical routes", () => {
    expect(activeHubTab("/dashboard")).toBe("executive");
    expect(activeHubTab("/trackers")).toBe("trackers");
    expect(activeHubTab("/dashboard/finance")).toBe("finance");
    expect(activeHubTab("/finance")).toBe("finance");
    expect(activeHubTab("/wellness")).toBe("wellness");
    expect(activeHubTab("/health")).toBe("wellness");
    expect(activeHubTab("/dashboard/health")).toBe("wellness");
    expect(activeHubTab("/liabilities")).toBe("liabilities");
    expect(activeHubTab("/profiles")).toBe("info");
  });

  it("maps /linked by ?tab= (trackers.tsx getQuerySection contract)", () => {
    expect(activeHubTab("/linked?tab=assets")).toBe("assets");
    expect(activeHubTab("/linked?tab=profiles")).toBe("assets");
    expect(activeHubTab("/linked?tab=documents")).toBe("documents");
    expect(activeHubTab("/linked?tab=trackers")).toBe("trackers");
    expect(activeHubTab("/linked?tab=liabilities")).toBe("liabilities");
    // Plain /linked is the legacy "All" view — shell shows, no chip active.
    expect(activeHubTab("/linked")).toBeNull();
  });

  // Audit 2026-07-29, finding P3: "Nav labels don't match destinations, and
  // two routes 404." The Assets and Documents chips navigated to
  // `/linked?tab=…`, whose browser title read "Linked" — a word the user is
  // never taught — while typing or bookmarking `/#/assets` hit "Page not
  // found".
  describe("assets and documents are real routes (P3)", () => {
    it("activates its chip from the clean path", () => {
      expect(activeHubTab("/assets")).toBe("assets");
      expect(activeHubTab("/documents")).toBe("documents");
    });

    it("still honours the old query form so existing links survive", () => {
      expect(activeHubTab("/linked?tab=assets")).toBe("assets");
      expect(activeHubTab("/linked?tab=documents")).toBe("documents");
    });

    it("navigates the chips to the clean routes, not the query form", () => {
      const byId = Object.fromEntries(HUB_TABS.map(t => [t.id, t.route]));
      expect(byId.assets).toBe("/assets");
      expect(byId.documents).toBe("/documents");
    });

    it("renders the hub shell on the new routes", () => {
      expect(isHubRoute("/assets")).toBe(true);
      expect(isHubRoute("/documents")).toBe(true);
    });

    it("does not swallow a document detail page", () => {
      // /documents/:id is its own route; it must not light the Documents chip
      // or be mistaken for the list.
      expect(activeHubTab("/documents/abc123")).toBeNull();
    });

    it("App.tsx actually registers them, so they cannot 404", () => {
      const app = fs.readFileSync(path.join(process.cwd(), "client/src/App.tsx"), "utf8");
      expect(app).toMatch(/<Route\s+path="\/assets"/);
      expect(app).toMatch(/<Route\s+path="\/documents"/);
    });

    it("every hub tab route is registered in App.tsx", () => {
      // A chip pointing at an unregistered path is precisely the 404 this
      // finding is about, so check the whole set rather than these two.
      const app = fs.readFileSync(path.join(process.cwd(), "client/src/App.tsx"), "utf8");
      for (const tab of HUB_TABS) {
        const p = tab.route.split("?")[0];
        expect(app, `${tab.id} route ${p} must be registered`)
          .toContain(`path="${p}"`);
      }
    });

    it("gives each destination its own browser title", () => {
      // The title is what a bookmark and a browser tab are named. "Linked"
      // named neither of the two pages it was applied to.
      const app = fs.readFileSync(path.join(process.cwd(), "client/src/App.tsx"), "utf8");
      expect(app).toContain('"/assets": "Assets — Portol"');
      expect(app).toContain('"/documents": "Documents — Portol"');
      // /liabilities had no entry at all, so it inherited the previous page's
      // title — the audit saw "Trackers" there.
      expect(app).toMatch(/"\/liabilities":\s*"/);
      expect(app).not.toContain('"/linked": "Linked — Portol"');
    });
  });

  it("Info is active on the SELECTED profile's Info page only", () => {
    expect(activeHubTab("/profiles/abc/info", ["abc"])).toBe("info");
    expect(activeHubTab("/profiles/other/info", ["abc"])).toBeNull();
    expect(activeHubTab("/profiles/abc/info", [])).toBeNull();            // everyone
    expect(activeHubTab("/profiles/abc/info", ["abc", "def"])).toBeNull(); // multi-select
  });

  it("the deep detail page (/profiles/:id) is NOT the Info chip", () => {
    // Full profile page shows the shell but no chip lit — Info now points at
    // the lightweight /profiles/:id/info page.
    expect(activeHubTab("/profiles/abc", ["abc"])).toBeNull();
    expect(activeHubTab("/profile/abc", ["abc"])).toBeNull();
  });

  it("ignores query strings and trailing slashes on path matches", () => {
    expect(activeHubTab("/dashboard?x=1")).toBe("executive");
    expect(activeHubTab("/profiles/")).toBe("info");
  });

  it("returns null outside the hub", () => {
    expect(activeHubTab("/")).toBeNull();
    expect(activeHubTab("/calendar")).toBeNull();
    expect(activeHubTab("/tasks")).toBeNull();
    expect(activeHubTab("/dashboard/journal")).toBeNull();
  });
});

describe("isHubRoute / isHubLocationForNav", () => {
  it("covers all hub locations incl. profile detail pages", () => {
    for (const loc of [
      "/dashboard", "/dashboard/finance", "/dashboard/health", "/finance",
      "/trackers", "/linked", "/linked?tab=assets", "/liabilities", "/health", "/wellness",
      "/profiles", "/profiles/some-id", "/profile/legacy-id", "/profiles/some-id/info",
      "/profiles/some-id/overview", "/profiles/some-id/finance",
      "/profiles/some-id/trackers", "/profiles/some-id/history",
    ]) {
      expect(isHubRoute(loc), loc).toBe(true);
      expect(isHubLocationForNav(loc), loc).toBe(true);
    }
  });

  it("excludes standalone pages (v1 scope)", () => {
    for (const loc of [
      "/", "/calendar", "/artifacts", "/settings", "/tasks", "/journal",
      "/habits", "/bills", "/goals", "/obligations", "/insights",
      "/dashboard/journal", "/dashboard/tasks", "/dashboard/obligations",
      "/dashboard/habits", "/dashboard/goals", "/dashboard/documents",
      "/dashboard/artifacts", "/documents/abc", "/editor/abc", "/profiles/a/b",
      "/profiles/list",
    ]) {
      expect(isHubRoute(loc), loc).toBe(false);
    }
  });
});

describe("infoTabRoute", () => {
  it("targets the selected profile's Info page only when exactly one is selected", () => {
    expect(infoTabRoute(["abc"])).toBe("/profiles/abc/info");
    expect(infoTabRoute([])).toBe("/profiles");
    expect(infoTabRoute(["a", "b"])).toBe("/profiles");
  });
});

describe("bundle guard", () => {
  it("components/hub/ never imports from @/pages/ (would drag page chunks into the eager bundle)", () => {
    const hubDir = path.resolve(__dirname, "../client/src/components/hub");
    const files = fs.readdirSync(hubDir).filter(f => /\.(ts|tsx)$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) {
      const src = fs.readFileSync(path.join(hubDir, f), "utf8");
      // Match real static/dynamic imports, not prose in comments.
      const importsPage = /from\s+["']@\/pages\/|import\(\s*["']@\/pages\//.test(src);
      expect(importsPage, `${f} must not import @/pages/*`).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: QA report 2026-07-25 — "'Everyone → Info' displayed only the Test
// profile's personal information instead of an Everyone summary or list of
// people. Other tabs aggregate profiles, but Info behaves like the self profile
// remained selected."
//
// Info is the only hub tab whose route embeds a profile id, so a scope change
// left the URL — and therefore the page — pinned to the old profile.
// ─────────────────────────────────────────────────────────────────────────────
describe("reconcileInfoRoute — Info follows the profile scope", () => {
  const ALICE = "alice-id";
  const BOB = "bob-id";

  it("sends Everyone off a single-profile Info page to the people grid", () => {
    expect(reconcileInfoRoute(`/profiles/${ALICE}/info`, [])).toBe("/profiles");
  });

  it("redirects when the selection moves to a different profile", () => {
    expect(reconcileInfoRoute(`/profiles/${ALICE}/info`, [BOB])).toBe(`/profiles/${BOB}/info`);
  });

  it("sends a multi-select off a single-profile Info page to the grid", () => {
    expect(reconcileInfoRoute(`/profiles/${ALICE}/info`, [ALICE, BOB])).toBe("/profiles");
  });

  it("leaves a correctly-scoped Info route alone", () => {
    expect(reconcileInfoRoute(`/profiles/${ALICE}/info`, [ALICE])).toBeNull();
  });

  it("ignores every non-Info location", () => {
    expect(reconcileInfoRoute("/dashboard", [])).toBeNull();
    expect(reconcileInfoRoute("/trackers", [ALICE])).toBeNull();
    expect(reconcileInfoRoute("/profiles", [])).toBeNull();
    expect(reconcileInfoRoute(`/profiles/${ALICE}`, [])).toBeNull(); // deep page, not Info
    expect(reconcileInfoRoute("/linked?tab=assets", [BOB])).toBeNull();
  });

  it("tolerates a trailing slash", () => {
    expect(reconcileInfoRoute(`/profiles/${ALICE}/info/`, [])).toBe("/profiles");
  });
});
