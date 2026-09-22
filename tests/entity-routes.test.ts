// Rules 23/24 (2026-09-22): every entity type has ONE canonical destination.
//
// A specific loan receipt used to go to the generic /profiles; a task to
// `/tasks?focus=<id>` (nothing read `focus`); a tracker finding to
// `/trackers?open=<id>` (the page reads `?tracker=`); a document expiry to a
// bare `/documents` (no such route). This pins the route table.
import { describe, it, expect } from "vitest";
import {
  routeForEntity, listRouteForEntity, entityTypeFromSearchRow, routeForSearchRow,
  normalizeEntityType, ROUTABLE_ENTITY_TYPES, isRoutableEntityType,
} from "../shared/entity-routes";
import { parseHighlight } from "../shared/record-highlight";
import { sourceHref } from "../shared/calendar-occurrences";

const ID = "rec-1";

describe("routeForEntity — the route table", () => {
  const expected: Record<string, string> = {
    person: "/profiles/rec-1",
    profile: "/profiles/rec-1",
    asset: "/profiles/rec-1",
    liability: "/profiles/rec-1",
    account: "/profiles/rec-1",
    document: "/documents/rec-1",
    tracker: "/trackers?tracker=rec-1",
    artifact: "/editor/rec-1",
    note: "/editor/rec-1",
    expense: "/dashboard/finance?highlight=expense%3Arec-1",
    income: "/dashboard/finance?highlight=income%3Arec-1",
    paycheck: "/dashboard/finance?highlight=income%3Arec-1",
    budget: "/dashboard/finance?highlight=budget%3Arec-1",
    task: "/dashboard/tasks?highlight=task%3Arec-1",
    habit: "/dashboard/habits?highlight=habit%3Arec-1",
    obligation: "/dashboard/obligations?highlight=obligation%3Arec-1",
    goal: "/goals?highlight=goal%3Arec-1",
    journal: "/dashboard/journal?highlight=journal%3Arec-1",
    event: "/calendar?highlight=event%3Arec-1",
    trackerEntry: "/trackers?highlight=trackerEntry%3Arec-1",
    memory: "/chat",
  };

  it("covers every routable type", () => {
    expect(Object.keys(expected).sort()).toEqual([...ROUTABLE_ENTITY_TYPES].sort());
  });

  for (const [type, path] of Object.entries(expected)) {
    it(`${type} → ${path}`, () => {
      expect(routeForEntity(type as any, ID)).toBe(path);
    });
  }

  it("a tracker entry with its tracker opens that tracker and highlights the entry", () => {
    expect(routeForEntity("trackerEntry", ID, { parentId: "trk-9" })).toBe("/trackers?tracker=trk-9&highlight=trackerEntry%3Arec-1");
  });

  it("the highlight it emits round-trips through parseHighlight", () => {
    for (const type of ["expense", "income", "task", "habit", "obligation", "goal", "journal", "event"] as const) {
      const h = parseHighlight(`#${routeForEntity(type, "a:b c")}`);
      expect(h?.id, type).toBe("a:b c");
    }
    expect(parseHighlight(`#${routeForEntity("paycheck", ID)}`)?.type).toBe("income");
  });

  it("hash variant prefixes `#` exactly once", () => {
    expect(routeForEntity("task", ID, { hash: true })).toBe("#/dashboard/tasks?highlight=task%3Arec-1");
    expect(routeForEntity("document", ID, { hash: true })).toBe("#/documents/rec-1");
    expect(routeForEntity("person", ID, { hash: true })).toBe("#/profiles/rec-1");
    for (const t of ROUTABLE_ENTITY_TYPES) {
      const h = routeForEntity(t, ID, { hash: true });
      expect(h.startsWith("#/"), t).toBe(true);
      expect(h.slice(1), t).toBe(routeForEntity(t, ID));
    }
  });

  it("profile tab context lands on that tab", () => {
    expect(routeForEntity("liability", ID, { tab: "finance" })).toBe("/profiles/rec-1/finance");
  });

  it("accepts numeric ids and aliases", () => {
    expect(routeForEntity("task", 7)).toBe("/dashboard/tasks?highlight=task%3A7");
    expect(routeForEntity("bill", ID)).toBe(routeForEntity("obligation", ID));
    expect(routeForEntity("journal_entry", ID)).toBe(routeForEntity("journal", ID));
    expect(routeForEntity("vehicle", ID)).toBe("/profiles/rec-1");
    expect(routeForEntity("tracker_entry", ID, { parentId: "t1" })).toBe(routeForEntity("trackerEntry", ID, { parentId: "t1" }));
  });

  it("an unknown type never throws and never produces a dead link", () => {
    expect(routeForEntity("wormhole", ID)).toBe("/dashboard");
    expect(routeForEntity("", ID)).toBe("/dashboard");
    expect(routeForEntity("wormhole", ID, { profileId: "p1" })).toBe("/profiles/p1");
    expect(normalizeEntityType("wormhole")).toBeNull();
    expect(isRoutableEntityType("task")).toBe(true);
    expect(isRoutableEntityType("tasks")).toBe(false);
  });
});

