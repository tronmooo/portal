// The Wellness tab's layouts (shared/wellness-dashboards): built-in cards, the
// cards the user built, several dashboards and the display options — one
// preference row.
import { describe, it, expect } from "vitest";
import {
  DEFAULT_WELLNESS_OPTIONS, MAX_DASHBOARDS, WELLNESS_CARD_IDS, WELLNESS_DEFAULT_HIDDEN, WELLNESS_PREFS_KEY, WELLNESS_TEMPLATES,
  activeWellnessBoard, addWellnessDashboard, addWellnessWidget, defaultWellnessBoards, duplicateWellnessWidget, hiddenWellnessCards,
  isWellnessCardVisible, moveWellnessCard, parseWellnessBoards, placeWellnessCard, removeWellnessBoard, removeWellnessWidget,
  renameWellnessBoard, resetWellnessLayout, serializeWellnessBoards, setActiveWellnessBoard, setWellnessCardSize, setWellnessCardVisible,
  setWellnessOptions, updateWellnessWidget, visibleWellnessCards, wellnessCardHint, wellnessCardSize, wellnessCardTitle,
  type WellnessBoards,
} from "../shared/wellness-dashboards";
import { WELLNESS_WIDGET_IDEAS } from "../shared/wellness-widgets";

const idea = (key: string) => WELLNESS_WIDGET_IDEAS.find((i) => i.key === key)!.widget;
const withWidget = (b: WellnessBoards, key = "consistency") => {
  const r = addWellnessWidget(b, idea(key));
  if (!r.widget) throw new Error("the widget was not added");
  return r;
};

describe("the default", () => {
  const b = defaultWellnessBoards();
  it("is one dashboard, Overview, showing the ten standard sections on a 30-day range", () => {
    expect(b.dashboards.map((d) => d.name)).toEqual(["Overview"]);
    expect(visibleWellnessCards(b)).toEqual(["overview", "trends", "activity", "sleep", "nutrition", "body", "labs", "medications", "sources", "insights"]);
    expect(hiddenWellnessCards(b)).toEqual([...WELLNESS_DEFAULT_HIDDEN]);
    expect(b.options).toEqual(DEFAULT_WELLNESS_OPTIONS);
    expect(b.options.range).toBe("30d");
  });
  it("every built-in card has a name and a hint", () => {
    for (const id of WELLNESS_CARD_IDS) {
      expect(wellnessCardTitle(b, id).length).toBeGreaterThan(2);
      expect(wellnessCardHint(b, id).length).toBeGreaterThan(8);
    }
  });
  it("is stored under its own preference key, apart from the Executive tab's", () => {
    expect(WELLNESS_PREFS_KEY).toBe("wellness_card_prefs");
  });
});

describe("the stored row", () => {
  it("survives a round trip", () => {
    let b = withWidget(defaultWellnessBoards()).boards;
    b = addWellnessDashboard(b, "Fitness", "fitness");
    b = setWellnessOptions(b, { range: "90d", trends: false });
    expect(parseWellnessBoards(serializeWellnessBoards(b))).toEqual(b);
  });
  it("anything unreadable is the default, never a crash", () => {
    for (const raw of [null, "", "nope", "[]", "42", "{\"dashboards\":7}"]) expect(parseWellnessBoards(raw as any)).toEqual(defaultWellnessBoards());
  });
  it("drops what it does not recognise and keeps the rest", () => {
    const b = parseWellnessBoards(JSON.stringify({
      active: "ghost",
      dashboards: [{ id: "fit!!", name: "  Fit  ", hidden: ["labs", "nope", "w:gone"], order: ["sleep", "bogus"], sizes: { sleep: "medium", labs: "giant" } }, { id: "", name: "x" }],
      widgets: [{ id: "ok", title: "Sleep avg", kind: "metric", source: { kind: "metric", key: "sleep_hours" } }, { id: "bad", title: "Bad", kind: "metric", source: { kind: "sql" } }],
      options: { range: "forever", density: "comfortable", trends: "yes" },
    }));
    expect(b.dashboards).toEqual([{ id: "fit", name: "Fit", hidden: ["labs"], order: ["sleep"], sizes: { sleep: "medium" } }]);
    expect(b.active).toBe("fit");
    expect(b.widgets.map((w) => w.id)).toEqual(["ok"]);
    expect(b.options).toEqual({ ...DEFAULT_WELLNESS_OPTIONS, density: "comfortable" });
  });
});

describe("show, hide, order, size", () => {
  const b = defaultWellnessBoards();
  it("a section switched off is hidden, not gone, and comes back", () => {
    const off = setWellnessCardVisible(b, "labs", false);
    expect(isWellnessCardVisible(off, "labs")).toBe(false);
    expect(hiddenWellnessCards(off)).toContain("labs");
    expect(visibleWellnessCards(setWellnessCardVisible(off, "labs", true))).toContain("labs");
    expect(visibleWellnessCards(setWellnessCardVisible(b, "mood", true))).toContain("mood");
  });
  it("reorders by drop position and by one step", () => {
    expect(visibleWellnessCards(placeWellnessCard(b, "insights", 0))[0]).toBe("insights");
    expect(visibleWellnessCards(moveWellnessCard(b, "overview", 1)).slice(0, 2)).toEqual(["trends", "overview"]);
    expect(moveWellnessCard(b, "overview", -1)).toBe(b);
  });
  it("a card is full width until the user makes it half", () => {
    expect(wellnessCardSize(b, "sleep")).toBe("large");
    expect(wellnessCardSize(setWellnessCardSize(b, "sleep", "medium"), "sleep")).toBe("medium");
  });
  it("options are validated on the way in", () => {
    expect(setWellnessOptions(b, { range: "1y", comparison: false }).options).toMatchObject({ range: "1y", comparison: false, trends: true });
    expect(setWellnessOptions(b, { range: "nope" as any }).options.range).toBe("30d");
  });
});

