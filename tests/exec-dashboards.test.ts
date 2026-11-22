// Several Executive dashboards, each its own layout over one set of cards
// (shared/exec-dashboards). Owner request 2026-11-22.
import { describe, it, expect } from "vitest";
import {
  DASHBOARD_TEMPLATES, MAX_DASHBOARDS, parseExecDashboards, serializeExecDashboards, defaultExecDashboards,
  activeExecPrefs, withActiveExecPrefs, addDashboard, removeDashboard, renameDashboard, setActiveDashboard,
} from "../shared/exec-dashboards";
import { addExecWidget, removeExecWidget, isExecCardVisible, setExecCardVisible, EXEC_CARD_IDS, orderedExecCards } from "../shared/exec-card-prefs";
import { buildWidgetView, sanitizeWidget, type ExecWidget } from "../shared/exec-widgets";

const journal: ExecWidget = { id: "journal", title: "Recent Journal", icon: "book", source: "journal", limit: 3 };
const visible = (b: ReturnType<typeof defaultExecDashboards>) => { const p = activeExecPrefs(b); return orderedExecCards(p).filter((id) => isExecCardVisible(p, id)); };

describe("the stored row", () => {
  it("starts as one dashboard, Main, in quiet mode — the standard cards", () => {
    const b = parseExecDashboards(null);
    expect(b.dashboards.map((d) => [d.id, d.name])).toEqual([["main", "Main"]]);
    expect(visible(b)).toEqual(["attention", "tasks", "schedule", "money"]);
  });

  it("reads a layout saved before there were several dashboards as Main, unchanged", () => {
    const old = JSON.stringify({ quiet: false, hidden: ["money"], order: ["tasks"], sizes: { tasks: "large" }, widgets: [journal] });
    const b = parseExecDashboards(old);
    expect(b.active).toBe("main");
    expect(b.dashboards).toEqual([{ id: "main", name: "Main", quiet: false, hidden: ["money"], order: ["tasks"], sizes: { tasks: "large" } }]);
    expect(b.widgets).toEqual([journal]);
  });

  it("round-trips, and drops what it does not recognise", () => {
    const b = addDashboard(parseExecDashboards(null), "Finances", "money");
    expect(parseExecDashboards(serializeExecDashboards(b))).toEqual(b);
    const messy = JSON.stringify({ v: 2, active: "gone", widgets: [journal, { id: "x", title: "Bad", source: "passwords" }],
      dashboards: [{ id: "a", name: "A", quiet: false, hidden: ["money", "w:journal", "w:nope"], order: [], sizes: {} }, { id: "a", name: "Dup" }, { name: "No id" }, null] });
    const p = parseExecDashboards(messy);
    expect(p.dashboards.map((d) => d.id)).toEqual(["a"]);
    expect(p.active).toBe("a");
    expect(p.dashboards[0].hidden).toEqual(["money", "w:journal"]);
    expect(p.widgets).toEqual([journal]);
    expect(parseExecDashboards("not json")).toEqual(defaultExecDashboards());
    expect(parseExecDashboards(JSON.stringify({ dashboards: [] })).dashboards).toHaveLength(1);
  });
});

describe("dashboards are separate layouts", () => {
  it("a change on one leaves the other alone", () => {
    let b = addDashboard(parseExecDashboards(null), "Everything", "everything");
    b = withActiveExecPrefs(b, setExecCardVisible(activeExecPrefs(b), "money", false));
    expect(visible(b)).not.toContain("money");
    expect(visible(setActiveDashboard(b, "main"))).toEqual(["attention", "tasks", "schedule", "money"]);
  });

  it("a card built on one dashboard starts hidden on the others, and is theirs to switch on", () => {
    let b = addDashboard(parseExecDashboards(null), "Notes", "blank");
    b = withActiveExecPrefs(b, addExecWidget(activeExecPrefs(b), journal));
    expect(visible(b)).toEqual(["w:journal"]);
    const main = setActiveDashboard(b, "main");
    expect(visible(main)).not.toContain("w:journal");
    expect(visible(withActiveExecPrefs(main, setExecCardVisible(activeExecPrefs(main), "w:journal", true)))).toContain("w:journal");
  });

  it("removing a card removes it from every dashboard", () => {
    let b = addDashboard(parseExecDashboards(null), "Notes", "blank");
    b = withActiveExecPrefs(b, addExecWidget(activeExecPrefs(b), journal));
    b = withActiveExecPrefs(b, removeExecWidget(activeExecPrefs(b), "journal"));
    expect(b.widgets).toEqual([]);
    for (const d of b.dashboards) expect([...d.hidden, ...d.order, ...Object.keys(d.sizes)].filter((id) => id.startsWith("w:")), d.id).toEqual([]);
  });
});

