// @vitest-environment jsdom
//
// QA pass 2026-08-05, "broken navigation and clicks". Every case here is a
// control that rendered perfectly and went nowhere — the kind of defect tsc and
// a screenshot both pass.
//
//   #3  notification rows            → a bill opened the expenses page
//   #4  global search results        → 9 of 10 result types opened /dashboard
//   #5  wellness tracker cards       → all ~35 opened the bare tracker list
//   #6  "+N more" expanders          → the button removed itself, no rows came
//   #7  "Back to Linked" breadcrumb  → opened Trackers, not the Assets listing
//   #8  a collapsible that never expanded
//   #9  /liabilities titled itself "Trackers — Portol"
//
// The link targets are asserted against the source: they are one-line strings
// with no behaviour to drive, and a render test of the pages that hold them
// would need most of the app. The expander gets a real DOM test, because the
// bug there was structural and a string check would not have caught it.

import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { readFileSync } from "fs";
import { resolve as resolvePath } from "path";
import { ExpandableRows } from "../client/src/components/dashboard/ExecutiveBriefing";

const read = (p: string) => readFileSync(resolvePath(__dirname, "..", p), "utf8");

afterEach(cleanup);

// ── #6 / #8 — an expander has to expand ──────────────────────────────────────
// ExpandableRows is the Executive tab's card expander ("View all (N)"). The
// invariant it guards: the FULL list is in props and the collapsing happens in
// the UI — the 2026-08-05 regression was a builder that truncated the list
// first, leaving the button nothing to reveal.
describe("'View all (N)' reveals the rows it promises", () => {
  const CAP = 4;
  const renderRows = (n: number) =>
    render(
      <ExpandableRows id="attention" count={n} cap={CAP}>
        {Array.from({ length: n }, (_, i) => <p key={i}>{`Item ${i}`}</p>)}
      </ExpandableRows>,
    );

  it("collapses to the display cap and offers the remainder", () => {
    renderRows(CAP + 5);
    expect(screen.getAllByText(/^Item \d+$/).length).toBe(CAP);
    expect(screen.getByTestId("exec-more-attention").textContent).toContain(`View all (${CAP + 5})`);
  });

  it("renders the hidden rows when pressed — the whole point of the button", () => {
    // THE regression: this used to hide the button and render nothing new,
    // because the builder had truncated the list before it ever got here.
    renderRows(CAP + 5);
    fireEvent.click(screen.getByTestId("exec-more-attention"));
    expect(screen.getAllByText(/^Item \d+$/).length).toBe(CAP + 5);
    expect(screen.getByText("Item 8")).toBeTruthy();
  });

  it("shows no button when everything already fits", () => {
    renderRows(CAP);
    expect(screen.queryByTestId("exec-more-attention")).toBeNull();
  });
});

// ── #4 — search results open the record, not the dashboard ───────────────────
describe("global search results go somewhere", () => {
  // The palette body moved to CommandSearchDialog.tsx when the ⌘K chunk was made
  // lazy (first-paint perf); the search groups this test reads live there now.
  const src = read("client/src/components/CommandSearchDialog.tsx");
  // Each result group's onSelect sits directly above its data-testid.
  const targetFor = (kind: string): string => {
    const re = new RegExp(
      `onSelect=\\{\\(\\) => handleSelect\\(([^,]+), query\\)\\}\\s*\\n\\s*data-testid=\\{\`item-search-${kind}-`,
    );
    const m = src.match(re);
    expect(m, `no search group for ${kind}`).toBeTruthy();
    return m![1].trim();
  };

  it("never dumps a result onto the generic dashboard", () => {
    // Nine of ten groups did exactly this, which is why clicking a bill "closed
    // the dialog and navigated nowhere" when you were already on the dashboard.
    for (const kind of ["task", "expense", "event", "document", "habit", "journal", "obligation", "artifact", "tracker"]) {
      expect(targetFor(kind), kind).not.toBe('"/dashboard"');
    }
  });

  it("deep-links the record itself wherever a record route exists", () => {
    expect(targetFor("tracker")).toBe("`/trackers?tracker=${t.id}`");
    expect(targetFor("document")).toBe("`/documents/${d.id}`");
    expect(targetFor("profile")).toBe("`/profiles/${p.id}`");
  });

  it("sends the rest to their own page", () => {
    expect(targetFor("task")).toBe('"/dashboard/tasks"');
    expect(targetFor("expense")).toBe('"/dashboard/finance"');
    expect(targetFor("event")).toBe('"/calendar"');
    expect(targetFor("habit")).toBe('"/dashboard/habits"');
    expect(targetFor("journal")).toBe('"/dashboard/journal"');
    expect(targetFor("obligation")).toBe('"/dashboard/obligations"');
    expect(targetFor("artifact")).toBe('"/artifacts"');
  });

  it("routes query-carrying targets through hashNavigate", () => {
    // wouter's hash navigate hoists "?tracker=…" out of the hash, so the deep
    // link would ride on the document URL instead of the route.
    expect(/if \(path\.includes\("\?"\)\) hashNavigate\(path\);/.test(src)).toBe(true);
  });
});

