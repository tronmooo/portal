// The chat suggestion engine.
//
// The point of this file is not that suggestions render — it's that they are
// EARNED. Every rule here corresponds to an observation about a real record,
// and the tests assert the observation, not just the string.
//
// The bar the old hardcoded list failed: a suggestion must be different for a
// different user, and must stop appearing when the thing that justified it
// stops being true.

import { describe, it, expect } from "vitest";
import {
  buildChatSuggestions, buildFollowUps, medianCadenceDays, partOfDay,
  type SuggestionInput,
} from "../shared/chat-suggestions";

// A fixed clock so "today" never drifts under the test.
const NOW = new Date("2026-07-31T19:30:00");   // Friday evening, local
const ago = (days: number) => new Date(NOW.getTime() - days * 86400000).toISOString();
const inDays = (days: number) => {
  const d = new Date(NOW.getTime() + days * 86400000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const base = (over: Partial<SuggestionInput> = {}): SuggestionInput => ({ now: NOW, ...over });
const ids = (s: { id: string }[]) => s.map(x => x.id);
const texts = (s: { text: string }[]) => s.map(x => x.text);

describe("what gets suggested is what's actually true", () => {
  it("surfaces a habit that is scheduled today and not yet done", () => {
    const out = buildChatSuggestions(base({
      habits: [{ id: "h1", name: "morning walk", frequency: "daily", checkins: [] }],
    }));
    expect(texts(out)).toContain("Mark morning walk done");
    expect(out[0].reason).toBe("still due today");
  });

  it("drops that habit the moment it's checked in", () => {
    // The failure mode this guards: a suggestion that keeps nagging about
    // something you already did is worse than no suggestion.
    const out = buildChatSuggestions(base({
      habits: [{ id: "h1", name: "morning walk", frequency: "daily",
        checkins: [{ date: "2026-07-31" }] }],
    }));
    expect(texts(out)).not.toContain("Mark morning walk done");
  });

  it("names the bill and its amount, and says when it's due", () => {
    const out = buildChatSuggestions(base({
      obligations: [{ id: "o1", name: "Progressive Auto", amount: 155, nextDueDate: inDays(2) }],
    }));
    const bill = out.find(s => s.id === "bill:o1")!;
    expect(bill.text).toBe("Pay Progressive Auto $155");
    expect(bill.reason).toBe("in 2d");
  });

  it("ranks an overdue bill above an outstanding habit", () => {
    const out = buildChatSuggestions(base({
      habits: [{ id: "h1", name: "vitamins", frequency: "daily", checkins: [] }],
      obligations: [{ id: "o1", name: "Lubi", amount: 10, nextDueDate: inDays(-27) }],
    }));
    expect(out[0].id).toBe("bill:o1");
    expect(out[0].reason).toBe("27d overdue");
  });

  it("ignores a bill that isn't due for weeks", () => {
    const out = buildChatSuggestions(base({
      obligations: [{ id: "o1", name: "Spotify", amount: 12, nextDueDate: inDays(20) }],
    }));
    expect(ids(out)).not.toContain("bill:o1");
  });
});

describe("tracker gaps are measured against the tracker's own rhythm", () => {
  // This is the rule that makes the feature feel observant rather than nagging.
  const daily = (n: number) => Array.from({ length: n }, (_, i) => ({ timestamp: ago(i + 6) }));

  it("computes a median cadence, not a mean", () => {
    // One long holiday gap must not redefine a daily habit as fortnightly.
    const entries = [
      { timestamp: ago(40) }, { timestamp: ago(39) }, { timestamp: ago(38) },
      { timestamp: ago(3) },  { timestamp: ago(2) },  { timestamp: ago(1) },
    ];
    expect(medianCadenceDays(entries)).toBe(1);
  });

  it("says nothing until it has enough entries to know the rhythm", () => {
    expect(medianCadenceDays([{ timestamp: ago(1) }, { timestamp: ago(2) }])).toBeNull();
    const out = buildChatSuggestions(base({
      trackers: [{ id: "t1", name: "Weight", entries: [{ timestamp: ago(9) }, { timestamp: ago(10) }] }],
    }));
    expect(ids(out)).not.toContain("gap:t1");
  });

  it("flags a daily tracker gone quiet for 6 days", () => {
    const out = buildChatSuggestions(base({
      trackers: [{ id: "t1", name: "Weight", entries: daily(5) }],
    }));
    const gap = out.find(s => s.id === "gap:t1")!;
    expect(gap.text).toBe("Log weight");
    expect(gap.reason).toBe("last logged 6 days ago");
  });

  it("does NOT flag a weekly tracker at 6 days — that's on schedule", () => {
    // Same 6-day silence as above, opposite verdict, because the cadence
    // differs. A fixed "N days" threshold would get this wrong.
    const weekly = [
      { timestamp: ago(6) }, { timestamp: ago(13) },
      { timestamp: ago(20) }, { timestamp: ago(27) },
    ];
    const out = buildChatSuggestions(base({
      trackers: [{ id: "t1", name: "Weight", entries: weekly }],
    }));
    expect(ids(out)).not.toContain("gap:t1");
  });
});

describe("routines only fire for things the user actually tracks", () => {
  it("classifies the part of day", () => {
    expect(partOfDay(new Date("2026-07-31T08:00:00"))).toBe("morning");
    expect(partOfDay(new Date("2026-07-31T14:00:00"))).toBe("afternoon");
    expect(partOfDay(new Date("2026-07-31T21:00:00"))).toBe("evening");
  });

  it("suggests logging sleep in the morning when a sleep tracker exists", () => {
    const out = buildChatSuggestions({
      now: new Date("2026-07-31T08:00:00"),
      trackers: [{ id: "t1", name: "Sleep", entries: [] }],
    });
    expect(texts(out)).toContain("Log sleep: 7.5 hours");
  });

  it("never suggests logging sleep to someone with no sleep tracker", () => {
    // The generic-copy problem one level subtler: a plausible-sounding prompt
    // that has nothing behind it.
    const out = buildChatSuggestions({
      now: new Date("2026-07-31T08:00:00"),
      trackers: [{ id: "t1", name: "Guitar practice", entries: [] }],
    });
    expect(texts(out)).not.toContain("Log sleep: 7.5 hours");
  });
});

describe("the active chat scope shapes the suggestions", () => {
  it("suggests pet things when chatting as a pet", () => {
    const out = buildChatSuggestions(base({
      scopeProfiles: [{ id: "p1", name: "Luna", type: "pet" }],
    }));
    const s = out.find(x => x.id === "scope:p1")!;
    expect(s.text).toBe("Log a vet visit for Luna");
    expect(s.reason).toBe("you're chatting as Luna");
  });

  it("suggests vehicle things when chatting as a vehicle", () => {
    const out = buildChatSuggestions(base({
      scopeProfiles: [{ id: "p2", name: "Honda CR-V", type: "vehicle" }],
    }));
    expect(texts(out)).toContain("Log fuel for Honda CR-V");
  });
});

describe("spending suggestions come from categories actually used", () => {
  it("picks the most-used category of the last 30 days", () => {
    const out = buildChatSuggestions(base({
      expenses: [
        { category: "groceries", date: inDays(-3) },
        { category: "groceries", date: inDays(-10) },
        { category: "dining", date: inDays(-5) },
      ],
    }));
    const s = out.find(x => x.id === "spend:groceries")!;
    expect(s.text).toBe("Spent $40 on groceries");
    expect(s.reason).toBe("2 logged in the last 30 days");
  });

  it("ignores 'other'/'general' and anything older than 30 days", () => {
    const out = buildChatSuggestions(base({
      expenses: [
        { category: "other", date: inDays(-1) },
        { category: "general", date: inDays(-1) },
        { category: "dining", date: inDays(-90) },
      ],
    }));
    expect(ids(out).some(id => id.startsWith("spend:"))).toBe(false);
  });
});

describe("an empty account still gets something usable", () => {
  it("falls back to starters ONLY when there is no signal at all", () => {
    const out = buildChatSuggestions(base({}));
    expect(out.length).toBeGreaterThan(0);
    expect(out.every(s => s.kind === "explore")).toBe(true);
  });

  it("stops using starters as soon as one real record exists", () => {
    const out = buildChatSuggestions(base({
      habits: [{ id: "h1", name: "stretch", frequency: "daily", checkins: [] }],
    }));
    expect(out.some(s => s.id.startsWith("explore:"))).toBe(false);
  });
});

describe("output contract", () => {
  const rich = base({
    habits: [{ id: "h1", name: "walk", frequency: "daily", checkins: [] }],
    obligations: [{ id: "o1", name: "Rent", amount: 1800, nextDueDate: inDays(1) }],
    documents: [{ id: "d1", name: "Licence", type: "drivers_license", expiryDate: inDays(12) }],
    trackers: [{ id: "t1", name: "Weight", entries: [
      { timestamp: ago(7) }, { timestamp: ago(8) }, { timestamp: ago(9) }, { timestamp: ago(10) }] }],
    expenses: [{ category: "groceries", date: inDays(-2) }],
    scopeProfiles: [{ id: "p1", name: "Luna", type: "pet" }],
  });

  it("never emits an empty message — a chip must have something to send", () => {
    for (const s of buildChatSuggestions(rich, 20)) {
      expect(s.text.trim().length, s.id).toBeGreaterThan(0);
      expect(s.label.trim().length, s.id).toBeGreaterThan(0);
    }
  });

  it("respects the max and returns unique ids", () => {
    const out = buildChatSuggestions(rich, 3);
    expect(out).toHaveLength(3);
    expect(new Set(ids(out)).size).toBe(3);
  });

  it("is stable across calls, so a chip never moves out from under a thumb", () => {
    expect(ids(buildChatSuggestions(rich, 6))).toEqual(ids(buildChatSuggestions(rich, 6)));
  });

  it("orders deadlines above gaps above routines above explore", () => {
    const out = buildChatSuggestions(rich, 20);
    const rank = { due: 0, gap: 1, scope: 1, routine: 2, followup: 2, explore: 3 } as const;
    const seen = out.map(s => rank[s.kind]);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });
});

describe("follow-ups react to what just happened", () => {
  it("offers a trend after logging a tracker entry", () => {
    const out = buildFollowUps([{ type: "log_entry", data: { _trackerName: "Weight" } }]);
    expect(texts(out)).toContain("What's my weight trend?");
  });

  it("offers a reminder after creating a task", () => {
    expect(texts(buildFollowUps([{ type: "create_task", data: {} }])))
      .toContain("Remind me about that tomorrow");
  });

  it("asks about the due date after creating a bill", () => {
    expect(texts(buildFollowUps([{ type: "create_liability", data: {} }])))
      .toContain("When is it due?");
  });

  it("names the profile after creating one", () => {
    expect(texts(buildFollowUps([{ type: "create_profile", data: { name: "Luna" } }])))
      .toContain("Add details for Luna");
  });

  it("returns nothing when the reply did nothing", () => {
    expect(buildFollowUps([])).toEqual([]);
    expect(buildFollowUps(undefined)).toEqual([]);
  });

  it("de-duplicates when one reply logged several entries", () => {
    const out = buildFollowUps([
      { type: "create_task", data: {} },
      { type: "create_task", data: {} },
    ]);
    expect(out).toHaveLength(1);
  });
});
