// @vitest-environment jsdom
//
// User report 2026-11-11: the Recurring Dates card read
//     🎂 Jordan's birthday
//     Birthday · Bob Robertson
// Jordan had no profile of their own, so the event was stored under the
// account holder (every record defaults to self) and the card printed that
// owner beside the kind — which reads as "Bob Robertson's birthday".
//
// Two halves of the fix, each tested against the real code:
//   · display — a birthday/anniversary that names a person never shows a
//     different person's name (RecurringRuleCard, rendered for real);
//   · write — the chat tool never files "<Name>'s birthday" under the
//     account holder because the model passed forProfile "me" / the self
//     profile (executeTool against an in-memory storage).
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { RecurringRuleCard } from "../client/src/components/calendar/RecurringRuleCard";
import { seriesFromEvents } from "../shared/calendar-adapters";
import { generateSeriesOccurrences } from "../shared/calendar-occurrences";
import { ownerLabelForDatedItem, profileIsNamedBy } from "../shared/birthday-event";

const TODAY = "2026-11-11";

function cardMeta(title: string, ownerName: string): string {
  const [series] = seriesFromEvents([
    { id: "ev1", title, date: "2026-11-18", recurrence: "yearly",
      linkedProfiles: ["p-bob"], tags: ["rdate", "rd:kind:birthday"] },
  ]);
  const next = generateSeriesOccurrences(series, { todayISO: TODAY })[0] ?? null;
  render(
    <RecurringRuleCard series={series} next={next} upcomingCount={5} ownerName={ownerName}
      todayISO={TODAY} onOpen={() => {}} onAction={() => {}} />,
  );
  const card = screen.getByTestId(`rule-card-${series.id}`);
  return card.textContent || "";
}

afterEach(cleanup);

describe("a birthday card never names someone else as whose birthday it is", () => {
  it("'Jordan's birthday' owned by Bob Robertson does not show Bob Robertson", () => {
    const text = cardMeta("🎂 Jordan's birthday", "Bob Robertson");
    expect(text).toContain("Jordan's birthday");
    expect(text).toContain("Birthday");
    expect(text).not.toContain("Bob Robertson");
  });

  it("the owner's own birthday still shows the owner", () => {
    const text = cardMeta("Bob's Birthday", "Bob Robertson");
    expect(text).toContain("Bob Robertson");
  });

  it("the shared rule", () => {
    expect(ownerLabelForDatedItem("🎂 Jordan's birthday", "Bob Robertson")).toBeUndefined();
    expect(ownerLabelForDatedItem("Jordan's Anniversary", "Bob Robertson")).toBeUndefined();
    expect(ownerLabelForDatedItem("Jordan's birthday", "Jordan Lee")).toBe("Jordan Lee");
    expect(ownerLabelForDatedItem("Birthday", "Bob Robertson")).toBe("Bob Robertson");
    expect(ownerLabelForDatedItem("Calendar Review", "Bob Robertson")).toBe("Bob Robertson");
    expect(profileIsNamedBy("Jordan", "Jordan Lee")).toBe(true);
    expect(profileIsNamedBy("Jordan", "Jordana")).toBe(false);
  });
});

// ── Write path ───────────────────────────────────────────────────────────────

const SELF = { id: "p-bob", name: "Bob Robertson", type: "self", fields: {} };
const db: any = {};

vi.mock("../server/storage", () => {
  const impl: Record<string, any> = {
    _timezone: "America/Los_Angeles",
    getProfiles: async () => db.profiles,
    getProfile: async (id: string) => db.profiles.find((p: any) => p.id === id),
    getSelfProfile: async () => SELF,
    getEvents: async () => db.events,
    createEvent: async (data: any) => { const row = { id: `ev${db.events.length + 1}`, ...data }; db.events.push(row); return row; },
    linkProfileTo: async () => undefined,
    getMemories: async () => [],
    getPreference: async () => null,
    createAiActionLog: async (row: any) => ({ id: "log1", ...row }),
  };
  const storage = new Proxy(impl, { get(target, prop: string) { return prop in target ? target[prop] : async () => []; } });
  return { storage };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: async () => { throw new Error("model must not be called"); },
      stream: () => { throw new Error("model must not be called"); },
    };
  },
}));

let executeTool: (name: string, input: any, userId?: string) => Promise<any>;
beforeEach(async () => {
  db.profiles = [SELF];
  db.events = [];
  ({ executeTool } = await import("../server/ai-engine"));
});

describe("chat: '<Name>'s birthday' is never filed under the account holder by forProfile", () => {
  const msg = "add Jordan's birthday, november 18";

  for (const forProfile of ["me", "Bob Robertson"]) {
    it(`forProfile "${forProfile}" is ignored when the title names Jordan`, async () => {
      const res = await executeTool("create_event", { title: "🎂 Jordan's birthday", date: "2026-11-18", forProfile, __userMessage: msg }, "u1");
      expect(res.error).toBeUndefined();
      expect(db.events.length).toBe(1);
      expect(db.events[0].linkedProfiles).toEqual([]);
      expect(db.events[0].recurrence).toBe("yearly");
    });
  }

  it("a Jordan profile, when there is one, gets the birthday even if forProfile said 'me'", async () => {
    db.profiles = [SELF, { id: "p-jordan", name: "Jordan", type: "person", fields: {} }];
    const res = await executeTool("create_event", { title: "Jordan's birthday", date: "2026-11-18", forProfile: "me", __userMessage: msg }, "u1");
    expect(res.error).toBeUndefined();
    expect(db.events[0].linkedProfiles).toEqual(["p-jordan"]);
  });

  it("the account holder's own birthday still goes to them", async () => {
    const res = await executeTool("create_event", { title: "Bob's birthday", date: "2026-11-18", forProfile: "me", __userMessage: "my birthday is nov 18" }, "u1");
    expect(res.error).toBeUndefined();
    expect(db.events[0].linkedProfiles).toEqual(["p-bob"]);
  });
});