// ── #5 — a wellness card opens ITS tracker ───────────────────────────────────
describe("wellness metric cards open the tracker they show", () => {
  const src = read("client/src/components/wellness/WellnessOverview.tsx");

  it("links to the card's own tracker, not the bare list", () => {
    expect(/href=\{`#\/trackers\?tracker=\$\{card\.id\}`\}/.test(src)).toBe(true);
  });

  it("has no hardcoded /trackers link left", () => {
    expect(/href="\/trackers"/.test(src)).toBe(false);
  });
});

// ── The Linked list's tracker rows pointed at a route that does not exist ────
describe("tracker rows in the Linked list", () => {
  it("use the ?tracker= deep link, not the non-existent /trackers/:id page", () => {
    const src = read("client/src/pages/trackers.tsx");
    expect(/href: `\/trackers\/\$\{t\.id\}`/.test(src)).toBe(false);
    expect(/href: `\/trackers\?tracker=\$\{t\.id\}`/.test(src)).toBe(true);
  });

  it("and /trackers/:id is still not a route, so the old href really was dead", () => {
    const app = read("client/src/App.tsx");
    expect(/path="\/trackers\/:/.test(app)).toBe(false);
  });
});

// ── #7 — Back goes to the listing the profile came from ──────────────────────
describe("profile back link", () => {
  const src = read("client/src/pages/profile-detail.tsx");

  it("sends assets to the Assets listing rather than the Trackers page", () => {
    expect(/const backHref = listedUnderAssets \? "\/linked\?tab=assets"/.test(src)).toBe(true);
    expect(/backHref = isLinkedType \? "\/trackers"/.test(src)).toBe(false);
  });

  it("labels it for the place it actually goes", () => {
    expect(src.includes('"Back to Assets"')).toBe(true);
  });
});

// ── Liabilities get the same treatment assets did ────────────────────────────
describe("liability back link", () => {
  const src = read("client/src/pages/liability-detail.tsx");

  it("sends a liability to the Liabilities listing, not the Profiles page", () => {
    expect(/backHref="\/linked\?tab=liabilities"/.test(src)).toBe(true);
    expect(/onBack=\{\(\) => navigate\("\/profiles"\)\}/.test(src)).toBe(false);
  });

  it("labels it for the place it actually goes", () => {
    expect(src.includes('backLabel="Back to Liabilities"')).toBe(true);
    expect(src.includes('backLabel="Back"')).toBe(false);
  });
});

// ── #3 — a bill notification opens the bills ─────────────────────────────────
describe("notification rows", () => {
  it("send a bill to the Bills page, not to expenses", () => {
    const src = read("client/src/components/NotificationBell.tsx");
    const m = src.match(/case "bill_due":\s*(?:\n\s*\/\/[^\n]*)*\s*\n\s*setLocation\("([^"]+)"\);/);
    expect(m, "bill_due case not found").toBeTruthy();
    expect(m![1]).toBe("/dashboard/obligations");
  });
});

// ── #9 — the page tells you which page it is ─────────────────────────────────
describe("page titles", () => {
  it("titles /liabilities as Liabilities in both places that set it", () => {
    expect(read("client/src/App.tsx").includes('"/liabilities": "Liabilities — Portol"')).toBe(true);
    const trackers = read("client/src/pages/trackers.tsx");
    expect(/startsWith\('\/liabilities'\) \? "Liabilities — Portol"/.test(trackers)).toBe(true);
  });
});

// ── #8 — components must not be declared inside other components ─────────────
describe("no component is defined inside another component's body", () => {
  // A nested definition gets a new function identity every parent render, so
  // React unmounts and remounts it: state resets, inputs lose focus, and an
  // expander snaps shut on the next unrelated re-render. That is what made the
  // bills group "never expand".
  it("dashboard.tsx declares its components at module scope", () => {
    const src = read("client/src/pages/dashboard.tsx");
    const nested = [...src.matchAll(/^ {2,}function ([A-Z]\w*)\(/gm)].map(m => m[1]);
    expect(nested, `hoist to module scope: ${nested.join(", ")}`).toEqual([]);
  });
});
