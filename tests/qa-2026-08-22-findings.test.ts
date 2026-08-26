// tests/qa-2026-08-22-findings.test.ts
//
// The QA sweep of 2026-08-22. Each block below is one reported finding,
// reproduced first and then pinned.
//
//   #2/#4/#11  pronouns lost between turns ("who is 'she'?" one message after
//              "Sarah earns $750 every Friday")
//   #3         recurring income impossible — the tool hardcoded frequency
//   #8         "September 1" saved as August 31
//   #9         a note routed through Create Artifact
import { describe, it, expect } from "vitest";
import { parseUserDateTime, parseNaturalCalendarDate, toLocalDateStr, getUserToday, DEFAULT_TIMEZONE } from "@shared/timezone";
import { checkContentRouting } from "@shared/content-routing";
import { resolveReferent, buildReferentDirective, type ReferentCandidate } from "@shared/referent-resolution";
import { insertIncomeSchema } from "@shared/schema";
import { MemStorage, requestStorageContext } from "../server/storage";
import { executeTool } from "../server/ai-engine";

const run = <T>(storage: MemStorage, fn: () => Promise<T>) => requestStorageContext.run(storage, fn);
const local = (d: Date) => toLocalDateStr(d, DEFAULT_TIMEZONE);

// ─────────────────────────────────────────────────────────────────────────────
// #8 — "September 1" must not be saved as August 31
// ─────────────────────────────────────────────────────────────────────────────

