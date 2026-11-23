// @vitest-environment jsdom
//
// Customize Wellness (owner's design, 2026-11-23): Visible Sections with drag
// handles and switches, Available Sections, Display Options, the dashboards
// strip, and three ways to make a card — a Widget Idea, the manual builder and
// the AI Builder. Everything edits a draft: opening writes nothing, Save
// writes the one preference row, Cancel drops it.
process.env.TZ = "UTC";
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { parseWellnessBoards, visibleWellnessCards, hiddenWellnessCards, activeWellnessBoard } from "../shared/wellness-dashboards";
import type { WellnessSourceData } from "../shared/wellness-widgets";
import { TODAY, TZ, fixtureMetrics, fixtureTrackers } from "./helpers/wellness-fixture";

vi.mock("../client/src/lib/auth", () => ({ useAuth: () => ({ getAuthHeader: () => ({}) }) }));

let stored: string | null;
let writes: string[];
let suggest: (prompt: string) => { status: number; body: any };
const trackers = fixtureTrackers();
const data: WellnessSourceData = { metrics: fixtureMetrics(trackers), trackers, journal: [], expenses: [], timezone: TZ };
const lists = { journal: { loading: false, error: false }, expenses: { loading: false, error: false } };

beforeEach(() => {
  stored = null; writes = [];
  suggest = () => ({ status: 200, body: { by: "ai", widgets: [{ id: "widget-1", title: "Exercise After Sleep", icon: "chart", kind: "compare", source: { kind: "metric", key: "sleep_hours" }, other: { kind: "workouts" }, threshold: 8, lag: 0, by: "ai" }] } });
  vi.stubGlobal("fetch", vi.fn(async (url: any, opts?: any) => {
    const u = String(url); const method = String(opts?.method || "GET");
    const json = (b: any, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (u.includes("/api/preferences/wellness_card_prefs")) {
      if (method === "PUT") { stored = JSON.parse(opts.body).value; writes.push(stored!); return json({ success: true }); }
      return json({ value: stored });
    }
    if (u.includes("/api/wellness-widgets/suggest")) {
      const r = suggest(decodeURIComponent(u.split("prompt=")[1] || ""));
      return json(r.body, r.status);
    }
    if (method !== "GET") { writes.push(`${method} ${u}`); return json({}); }
    return json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function open(onClose: () => void = () => {}) {
  const { WellnessCustomizeDialog } = await import("../client/src/components/wellness/WellnessCustomize");
  const { queryClient } = await import("../client/src/lib/queryClient");
  queryClient.clear();
  render(
    <QueryClientProvider client={queryClient}>
      <Router hook={() => ["/wellness", () => {}] as any}>
        <WellnessCustomizeDialog open onClose={onClose} data={data} lists={lists} range="30d" todayISO={TODAY} />
      </Router>
    </QueryClientProvider>,
  );
  await screen.findByTestId("wellness-customize-visible");
}
const rows = (list: string) => within(screen.getByTestId(list)).getAllByTestId(/^wellness-customize-row-/)
  .map((n) => n.getAttribute("data-testid")!.replace("wellness-customize-row-", ""));
const saved = () => parseWellnessBoards(stored);
const save = async () => { fireEvent.click(screen.getByTestId("wellness-customize-save")); await waitFor(() => expect(writes).toHaveLength(1)); };
const text = (id: string) => screen.getByTestId(id).textContent || "";

describe("the dialog matches the owner's design", () => {
  it("has the header, Visible Sections, Available Sections and Display Options", async () => {
    await open();
    const dlg = screen.getByTestId("wellness-customize");
    expect(dlg.textContent).toContain("Customize Wellness");
    expect(dlg.textContent).toContain("Choose what to show, reorder sections, and set your defaults.");
    expect(text("wellness-customize-visible-panel")).toContain("Visible Sections");
    expect(text("wellness-customize-visible-panel")).toContain("drag to reorder");
    expect(rows("wellness-customize-visible")).toEqual(["overview", "trends", "activity", "sleep", "nutrition", "body", "labs", "medications", "sources", "insights"]);
    expect(within(screen.getByTestId("wellness-customize-visible")).getAllByRole("listitem").map((li) => li.querySelector("p")!.textContent)).toEqual([
      "Wellness Overview", "Health Trends", "Activity Summary", "Sleep & Recovery", "Nutrition & Hydration", "Body & Vitals", "Labs",
      "Medications & Care", "Connected Sources", "AI Wellness Insights",
    ]);
    expect(text("wellness-customize-available-panel")).toContain("Available Sections");
    expect(text("wellness-customize-available-panel")).toContain("tap to add");
    expect(rows("wellness-customize-available")).toEqual(["mood", "symptoms", "graphs", "goals", "score"]);
    // A visible row: drag handle, switch (on), details. An available row: switch (off) and +.
    for (const part of ["drag", "show", "more"]) expect(screen.getByTestId(`wellness-customize-${part}-sleep`), part).toBeTruthy();
    expect(screen.getByTestId("wellness-customize-show-sleep").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("wellness-customize-show-mood").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("wellness-customize-add-mood")).toBeTruthy();
    const options = text("wellness-customize-options-panel");
    for (const label of ["Display Options", "Default Time Range", "Card Size", "Show Trend Graphs", "Show Comparison Change (%)", "Show Last Updated Date"]) expect(options, label).toContain(label);
    expect((screen.getByTestId("wellness-option-range") as HTMLSelectElement).value).toBe("30d");
    expect((screen.getByTestId("wellness-option-density") as HTMLSelectElement).value).toBe("compact");
    for (const k of ["trends", "comparison", "updated"]) expect(screen.getByTestId(`wellness-option-${k}`).getAttribute("aria-checked")).toBe("true");
    expect(text("wellness-customize-save")).toBe("Save Changes");
  });

  it("every drag handle opts out of the tab swipe (T1)", async () => {
    await open();
    for (const h of screen.getAllByTestId(/^wellness-customize-drag-/)) expect(h.hasAttribute("data-swipe-ignore")).toBe(true);
  });
});

describe("a draft until Save", () => {
  it("opening and editing write nothing; Cancel drops the edits", async () => {
    const onClose = vi.fn();
    await open(onClose);
    expect(writes).toEqual([]);
    expect((screen.getByTestId("wellness-customize-save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("wellness-customize-show-labs"));
    fireEvent.click(screen.getByTestId("wellness-option-trends"));
    expect((screen.getByTestId("wellness-customize-save") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("wellness-customize-cancel"));
    expect(onClose).toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(stored).toBeNull();
  });

  it("Save writes the whole draft once: sections, order and display options", async () => {
    const onClose = vi.fn();
    await open(onClose);
    fireEvent.click(screen.getByTestId("wellness-customize-show-labs"));          // off → Available
    fireEvent.click(screen.getByTestId("wellness-customize-add-mood"));           // + → Visible
    fireEvent.keyDown(screen.getByTestId("wellness-customize-drag-insights"), { key: "ArrowUp" });
    fireEvent.change(screen.getByTestId("wellness-option-range"), { target: { value: "90d" } });
    fireEvent.change(screen.getByTestId("wellness-option-density"), { target: { value: "comfortable" } });
    fireEvent.click(screen.getByTestId("wellness-option-updated"));
    expect(rows("wellness-customize-available")).toContain("labs");
    expect(rows("wellness-customize-visible")).toContain("mood");
    await save();
    const b = saved();
    expect(visibleWellnessCards(b)).toEqual(["overview", "trends", "activity", "sleep", "nutrition", "body", "medications", "insights", "sources", "mood"]);
    expect(hiddenWellnessCards(b)).toContain("labs");
    expect(b.options).toEqual({ range: "90d", density: "comfortable", trends: true, comparison: true, updated: false });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("a section can be made half width", async () => {
    await open();
    fireEvent.click(screen.getByTestId("wellness-customize-more-sleep"));
    fireEvent.change(screen.getByTestId("wellness-customize-size-sleep"), { target: { value: "medium" } });
    await save();
    expect(activeWellnessBoard(saved()).sizes).toEqual({ sleep: "medium" });
  });

  it("Reset puts the built-in sections and options back in the draft", async () => {
    await open();
    fireEvent.click(screen.getByTestId("wellness-customize-show-labs"));
    fireEvent.change(screen.getByTestId("wellness-option-range"), { target: { value: "7d" } });
    fireEvent.click(screen.getByTestId("wellness-customize-reset"));
    expect(rows("wellness-customize-visible")).toContain("labs");
    expect((screen.getByTestId("wellness-option-range") as HTMLSelectElement).value).toBe("30d");
    expect(writes).toEqual([]);
  });
});

describe("building a card by hand (no AI)", () => {
  it("pick the data, the calculation and the display; the preview is your own records; Add then Save keeps it", async () => {
    await open();
    fireEvent.click(screen.getByTestId("wellness-customize-builder-manual"));
    expect(text("wellness-builder-preview")).toContain("Give the widget a name");
    expect((screen.getByTestId("wellness-builder-add") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("wellness-widget-form-title"), { target: { value: "Guitar minutes" } });
    fireEvent.change(screen.getByTestId("wellness-widget-form-source-kind"), { target: { value: "tracker" } });
    fireEvent.change(screen.getByTestId("wellness-widget-form-source-tracker"), { target: { value: "Guitar practice" } });
    fireEvent.change(screen.getByTestId("wellness-widget-form-source-field"), { target: { value: "minutes" } });
    fireEvent.change(screen.getByTestId("wellness-widget-form-calc"), { target: { value: "total" } });
    fireEvent.click(screen.getByTestId("wellness-widget-form-display-bar"));
    fireEvent.click(screen.getByTestId("wellness-widget-form-range-7d"));
    // 30 + 45 minutes this week, from the tracker's own entries.
    expect(text("wellness-widget-value-new-widget")).toBe("75 min");
    expect(writes).toEqual([]);
    fireEvent.click(screen.getByTestId("wellness-builder-add"));
    expect(rows("wellness-customize-visible")).toContain("w:guitar-minutes");
    await save();
    expect(saved().widgets).toEqual([{
      id: "guitar-minutes", title: "Guitar minutes", icon: "heart", kind: "metric", by: "manual", range: "7d",
      source: { kind: "tracker", key: "Guitar practice", field: "minutes" }, calc: "total", display: "bar",
    }]);
  });

  it("a comparison and a custom score can be built the same way", async () => {
    await open();
    fireEvent.click(screen.getByTestId("wellness-customize-builder-manual"));
    fireEvent.change(screen.getByTestId("wellness-widget-form-title"), { target: { value: "Runs after sleep" } });
    fireEvent.click(screen.getByTestId("wellness-widget-form-kind-compare"));
    fireEvent.change(screen.getByTestId("wellness-widget-form-source-metric"), { target: { value: "sleep_hours" } });
    fireEvent.change(screen.getByTestId("wellness-widget-form-threshold"), { target: { value: "8" } });
    expect(text("wellness-builder-preview")).toContain("Sleep 8 h or more");
    expect(text("wellness-builder-preview")).toContain("not a medical conclusion");
    fireEvent.click(screen.getByTestId("wellness-widget-form-kind-score"));
    expect(screen.getByTestId("wellness-widget-form-part-0")).toBeTruthy();
    fireEvent.click(screen.getByTestId("wellness-widget-form-part-add"));
    expect(screen.getByTestId("wellness-widget-form-part-1")).toBeTruthy();
    expect(text("wellness-builder-preview")).toContain("out of 100");
  });

  it("an existing card can be edited, duplicated and removed (two taps)", async () => {
    await open();
    fireEvent.click(screen.getByTestId("wellness-customize-idea-consistency"));
    const id = "w:exercise-consistency";
    fireEvent.click(screen.getByTestId(`wellness-customize-more-${id}`));
    expect(text("wellness-widget-value-exercise-consistency")).toBe("5 entries");
    fireEvent.change(screen.getByTestId("wellness-edit-exercise-consistency-calc"), { target: { value: "average" } });
    fireEvent.click(screen.getByTestId("wellness-customize-duplicate-exercise-consistency"));
    expect(rows("wellness-customize-visible").filter((r) => r.startsWith("w:"))).toHaveLength(2);
    const remove = screen.getByTestId("wellness-customize-remove-exercise-consistency");
    fireEvent.click(remove);
    expect(remove.textContent).toContain("Tap again to remove");
    expect(rows("wellness-customize-visible")).toContain(id);
    fireEvent.click(remove);
    expect(rows("wellness-customize-visible")).not.toContain(id);
    await save();
    expect(saved().widgets.map((w) => [w.title, w.calc])).toEqual([["Exercise Consistency copy", "average"]]);
  });
});

describe("a widget in your own words", () => {
  it("the box is the first thing in the dialog, in view without opening anything", async () => {
    await open();
    const scroll = screen.getByTestId("wellness-customize-scroll");
    expect(scroll.firstElementChild!.getAttribute("data-testid")).toBe("wellness-builder-ai");
    expect(text("wellness-builder-ai")).toContain("Create a widget in your own words");
    expect(screen.getByTestId("wellness-ai-prompt")).toBeTruthy();
    expect((screen.getByTestId("wellness-ai-build") as HTMLButtonElement).disabled).toBe(true); // nothing typed yet
    expect(screen.queryByTestId("wellness-customize-builder-ai")).toBeNull(); // no toggle to find first
  });

  it("an example fills the box and builds nothing until asked", async () => {
    let asked = 0;
    const was = suggest; suggest = (p) => { asked++; return was(p); };
    await open();
    fireEvent.click(within(screen.getByTestId("wellness-ai-examples")).getByText("How often I work out"));
    expect((screen.getByTestId("wellness-ai-prompt") as HTMLTextAreaElement).value).toBe("How often I work out");
    expect(asked).toBe(0);
    expect(writes).toEqual([]);
    fireEvent.click(screen.getByTestId("wellness-ai-build"));
    await screen.findByTestId("wellness-ai-proposal-0");
    expect(asked).toBe(1);
  });
});

describe("the AI Builder proposes; the user adds", () => {
  it("a sentence becomes a proposal with a live preview; nothing is kept until Add and Save", async () => {
    await open();
    fireEvent.change(screen.getByTestId("wellness-ai-prompt"), { target: { value: "Do I exercise more after sleeping eight hours?" } });
    fireEvent.click(screen.getByTestId("wellness-ai-build"));
    await screen.findByTestId("wellness-ai-proposal-0");
    expect(text("wellness-ai-proposal-0")).toContain("Exercise After Sleep");
    expect(text("wellness-ai-summary")).toContain("Proposed by AI");
    expect(text("wellness-ai-proposal-0")).toContain("Sleep 8 h or more");
    expect(rows("wellness-customize-visible").some((r) => r.startsWith("w:"))).toBe(false);
    expect(writes).toEqual([]);
    fireEvent.click(screen.getByTestId("wellness-ai-use-0"));
    expect(rows("wellness-customize-visible")).toContain("w:exercise-after-sleep");
    await save();
    expect(saved().widgets[0]).toMatchObject({ kind: "compare", by: "ai", threshold: 8 });
  });

  it("Discard drops the proposal", async () => {
    await open();
    fireEvent.change(screen.getByTestId("wellness-ai-prompt"), { target: { value: "sleep and workouts" } });
    fireEvent.click(screen.getByTestId("wellness-ai-build"));
    await screen.findByTestId("wellness-ai-proposal-0");
    fireEvent.click(screen.getByTestId("wellness-ai-discard-0"));
    expect(screen.queryByTestId("wellness-ai-proposal-0")).toBeNull();
    expect((screen.getByTestId("wellness-customize-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("an answer the tab cannot draw is refused, not shown", async () => {
    suggest = () => ({ status: 200, body: { by: "ai", widgets: [{ id: "w", title: "All my data", kind: "metric", source: { kind: "sql", key: "select *" } }] } });
    await open();
    fireEvent.change(screen.getByTestId("wellness-ai-prompt"), { target: { value: "show me everything" } });
    fireEvent.click(screen.getByTestId("wellness-ai-build"));
    await screen.findByTestId("wellness-ai-error");
    expect(screen.queryByTestId("wellness-ai-proposal-0")).toBeNull();
  });

  it("says when the fixed rules, not the model, read the sentence", async () => {
    suggest = () => ({ status: 200, body: { by: "rules", widget: { id: "w", title: "Sleep", kind: "metric", source: { kind: "metric", key: "sleep_hours" }, calc: "average", display: "line" } } });
    await open();
    fireEvent.change(screen.getByTestId("wellness-ai-prompt"), { target: { value: "my sleep average" } });
    fireEvent.click(screen.getByTestId("wellness-ai-build"));
    await screen.findByTestId("wellness-ai-proposal-0");
    expect(text("wellness-ai-summary")).toContain("Read by fixed rules");
    expect(text("wellness-ai-proposal-0")).toContain("7.8 h");
  });
});

describe("a whole dashboard from one description", () => {
  const many = () => ({ status: 200, body: { by: "ai", name: "Running & Sleep", widgets: [
    { id: "widget-1", title: "Running Distance", kind: "metric", source: { kind: "tracker", key: "Running", field: "distance" }, calc: "total", display: "bar", by: "ai" },
    { id: "widget-2", title: "Weekly Sleep", kind: "metric", source: { kind: "metric", key: "sleep_hours" }, calc: "average", display: "number", range: "7d", by: "ai" },
    { id: "widget-3", title: "Cycling Distance", kind: "metric", source: { kind: "tracker", key: "Cycling" }, calc: "total", display: "bar", by: "ai" },
  ] } });
  const build = async (said: string) => {
    fireEvent.change(screen.getByTestId("wellness-ai-prompt"), { target: { value: said } });
    fireEvent.click(screen.getByTestId("wellness-ai-build"));
    await screen.findByTestId("wellness-ai-proposals");
  };

  it("each card is previewed from the person's own trackers; one over a tracker they do not have is not offered", async () => {
    suggest = many;
    await open();
    await build("running distance, weekly sleep and cycling distance");
    expect(screen.getAllByTestId(/^wellness-ai-proposal-\d+$/)).toHaveLength(2);
    // Five runs of 2 mi in the last 30 days.
    expect(text("wellness-ai-proposal-0")).toContain("Running Distance");
    expect(text("wellness-ai-proposal-0")).toContain("10 mi");
    expect(text("wellness-ai-proposal-1")).toContain("7.9 h");
    expect(text("wellness-ai-summary")).toContain("2 cards");
    expect(text("wellness-ai-summary")).toContain("1 could not be built: you have no tracker for it.");
    expect(writes).toEqual([]);
  });

  it("Add all puts them on the dashboard being edited", async () => {
    suggest = many;
    await open();
    await build("running distance and weekly sleep");
    fireEvent.click(screen.getByTestId("wellness-ai-add-all"));
    expect(screen.queryByTestId("wellness-ai-proposals")).toBeNull();
    expect(rows("wellness-customize-visible").slice(-2)).toEqual(["w:running-distance", "w:weekly-sleep"]);
    await save();
    expect(saved().widgets.map((w) => [w.title, w.by])).toEqual([["Running Distance", "ai"], ["Weekly Sleep", "ai"]]);
    expect(saved().dashboards).toHaveLength(1);
  });

  it("Make a new dashboard holds exactly those cards and leaves the first dashboard as it was", async () => {
    suggest = many;
    await open();
    await build("running distance and weekly sleep");
    expect(text("wellness-ai-new-dashboard")).toBe("Make a new dashboard: Running & Sleep");
    fireEvent.click(screen.getByTestId("wellness-ai-new-dashboard"));
    expect(screen.getByTestId("wellness-customize-board-running-sleep").getAttribute("aria-pressed")).toBe("true");
    expect(rows("wellness-customize-visible")).toEqual(["w:running-distance", "w:weekly-sleep"]);
    await save();
    const b = saved();
    expect(b.dashboards.map((d) => d.name)).toEqual(["Overview", "Running & Sleep"]);
    expect(b.active).toBe("running-sleep");
    expect(visibleWellnessCards({ ...b, active: "overview" })).toHaveLength(10);
  });

  it("when nothing it proposed can be drawn from the person's trackers, it says so instead of offering it", async () => {
    suggest = () => ({ status: 200, body: { by: "ai", widgets: [{ id: "w", title: "Cycling Distance", kind: "metric", source: { kind: "tracker", key: "Cycling" }, calc: "total", display: "bar" }] } });
    await open();
    fireEvent.change(screen.getByTestId("wellness-ai-prompt"), { target: { value: "my cycling distance" } });
    fireEvent.click(screen.getByTestId("wellness-ai-build"));
    await screen.findByTestId("wellness-ai-error");
    expect(screen.queryByTestId("wellness-ai-proposals")).toBeNull();
  });
});

describe("cards offered from the person's own trackers", () => {
  it("lists what has data, and one tap adds a card that already shows it", async () => {
    await open();
    const offers = within(screen.getByTestId("wellness-customize-from-trackers")).getAllByRole("button").map((b) => b.textContent);
    expect(offers.some((o) => o!.includes("Sleep Trend") && o!.includes("20 readings"))).toBe(true);
    expect(offers.some((o) => o!.includes("Guitar Practice Minutes"))).toBe(true);
    fireEvent.click(screen.getByTestId("wellness-customize-suggest-tracker:t-guitar:minutes"));
    expect(rows("wellness-customize-visible")).toContain("w:guitar-practice-minutes");
    // Offered once: it is no longer in the list.
    expect(screen.queryByTestId("wellness-customize-suggest-tracker:t-guitar:minutes")).toBeNull();
    fireEvent.click(screen.getByTestId("wellness-customize-more-w:guitar-practice-minutes"));
    expect(text("wellness-widget-value-guitar-practice-minutes")).toBe("75 min");
    await save();
    expect(saved().widgets[0]).toMatchObject({ source: { kind: "tracker", key: "Guitar practice", field: "minutes" }, calc: "total" });
  });
});

describe("several dashboards", () => {
  it("a new dashboard starts from a template and is the one being edited; deleting takes two taps and never the last", async () => {
    await open();
    expect(screen.queryByTestId("wellness-customize-board-delete")).toBeNull(); // one dashboard: no delete
    fireEvent.click(screen.getByTestId("wellness-customize-board-new"));
    expect(within(screen.getByTestId("wellness-customize-templates")).getAllByRole("button").map((b) => b.querySelector("span")!.textContent))
      .toEqual(["Overview", "Fitness", "Medical", "Nutrition", "Mind", "Blank"]);
    fireEvent.click(screen.getByTestId("wellness-customize-template-fitness"));
    expect(screen.getByTestId("wellness-customize-board-fitness").getAttribute("aria-pressed")).toBe("true");
    expect(rows("wellness-customize-visible").slice(0, 4)).toEqual(["activity", "sleep", "trends", "goals"]);
    fireEvent.change(screen.getByTestId("wellness-customize-board-name"), { target: { value: "Training" } });
    // The first dashboard is untouched.
    fireEvent.click(screen.getByTestId("wellness-customize-board-overview"));
    expect(rows("wellness-customize-visible")).toHaveLength(10);
    fireEvent.click(screen.getByTestId("wellness-customize-board-fitness"));
    await save();
    expect(saved().dashboards.map((d) => d.name)).toEqual(["Overview", "Training"]);
    expect(saved().active).toBe("fitness");
    expect(saved().widgets.map((w) => w.title)).toEqual(["Exercise Consistency", "Sleep vs. Exercise"]);

  });

  it("deleting a dashboard takes two taps and keeps the cards it showed", async () => {
    await open();
    fireEvent.click(screen.getByTestId("wellness-customize-board-new"));
    fireEvent.click(screen.getByTestId("wellness-customize-template-fitness"));
    const del = screen.getByTestId("wellness-customize-board-delete");
    fireEvent.click(del);
    expect(del.textContent).toContain("Tap again to delete");
    expect(screen.queryByTestId("wellness-customize-board-fitness")).toBeTruthy();
    fireEvent.click(del);
    expect(screen.queryByTestId("wellness-customize-board-fitness")).toBeNull();
    expect(screen.queryByTestId("wellness-customize-board-delete")).toBeNull(); // the last one cannot be deleted
    await save();
    expect(saved().dashboards.map((d) => d.id)).toEqual(["overview"]);
    expect(saved().widgets).toHaveLength(2);
  });
});