describe("starting points", () => {
  it("every template makes a dashboard of its own cards, in its order", () => {
    for (const t of DASHBOARD_TEMPLATES) {
      const b = addDashboard(parseExecDashboards(null), "", t.key);
      const d = b.dashboards[1];
      expect(b.active, t.key).toBe(d.id);
      expect(d.name, t.key).toBe(t.name);
      const shown = visible(b);
      expect(shown.filter((id) => !id.startsWith("w:")), t.key).toEqual(t.quiet ? ["attention", "tasks", "schedule", "money"] : t.cards);
      expect(shown.filter((id) => id.startsWith("w:")).length, t.key).toBe(t.widgets.length);
      for (const w of b.widgets) expect(sanitizeWidget(w), `${t.key}:${w.title}`).toEqual(w);
    }
  });
  it("Blank is empty; Everything is all eight standard cards", () => {
    expect(visible(addDashboard(parseExecDashboards(null), "", "blank"))).toEqual([]);
    expect(visible(addDashboard(parseExecDashboards(null), "", "everything"))).toEqual([...EXEC_CARD_IDS]);
  });
  it("reuses a card the user already has instead of making a second one", () => {
    let b = addDashboard(parseExecDashboards(null), "Money", "money");
    b = addDashboard(b, "Money again", "money");
    expect(b.widgets.map((w) => w.title)).toEqual(["Spending This Month", "Upcoming Bills", "Accounts & Investments"]);
    expect(b.dashboards.map((d) => d.id)).toEqual(["main", "money", "money-again"]);
  });
  it("names are unique ids, and there is a limit", () => {
    let b = parseExecDashboards(null);
    for (let i = 0; i < 12; i++) b = addDashboard(b, "Work", "blank");
    expect(b.dashboards).toHaveLength(MAX_DASHBOARDS);
    expect(new Set(b.dashboards.map((d) => d.id)).size).toBe(MAX_DASHBOARDS);
  });
});

describe("rename and delete", () => {
  it("renames; a blank name is ignored", () => {
    const b = parseExecDashboards(null);
    expect(renameDashboard(b, "main", "  Home   base ").dashboards[0].name).toBe("Home base");
    expect(renameDashboard(b, "main", "   ")).toBe(b);
  });
  it("never deletes the last dashboard; deleting the active one shows another; cards are kept", () => {
    const one = parseExecDashboards(null);
    expect(removeDashboard(one, "main")).toBe(one);
    const two = addDashboard(one, "Money", "money");
    const back = removeDashboard(two, "money");
    expect(back.dashboards.map((d) => d.id)).toEqual(["main"]);
    expect(back.active).toBe("main");
    expect(back.widgets).toHaveLength(3);
  });
});

describe("cards for bills and events", () => {
  const TODAY = "2026-11-22";
  const w = (over: Partial<ExecWidget>): ExecWidget => ({ id: "x", title: "X", icon: "star", source: "bills", limit: 5, ...over });
  it("Upcoming Bills lists each bill at its NEXT date, with the total (rule A7)", () => {
    const view = buildWidgetView(w({ source: "bills" }), { bills: [
      { id: "s", name: "Spotify", amount: 11, frequency: "monthly", nextDueDate: "2026-07-30", status: "active" },   // stale → Nov 30
      { id: "n", name: "Netflix", amount: 10, frequency: "monthly", nextDueDate: "2026-12-02", status: "active" },
      { id: "p", name: "Paused", amount: 99, frequency: "monthly", nextDueDate: "2026-11-25", status: "paused" },
      { id: "y", name: "Yearly", amount: 500, frequency: "yearly", nextDueDate: "2027-06-01", status: "active" },    // outside 30 days
    ] }, TODAY);
    expect(view.rows.map((r) => [r.title, r.sub, r.right])).toEqual([["Spotify", "Due Nov 30", "$11"], ["Netflix", "Due Dec 2", "$10"]]);
    expect(view.headline).toEqual({ label: "Next 30 days", value: "$21" });
  });
  it("Upcoming Events lists events from the calendar timeline, soonest first, and nothing that is a bill or a task", () => {
    const view = buildWidgetView(w({ source: "events", limit: 4 }), { events: [
      { id: "b", type: "event", title: "Mom's Birthday", date: "2026-11-26", allDay: true },
      { id: "d", type: "event", title: "Dentist", date: "2026-11-23", time: "15:00", location: "Main St" },
      { id: "o", type: "obligation", title: "Netflix", date: "2026-11-24" },
      { id: "p", type: "event", title: "Last week", date: "2026-11-15" },
    ] }, TODAY);
    expect(view.rows.map((r) => [r.title, r.sub])).toEqual([["Dentist", "Nov 23 · 15:00 · Main St"], ["Mom's Birthday", "Nov 26"]]);
  });
});