describe("natural-language dates land on the day the user said", () => {
  it("parses every spoken form of September 1 as September 1", () => {
    // The bug: these all fell through to `new Date(s)` = UTC midnight, which is
    // 5pm on Aug 31 in America/Los_Angeles. The ISO branch had been anchoring
    // at noon for exactly this reason; the spoken form never did.
    for (const raw of [
      "September 1, 2026", "Sept 1 2026", "Sep 1, 2026", "9/1/2026",
      "1 September 2026", "the 1st of September 2026", "by September 1, 2026",
    ]) {
      expect(local(parseUserDateTime(raw, DEFAULT_TIMEZONE)), raw).toBe("2026-09-01");
    }
  });

  it("a missing year means this year, not the year 2001", () => {
    // `new Date("September 1")` returns 2001-09-01 — a bare month/day is read
    // as a two-digit year. Every yearless date the user spoke was 25 years off.
    const thisYear = Number(getUserToday(DEFAULT_TIMEZONE).slice(0, 4));
    const parsed = parseNaturalCalendarDate("September 1", DEFAULT_TIMEZONE);
    expect(parsed).not.toBeNull();
    expect(Number(parsed!.date.slice(0, 4))).toBeGreaterThanOrEqual(thisYear);
  });

  it("rolls a long-past yearless date into next year, but keeps recent backdating", () => {
    // Asked on 2026-08-22: "January 3" means the January that is coming…
    const jan = parseNaturalCalendarDate("January 3", DEFAULT_TIMEZONE)!;
    const today = getUserToday(DEFAULT_TIMEZONE);
    expect(jan.date > today).toBe(true);
    // …while a date a few days back stays where it is, so "log it for <recent
    // day>" still backdates instead of jumping a year.
    const y = Number(today.slice(0, 4));
    const recent = new Date(Date.parse(`${today}T12:00:00Z`) - 5 * 86400000);
    const spoken = recent.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
    expect(parseNaturalCalendarDate(spoken, DEFAULT_TIMEZONE)!.date.slice(0, 4)).toBe(String(y));
  });

  it("keeps a stated time of day, still on the right date", () => {
    const d = parseUserDateTime("September 1, 2026 at 9:30 pm", DEFAULT_TIMEZONE);
    expect(local(d)).toBe("2026-09-01");
  });

  it("leaves relative words to the callers that understand them", () => {
    expect(parseNaturalCalendarDate("tomorrow", DEFAULT_TIMEZONE)).toBeNull();
    expect(parseNaturalCalendarDate("next Friday", DEFAULT_TIMEZONE)).toBeNull();
    expect(parseNaturalCalendarDate("February 30", DEFAULT_TIMEZONE)).toBeNull();
  });

  it("ISO dates are unchanged", () => {
    expect(local(parseUserDateTime("2026-09-01", DEFAULT_TIMEZONE))).toBe("2026-09-01");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #9 — a note is not an artifact
// ─────────────────────────────────────────────────────────────────────────────

describe("explicit content routing covers artifacts", () => {
  it("refuses create_artifact when the user asked for a note", () => {
    for (const msg of [
      "Add a note about TSA PreCheck",
      "Make a note that Sarah has TSA PreCheck",
      "note: TSA PreCheck expires in 2030",
    ]) {
      const v = checkContentRouting("create_artifact", msg);
      expect(v, msg).not.toBeNull();
      expect(v!.modelDirective).toContain("create_note");
    }
  });

  it("still allows a genuine artifact request", () => {
    for (const msg of ["Create a packing checklist for my trip", "Build me a budget spreadsheet"]) {
      expect(checkContentRouting("create_artifact", msg), msg).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #2 / #4 / #11 — pronouns resolve from the conversation
// ─────────────────────────────────────────────────────────────────────────────

describe("referent resolution — who is 'she', what is 'it'", () => {
  const candidates: ReferentCandidate[] = [
    { name: "Sarah Miller", kind: "person", aliases: ["Sarah", "Miller"] },
    { name: "Netflix", kind: "thing" },
  ];
  const turn = (role: string, content: string) => ({ role, content });

  it("resolves 'she' to the person named in the previous turn", () => {
    const r = resolveReferent(
      "This Friday she's only getting $500.",
      [turn("user", "Sarah earns $750 every Friday from freelance work."),
       turn("assistant", "Logged Sarah's $750 weekly freelance income.")],
      candidates,
    );
    expect(r?.name).toBe("Sarah Miller");
    expect(r?.kind).toBe("person");
    const directive = buildReferentDirective(r)!;
    expect(directive).toContain('forProfile:"Sarah Miller"');
    expect(directive).toContain("Do NOT ask");
  });

  it("resolves 'her' for a profile edit", () => {
    const r = resolveReferent(
      "Change her email to sarah@newmail.com",
      [turn("user", "Sarah Miller's phone is 555-0100")],
      candidates,
    );
    expect(r?.name).toBe("Sarah Miller");
  });

  it("resolves 'it' to the bill named earlier", () => {
    const r = resolveReferent(
      "It comes out on the 22nd.",
      [turn("user", "Add Netflix for $15 a month")],
      candidates,
    );
    expect(r?.name).toBe("Netflix");
    expect(r?.kind).toBe("thing");
  });

  it("does nothing when the message names the person itself", () => {
    expect(resolveReferent(
      "Sarah is only getting $500 this Friday",
      [turn("user", "Sarah earns $750 every Friday")],
      candidates,
    )).toBeNull();
  });

  it("declines when the recent turn names two people — asking is right there", () => {
    const two: ReferentCandidate[] = [
      { name: "Sarah Miller", kind: "person", aliases: ["Sarah"] },
      { name: "Jane Doe", kind: "person", aliases: ["Jane"] },
    ];
    expect(resolveReferent(
      "Change her email",
      [turn("user", "Sarah and Jane both moved house")],
      two,
    )).toBeNull();
  });

  it("declines when nothing was named at all", () => {
    expect(resolveReferent("Change her email", [], candidates)).toBeNull();
    expect(resolveReferent("Change her email", [turn("user", "what's on my calendar?")], candidates)).toBeNull();
  });

  it("ignores a pronoun inside quoted text", () => {
    expect(resolveReferent(
      'Add a note that says "tell her I called"',
      [turn("user", "Sarah earns $750 every Friday")],
      candidates,
    )).toBeNull();
  });

  it("never reads a name the ASSISTANT introduced on its own", () => {
    // Only the user's own words commit to a subject.
    expect(resolveReferent(
      "Change her email",
      [turn("assistant", "I think you mean Sarah Miller")],
      candidates,
    )).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3 — recurring income, and income that belongs to a person
// ─────────────────────────────────────────────────────────────────────────────

describe("recurring income is supported", () => {
  it("the income record accepts a weekly cadence", () => {
    const parsed = insertIncomeSchema.safeParse({
      description: "Freelance", amount: 750, category: "freelance", frequency: "weekly",
    });
    expect(parsed.success).toBe(true);
  });

  it("log_income stores the stated cadence instead of forcing 'once'", async () => {
    const storage = new MemStorage();
    const res: any = await run(storage, () => executeTool("log_income", {
      amount: 750, source: "Freelance work", category: "freelance", frequency: "weekly",
      __userMessage: "Sarah earns $750 every Friday from freelance work",
    }, "user-qa-income-1"));
    expect(res.error).toBeUndefined();
    expect(res.frequency).toBe("weekly");
    const incomes = await run(storage, () => storage.getIncomes());
    expect(incomes[0].frequency).toBe("weekly");
    // And the reply is told not to repeat the old falsehood.
    expect(String(res.message)).toContain("recurring every week");
  });

  it("files the income under the person who earns it", async () => {
    const storage = new MemStorage();
    const sarah = await run(storage, () => storage.createProfile({ type: "person", name: "Sarah Miller" } as any));
    const res: any = await run(storage, () => executeTool("log_income", {
      amount: 750, source: "Freelance work", frequency: "weekly", forProfile: "Sarah Miller",
      __userMessage: "Sarah earns $750 every Friday",
    }, "user-qa-income-2"));
    expect(res.error).toBeUndefined();
    const incomes = await run(storage, () => storage.getIncomes());
    expect(incomes[0].linkedProfiles).toContain(sarah.id);
  });

  it("a one-off payment is still recorded as one-off", async () => {
    const storage = new MemStorage();
    const res: any = await run(storage, () => executeTool("log_income", {
      amount: 200, source: "Refund", __userMessage: "got a $200 refund",
    }, "user-qa-income-3"));
    expect(res.frequency).toBe("once");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #5 / #6 — a document belongs to ONE person
// ─────────────────────────────────────────────────────────────────────────────

describe("document ownership is resolved before the document is created", () => {
  it("a document for a named person does not also land on the account owner", async () => {
    const storage = new MemStorage();
    const self = await run(storage, () => storage.createProfile({ type: "self", name: "Poop" } as any));
    const sarah = await run(storage, () => storage.createProfile({ type: "person", name: "Sarah Miller" } as any));

    // Production storage fills an EMPTY owner list with the self profile.
    // Mirroring that here is what makes this test reproduce the reported bug:
    // create-then-link produced Poop AND Sarah on Sarah's passport.
    const realCreate = storage.createDocument.bind(storage);
    (storage as any).createDocument = async (data: any) => realCreate({
      ...data,
      linkedProfiles: data.linkedProfiles?.length ? data.linkedProfiles : [self.id],
    });

    const doc: any = await run(storage, () => executeTool("create_document", {
      name: "Sarah Miller's Passport",
      content: "Passport number X1234567. Expires 2031-04-02.",
      forProfile: "Sarah Miller",
      __userMessage: "save Sarah Miller's passport",
    }, "user-qa-doc-1"));

    expect(doc.error).toBeUndefined();
    expect(doc.linkedProfiles).toEqual([sarah.id]);
    expect(doc.linkedProfiles).not.toContain(self.id);
  });

  it("an unowned document still falls back to the account owner", async () => {
    const storage = new MemStorage();
    const self = await run(storage, () => storage.createProfile({ type: "self", name: "Poop" } as any));
    const realCreate = storage.createDocument.bind(storage);
    (storage as any).createDocument = async (data: any) => realCreate({
      ...data,
      linkedProfiles: data.linkedProfiles?.length ? data.linkedProfiles : [self.id],
    });

    const doc: any = await run(storage, () => executeTool("create_document", {
      name: "Warranty", content: "Fridge warranty", __userMessage: "save this warranty",
    }, "user-qa-doc-2"));
    expect(doc.linkedProfiles).toEqual([self.id]);
  });
});