describe("list fallbacks (no id)", () => {
  it("documents go to the hub tab, never a bare /documents", () => {
    expect(routeForEntity("document")).toBe("/linked?tab=documents");
    expect(listRouteForEntity("document")).toBe("/linked?tab=documents");
    expect(routeForEntity("document", "")).toBe("/linked?tab=documents");
    expect(routeForEntity("document", null)).toBe("/linked?tab=documents");
  });

  it("each type's list page is a real route", () => {
    const lists: Record<string, string> = {
      person: "/profiles", profile: "/profiles", asset: "/linked?tab=assets", liability: "/liabilities",
      account: "/dashboard/finance", expense: "/dashboard/finance", income: "/dashboard/finance",
      paycheck: "/dashboard/finance", budget: "/dashboard/finance", document: "/linked?tab=documents",
      tracker: "/trackers", trackerEntry: "/trackers", habit: "/dashboard/habits", task: "/dashboard/tasks",
      event: "/calendar", obligation: "/dashboard/obligations", goal: "/goals", journal: "/dashboard/journal",
      artifact: "/artifacts", note: "/artifacts", memory: "/chat",
    };
    for (const t of ROUTABLE_ENTITY_TYPES) {
      expect(listRouteForEntity(t), t).toBe(lists[t]);
      expect(routeForEntity(t), t).toBe(lists[t]);
    }
    expect(listRouteForEntity("nonsense")).toBe("/dashboard");
  });
});

describe("profile-anchored dates", () => {
  it("a date that lives on a profile opens the profile", () => {
    expect(routeForEntity("event", ID, { profileId: "joe" })).toBe("/profiles/joe");
    expect(routeForEntity("obligation", ID, { profileId: "loan-1" })).toBe("/profiles/loan-1");
    expect(routeForEntity("income", ID, { profileId: "joe" })).toBe("/profiles/joe");
  });
  it("a record that owns its own page ignores the profile", () => {
    expect(routeForEntity("document", ID, { profileId: "joe" })).toBe("/documents/rec-1");
    expect(routeForEntity("task", ID, { profileId: "joe" })).toBe("/dashboard/tasks?highlight=task%3Arec-1");
    expect(routeForEntity("tracker", ID, { profileId: "joe" })).toBe("/trackers?tracker=rec-1");
    expect(routeForEntity("expense", ID, { profileId: "joe" })).toBe("/dashboard/finance?highlight=expense%3Arec-1");
  });
  it("sourceHref is a thin wrapper over the resolver", () => {
    expect(sourceHref("task", ID)).toBe(routeForEntity("task", ID, { hash: true }));
    expect(sourceHref("event", ID, "joe")).toBe(routeForEntity("event", ID, { profileId: "joe", hash: true }));
    expect(sourceHref("document", "", "joe")).toBe("#/linked?tab=documents");
  });
});

describe("no output is ever a dead link", () => {
  const ctxs = [undefined, { hash: true }, { profileId: "p1" }, { tab: "finance" }, { parentId: "t1" }];
  const ids = [undefined, "", ID, 42];
  it("never `/documents`, `?open=`, `?focus=` or `?event=`", () => {
    for (const t of ROUTABLE_ENTITY_TYPES) for (const ctx of ctxs) for (const id of ids) {
      const out = routeForEntity(t, id as any, ctx as any);
      const label = `${t} ${JSON.stringify(id)} ${JSON.stringify(ctx)}`;
      expect(out, label).toBeTruthy();
      expect(out.replace(/^#/, ""), label).not.toBe("/documents");
      expect(out, label).not.toMatch(/[?&](open|focus|event)=/);
      expect(out, label).not.toMatch(/^#?\/profile\//);
      expect(out, label).not.toMatch(/undefined|null/);
    }
  });
});

describe("entityTypeFromSearchRow", () => {
  it("reads _type and the profile's own type", () => {
    expect(entityTypeFromSearchRow({ _type: "task", id: "t" })).toBe("task");
    expect(entityTypeFromSearchRow({ _type: "profile", type: "person" })).toBe("person");
    expect(entityTypeFromSearchRow({ _type: "profile", type: "self" })).toBe("person");
    expect(entityTypeFromSearchRow({ _type: "profile", type: "pet" })).toBe("person");
    expect(entityTypeFromSearchRow({ _type: "profile", type: "loan" })).toBe("liability");
    expect(entityTypeFromSearchRow({ _type: "profile", type: "liability" })).toBe("liability");
    expect(entityTypeFromSearchRow({ _type: "profile", type: "account" })).toBe("account");
    expect(entityTypeFromSearchRow({ _type: "profile", type: "vehicle" })).toBe("asset");
    expect(entityTypeFromSearchRow({ _type: "profile" })).toBe("profile");
    expect(entityTypeFromSearchRow({ _type: "income" })).toBe("income");
    expect(entityTypeFromSearchRow({ _type: "goal" })).toBe("goal");
    expect(entityTypeFromSearchRow({ _type: "memory" })).toBe("memory");
    expect(entityTypeFromSearchRow({ _type: "nope" })).toBeNull();
    expect(entityTypeFromSearchRow(null)).toBeNull();
  });
  it("a loan search row navigates to that loan, not the profiles list", () => {
    expect(routeForSearchRow({ _type: "profile", type: "loan", id: "loan-7" })).toBe("/profiles/loan-7");
    expect(routeForSearchRow({ _type: "task", id: "t-1" })).toBe("/dashboard/tasks?highlight=task%3At-1");
    expect(routeForSearchRow({ _type: "nope", id: "x" })).toBeNull();
  });
});