describe("cards the user built", () => {
  it("a new card shows on the dashboard it was built on and starts hidden on the others", () => {
    let b = addWellnessDashboard(defaultWellnessBoards(), "Medical", "medical");
    b = setActiveWellnessBoard(b, "overview");
    const { boards, widget } = withWidget(b);
    expect(isWellnessCardVisible(boards, `w:${widget!.id}`)).toBe(true);
    expect(isWellnessCardVisible(setActiveWellnessBoard(boards, "medical"), `w:${widget!.id}`)).toBe(false);
    expect(wellnessCardTitle(boards, `w:${widget!.id}`)).toBe("Exercise Consistency");
    expect(wellnessCardHint(boards, `w:${widget!.id}`)).toBe("Workouts · Count entries · Bar chart");
  });
  it("removing it removes it from every dashboard", () => {
    let { boards, widget } = withWidget(addWellnessDashboard(defaultWellnessBoards(), "Medical", "medical"));
    boards = setWellnessCardSize(boards, `w:${widget!.id}`, "medium");
    const gone = removeWellnessWidget(boards, widget!.id);
    expect(gone.widgets).toEqual([]);
    expect(JSON.stringify(gone)).not.toContain(`w:${widget!.id}`);
  });
  it("duplicating makes an independent copy", () => {
    const { boards, widget } = withWidget(defaultWellnessBoards());
    const copy = duplicateWellnessWidget(boards, widget!.id);
    expect(copy.widget).toMatchObject({ title: "Exercise Consistency copy", kind: "metric", calc: "count" });
    expect(copy.widget!.id).not.toBe(widget!.id);
    expect(copy.boards.widgets).toHaveLength(2);
  });
  it("an edit that is not a valid widget changes nothing", () => {
    const { boards, widget } = withWidget(defaultWellnessBoards());
    expect(updateWellnessWidget(boards, { ...widget!, title: "x" })).toBe(boards);
    expect(updateWellnessWidget(boards, { ...widget!, calc: "total", range: "90d" }).widgets[0]).toMatchObject({ calc: "total", range: "90d" });
    expect(updateWellnessWidget(boards, { ...widget!, id: "someone-else" })).toBe(boards);
  });
  it("reset puts the layout and options back and keeps the cards (a reset is not a delete)", () => {
    let { boards } = withWidget(defaultWellnessBoards());
    boards = setWellnessOptions(setWellnessCardVisible(placeWellnessCard(boards, "labs", 0), "sleep", false), { range: "7d" });
    const reset = resetWellnessLayout(boards);
    expect(reset.widgets).toHaveLength(1);
    expect(visibleWellnessCards(reset).slice(0, 10)).toEqual(visibleWellnessCards(defaultWellnessBoards()));
    expect(reset.options).toEqual(DEFAULT_WELLNESS_OPTIONS);
  });
});

describe("several dashboards", () => {
  it("a template shows its sections, in its order, and brings its widget ideas", () => {
    const b = addWellnessDashboard(defaultWellnessBoards(), "", "fitness");
    expect(activeWellnessBoard(b).name).toBe("Fitness");
    const ids = b.widgets.map((w) => `w:${w.id}`);
    expect(b.widgets.map((w) => w.title)).toEqual(["Exercise Consistency", "Sleep vs. Exercise"]);
    expect(visibleWellnessCards(b)).toEqual(["activity", "sleep", "trends", "goals", ...ids]);
    // The dashboard that already existed did not gain them.
    const overview = setActiveWellnessBoard(b, "overview");
    expect(visibleWellnessCards(overview)).toEqual(visibleWellnessCards(defaultWellnessBoards()));
  });
  it("a widget idea the user already has is reused, not made twice", () => {
    let b = addWellnessDashboard(defaultWellnessBoards(), "Fitness", "fitness");
    b = addWellnessDashboard(b, "Gym", "fitness");
    expect(b.widgets).toHaveLength(2);
    expect(activeWellnessBoard(b).id).toBe("gym");
  });
  it("blank starts with everything off — and says what is off", () => {
    const b = addWellnessDashboard(defaultWellnessBoards(), "Mine", "blank");
    expect(visibleWellnessCards(b)).toEqual([]);
    expect(hiddenWellnessCards(b)).toHaveLength(WELLNESS_CARD_IDS.length);
  });
  it("renames, deletes, never deletes the last, and stops at the limit", () => {
    let b = addWellnessDashboard(defaultWellnessBoards(), "Fitness", "fitness");
    b = renameWellnessBoard(b, "fitness", "Training");
    expect(activeWellnessBoard(b).name).toBe("Training");
    b = removeWellnessBoard(b, "fitness");
    expect(b.dashboards.map((d) => d.id)).toEqual(["overview"]);
    expect(b.widgets).toHaveLength(2); // the cards are kept
    expect(removeWellnessBoard(b, "overview")).toBe(b);
    let many = defaultWellnessBoards();
    for (let i = 0; i < 12; i++) many = addWellnessDashboard(many, `D${i}`, "blank");
    expect(many.dashboards).toHaveLength(MAX_DASHBOARDS);
  });
  it("every template names cards that exist", () => {
    for (const t of WELLNESS_TEMPLATES) {
      for (const c of t.cards) expect(WELLNESS_CARD_IDS).toContain(c);
      for (const k of t.ideas) expect(WELLNESS_WIDGET_IDEAS.some((i) => i.key === k), `${t.key}: ${k}`).toBe(true);
    }
  });
});
