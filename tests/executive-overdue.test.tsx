// @vitest-environment jsdom
//
// Audit 2026-07-29, finding D3: "Nothing overdue 🎉 and 4 overdue bills on the
// same screen."
//
// The Executive briefing's OVERDUE accordion counted only overdue TASKS, but
// wore the unqualified title "Overdue" and the empty state "Nothing overdue.
// 🎉". On the audited screen that card declared all-clear while Attention, the
// Bills section, the AI brief and the notification bell all reported four
// overdue bills totalling ~$2,817. A user who read the reassuring card first
// would have sailed past $2,500 of overdue rent.
//
// These tests mount the real component so the assertion is about what renders,
// not about how the filter is written.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { ExecutiveBriefing } from "../client/src/components/dashboard/ExecutiveBriefing";

vi.mock("../client/src/lib/auth", () => ({
  useAuth: () => ({ getAuthHeader: () => ({}) }),
}));

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver || ResizeObserverStub;

afterEach(cleanup);

// Four overdue bills in the shape the finance snapshot delivers them, standing
// in for the audited screen's rent / phone / utility set.
const OVERDUE_BILLS = [
  { id: "b-rent", name: "Rent the 1st", amount: 2500, daysUntil: -28, status: "overdue" },
  { id: "b-phone", name: "Phone Bill payment", amount: 86.5, daysUntil: -12, status: "overdue" },
  { id: "b-elec", name: "Electric bill", amount: 140, daysUntil: -5, status: "overdue" },
  { id: "b-water", name: "Water Bill payment", amount: 90.5, daysUntil: -2, status: "overdue" },
];

function mount(bills: any[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  // Every list this component reads resolves empty, so overdue TASKS are zero
  // — the exact state that used to produce the false all-clear.
  for (const key of ["/api/tasks", "/api/habits", "/api/reminders", "/api/goals", "/api/journal", "/api/notifications"]) {
    qc.setQueryData([key, "everyone"], []);
  }
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={() => ["/dashboard", () => {}] as any}>
        <ExecutiveBriefing
          filterMode="everyone"
          filterIds={[]}
          stats={undefined}
          enhanced={{ financeSnapshot: { upcomingBills: bills } }}
        />
      </Router>
    </QueryClientProvider>,
  );
}

describe("Executive briefing · Overdue section (D3)", () => {
  it("does not claim all-clear while bills are overdue", () => {
    mount(OVERDUE_BILLS);
    const section = screen.getByTestId("brief-overdue").textContent || "";
    expect(section).not.toContain("Nothing overdue");
  });

  it("counts overdue bills alongside overdue tasks", () => {
    mount(OVERDUE_BILLS);
    // Zero overdue tasks + four overdue bills — the header must say four, the
    // same number Attention and the notification bell report.
    expect(screen.getByTestId("brief-overdue").textContent).toContain("4");
  });

  it("names the overdue bills so the card is actionable, not just alarming", () => {
    mount(OVERDUE_BILLS);
    const section = screen.getByTestId("brief-overdue").textContent || "";
    expect(section).toContain("Rent the 1st");
    expect(section).toContain("$2,500");
  });

  it("renders one row per overdue bill — the count is the length of the list", () => {
    mount(OVERDUE_BILLS);
    for (const b of OVERDUE_BILLS) {
      expect(screen.getByTestId(`brief-overdue-bill-${b.id}`)).toBeTruthy();
    }
  });

  it("still celebrates when nothing at all is overdue", () => {
    // The 🎉 is not the bug — claiming it while bills are overdue was. With a
    // genuinely clear board it must still be reachable. An empty section
    // renders collapsed, so expand it the way a user would.
    mount([{ id: "b-fut", name: "Netflix", amount: 10, daysUntil: 6, status: "upcoming" }]);
    const section = screen.getByTestId("brief-overdue");
    fireEvent.click(section.querySelector("button")!);
    expect(section.textContent).toContain("Nothing overdue");
  });

  it("opens itself only when there is something overdue to see", () => {
    mount(OVERDUE_BILLS);
    expect(screen.getByTestId("brief-overdue").querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
    cleanup();
    mount([{ id: "b-fut", name: "Netflix", amount: 10, daysUntil: 6, status: "upcoming" }]);
    expect(screen.getByTestId("brief-overdue").querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
  });
});
