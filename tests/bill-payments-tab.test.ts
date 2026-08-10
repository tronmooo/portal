// Three complaints from one pass over a phone screenshot of a $14.99 bill:
//
//   1. "Bill details should be able to be edited." The card listed amount,
//      frequency, due date, term, reminder and autopay, and offered no way to
//      change any of them — while a loan, one subtype over, had an Edit button
//      on the same card in the same tab.
//   2. The pay schedule ("Upcoming (12)", every future due date with Pay /
//      Skip / Reschedule on it) sat at the bottom of the OVERVIEW tab, while
//      the Payments tab showed "0 payments on record" and nothing else.
//   3. The chat answered "Spent $50 on groceries" with "Logged — note you
//      already have a similar $30 groceries entry from today." The entry was
//      from yesterday, and the note was not wanted in the first place.
//
// Source greps, in the style of detail-hero.test.ts: liability-detail.tsx is
// ~3.7k lines behind a lazy route with a dozen queries, and what's asserted
// here is which tab a section is mounted in and whether an editor exists —
// exactly what a grep can see.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const root = (p: string) => path.resolve(__dirname, "..", p);
const read = (p: string) => fs.readFileSync(root(p), "utf8");

/** Strip comment lines — the removed patterns are QUOTED in the notes saying
 *  why they went, and a guard that fires on its own documentation gets
 *  deleted. The optional `{` covers a JSX comment's `{/*`. */
const code = (p: string) =>
  read(p).split("\n").filter((l) => !/^\s*(\{?\/\*|\/\/|\*)/.test(l)).join("\n");

const LIABILITY = "client/src/pages/liability-detail.tsx";
const AI = "server/ai-engine.ts";

/** The body of one <TabsContent value="x"> … up to the next TabsContent. */
function tabBody(src: string, value: string): string {
  const start = src.indexOf(`<TabsContent value="${value}"`);
  expect(start, `no <TabsContent value="${value}">`).toBeGreaterThan(-1);
  const next = src.indexOf("<TabsContent value=", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe("the payment schedule lives in the Payments tab", () => {
  const src = code(LIABILITY);

  it("mounts the schedule under Payments", () => {
    expect(tabBody(src, "payments")).toMatch(/<BillScheduleSection/);
  });

  it("does not also leave it at the bottom of Overview", () => {
    // Two copies of a list with Pay buttons on it is worse than the wrong tab.
    expect(tabBody(src, "overview")).not.toMatch(/<BillScheduleSection/);
  });

  it("mounts it exactly once", () => {
    expect(src.match(/<BillScheduleSection/g)?.length ?? 0).toBe(1);
  });

  it("puts the plan above the record", () => {
    // "What do I still owe and when" is the question this tab is opened with;
    // the history is the answer to a different one.
    const payments = tabBody(src, "payments");
    expect(payments.indexOf("<BillScheduleSection"))
      .toBeLessThan(payments.indexOf("Payment History"));
  });
});

describe("bill details are editable", () => {
  const src = code(LIABILITY);

  it("the Bill details card carries an Edit affordance", () => {
    expect(src).toMatch(/data-testid="button-edit-bill"/);
    expect(src).toMatch(/data-testid="bill-details-edit-card"/);
    expect(src).toMatch(/data-testid="button-save-bill"/);
  });

  it("every fact the read-only card states can be changed", () => {
    // Amount, cadence, date, term, reminder, autopay — the rows the user was
    // looking at when they asked for this.
    for (const testid of [
      "input-bill-amount",
      "select-bill-frequency",
      "input-bill-due-date",
      "input-bill-count",
      "input-bill-end",
      "input-bill-reminder",
      "switch-bill-autopay",
    ]) {
      expect(src, `${testid} missing from the bill editor`).toContain(testid);
    }
  });

  it("writes the date to the key the series is actually generated from", () => {
    // shared/liability-schedule anchors on firstPaymentDate ?? dueDate ??
    // nextDueDate. Writing dueDate alone on a bill that carries a
    // firstPaymentDate moves nothing the user can see.
    const save = src.match(/const saveBillMutation[\s\S]{0,3000}?openBillEditor/)?.[0] ?? "";
    expect(save, "saveBillMutation not found").not.toBe("");
    for (const key of ["firstPaymentDate", "dueDate", "nextDueDate"]) {
      expect(save, `saveBillMutation does not set ${key}`).toContain(key);
    }
  });

  it("refetches the schedule by hand after saving", () => {
    // The domain bus predicate matches "/api/liabilities/" WITH the slash; the
    // schedule key is ["/api/liabilities", id, "schedule"], so it doesn't
    // match and the card would keep rendering the pre-edit series.
    const save = src.match(/const saveBillMutation[\s\S]{0,3000}?openBillEditor/)?.[0] ?? "";
    expect(save).toMatch(/queryKey: \["\/api\/liabilities", profile\.id, "schedule"\]/);
  });

  it("offers only cadences the recurrence engine understands", () => {
    // freqToUnit() returns unit:"" for anything it doesn't know, and an
    // unrecognized token collapses the whole series to one occurrence.
    expect(src).toMatch(/const BILL_FREQUENCIES = \[[^\]]*\]/);
    expect(src).not.toMatch(/const BILL_FREQUENCIES = \[[^\]]*quarterly/);
  });
});

describe("the chat does not narrate duplicates", () => {
  const src = read(AI);

  it("never asks the model to mention a similar entry", () => {
    expect(src).not.toContain("mention it once");
    expect(src).not.toContain("EXCEPTION — duplicate note");
    expect(src).not.toMatch(/add ONE short sentence like "Saved/);
  });

  it("says plainly that duplicate_count is diagnostic only", () => {
    expect(src).toMatch(/duplicate_count is DIAGNOSTIC ONLY — never mention it/);
  });

  it("forbids attaching a date to it", () => {
    // The screenshot's note said "from today" about an entry made yesterday.
    // duplicate_count is a count; it carries no dates to read one off.
    expect(src).toMatch(/NEVER describe when an earlier entry was made/);
  });
});
