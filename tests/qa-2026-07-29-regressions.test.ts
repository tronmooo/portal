// Regression tests for the QA report of 2026-07-29.
//
// One `describe` per finding, named with the report's own ID, so a failure
// points straight back at the observed behaviour rather than at an abstraction.
// Everything covered here is pure logic — the surfaces that ACTUALLY broke are
// composed of these decisions, and each one had a defensible-looking
// implementation that produced the wrong user-visible answer.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  MAX_TRANSACTION_AMOUNT,
  LARGE_TRANSACTION_AMOUNT,
  insertExpenseSchema,
  insertIncomeSchema,
  insertObligationSchema,
} from "../shared/schema";
import {
  validateTransactionAmount,
  parseAmount as parseAmountImported,
  buildExpensePayload,
  buildIncomePayload,
  buildBillPayload,
} from "../shared/quick-add";
import { resolveCreateOwnerIds, parseActiveProfileIds, ACTIVE_PROFILE_HEADER } from "../shared/active-scope";
import { parseUserDateTime, isZonelessDateTime, getZonedParts } from "../shared/timezone";
import { findReminderMirrors } from "../server/reminder-mirror";
import { formatStoredDate, farFutureWarning } from "../client/src/lib/dates";

// ─────────────────────────────────────────────────────────────────────────────
// EDGE-001 / EDGE-002 — a $10,000,000,000 expense was accepted
// ─────────────────────────────────────────────────────────────────────────────
describe("EDGE-001: transaction amounts have an upper bound", () => {
  const oneTrillion = 1e12;

  it("rejects the reported 1e10 amount", () => {
    expect(validateTransactionAmount(1e10)).toMatch(/less than/i);
    const built = buildExpensePayload({ description: "QA", amount: "1e10" });
    expect(built.ok).toBe(false);
  });

  it("still accepts ordinary amounts, including large-but-real ones", () => {
    expect(validateTransactionAmount(12.34)).toBeNull();
    expect(validateTransactionAmount(LARGE_TRANSACTION_AMOUNT)).toBeNull();
    expect(validateTransactionAmount(MAX_TRANSACTION_AMOUNT)).toBeNull();
  });

  it("rejects one cent over the ceiling", () => {
    expect(validateTransactionAmount(MAX_TRANSACTION_AMOUNT + 0.01)).not.toBeNull();
  });

  it("keeps rejecting zero, negatives and garbage (the previously-passing cases)", () => {
    expect(validateTransactionAmount(0)).not.toBeNull();
    expect(validateTransactionAmount(-5)).not.toBeNull();
    expect(validateTransactionAmount(NaN)).not.toBeNull();
    expect(validateTransactionAmount(Infinity)).not.toBeNull();
  });

  it("allows zero only where the entity does (obligations)", () => {
    expect(validateTransactionAmount(0, { allowZero: true })).toBeNull();
    expect(validateTransactionAmount(-1, { allowZero: true })).not.toBeNull();
  });

  it("applies the same ceiling in every quick-add builder", () => {
    expect(buildExpensePayload({ description: "x", amount: oneTrillion }).ok).toBe(false);
    expect(buildIncomePayload({ description: "x", amount: oneTrillion }).ok).toBe(false);
    expect(buildBillPayload({ name: "x", amount: oneTrillion }).ok).toBe(false);
  });

  it("applies the same ceiling in the API schemas, so a direct caller cannot bypass the UI", () => {
    expect(insertExpenseSchema.safeParse({ description: "x", amount: 1e10 }).success).toBe(false);
    expect(insertIncomeSchema.safeParse({ description: "x", amount: 1e10 }).success).toBe(false);
    expect(insertObligationSchema.safeParse({ name: "x", amount: 1e10, nextDueDate: "2026-08-01" }).success).toBe(false);
    // ...and the same shapes at a realistic amount still save.
    expect(insertExpenseSchema.safeParse({ description: "x", amount: 42.5 }).success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROP-005 — an expense created under `Mike` landed in the self profile
// ─────────────────────────────────────────────────────────────────────────────
describe("PROP-005: a create lands on the profile in scope", () => {
  it("uses the active profile when the request names no owner", () => {
    expect(resolveCreateOwnerIds([], ["mike"])).toEqual(["mike"]);
    expect(resolveCreateOwnerIds(undefined, ["mike"])).toEqual(["mike"]);
  });

  it("never overrides an explicitly chosen owner", () => {
    // "Add Jane's dentist bill" while looking at Mike's dashboard is a real
    // thing to do, and it must still file under Jane.
    expect(resolveCreateOwnerIds(["jane"], ["mike"])).toEqual(["jane"]);
    expect(resolveCreateOwnerIds(["jane", "mike"], ["mike"])).toEqual(["jane", "mike"]);
  });

  it("declines to guess when several profiles are in scope", () => {
    // Two people selected = no unambiguous owner. Guessing one would be a new
    // way to put a row in the wrong ledger, so the record stays unowned and
    // falls through to the primary user by the existing orphan rule.
    expect(resolveCreateOwnerIds([], ["mike", "jane"])).toEqual([]);
  });

  it("is a no-op with no active scope (Everyone)", () => {
    expect(resolveCreateOwnerIds([], [])).toEqual([]);
    expect(resolveCreateOwnerIds([], undefined)).toEqual([]);
  });

  it("parses the wire header the client sends", () => {
    expect(ACTIVE_PROFILE_HEADER).toBe("x-active-profile-ids");
    expect(parseActiveProfileIds("a,b")).toEqual(["a", "b"]);
    expect(parseActiveProfileIds(" a , b ,")).toEqual(["a", "b"]);
    expect(parseActiveProfileIds("")).toEqual([]);
    expect(parseActiveProfileIds(undefined)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CRUD-E1-001 / PROP-006 — the scope chip silently became "Everyone"
// ─────────────────────────────────────────────────────────────────────────────
describe("PROP-006: the profile scope never widens by itself", () => {
  let store: typeof import("../client/src/lib/profileFilter");

  beforeEach(async () => {
    vi.resetModules();
    const mem = new Map<string, string>();
    const fake = {
      getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
      setItem: (k: string, v: string) => { mem.set(k, v); },
      removeItem: (k: string) => { mem.delete(k); },
    };
    vi.stubGlobal("localStorage", fake);
    vi.stubGlobal("sessionStorage", fake);
    store = await import("../client/src/lib/profileFilter");
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("keeps the last profile selected instead of falling back to Everyone", () => {
    store.setFilterSelected(["mike"], ["Mike"]);
    store.toggleFilterProfile("mike", "Mike"); // deselect the only selection
    const after = store.getProfileFilter();
    expect(after.mode).toBe("selected");
    expect(after.selectedIds).toEqual(["mike"]);
  });

  it("still allows narrowing a multi-selection down to one", () => {
    store.setFilterSelected(["mike", "jane"], ["Mike", "Jane"]);
    store.toggleFilterProfile("jane", "Jane");
    expect(store.getProfileFilter().selectedIds).toEqual(["mike"]);
  });

  it("still allows adding a profile to the selection", () => {
    store.setFilterSelected(["mike"], ["Mike"]);
    store.toggleFilterProfile("jane", "Jane");
    expect(store.getProfileFilter().selectedIds).toEqual(["mike", "jane"]);
  });

  it("reaches Everyone only through the explicit action", () => {
    store.setFilterSelected(["mike"], ["Mike"]);
    store.setFilterEveryone();
    expect(store.getProfileFilter().mode).toBe("everyone");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CRUD-T2-001 — a chat reminder for 5:51 PM persisted as 10:51 AM
// ─────────────────────────────────────────────────────────────────────────────
describe("CRUD-T2-001: a zone-less time is the USER's wall clock", () => {
  const LA = "America/Los_Angeles";

  it("recognises which strings carry no zone", () => {
    expect(isZonelessDateTime("2026-07-29T17:51:00")).toBe(true);
    expect(isZonelessDateTime("2026-07-29T17:51")).toBe(true);
    expect(isZonelessDateTime("2026-07-29T17:51:00Z")).toBe(false);
    expect(isZonelessDateTime("2026-07-29T17:51:00-07:00")).toBe(false);
  });

  it("round-trips the exact reported case", () => {
    const d = parseUserDateTime("2026-07-29T17:51:00", LA);
    const parts = getZonedParts(d, LA);
    expect(parts.date).toBe("2026-07-29");
    expect(parts.hours).toBe(17);
    expect(parts.minutes).toBe(51);
    // The stored instant is UTC — 17:51 PDT is 00:51 UTC the NEXT day. Storing
    // 17:51Z (the old behaviour) is what displayed back as 10:51 AM.
    expect(d.toISOString()).toBe("2026-07-30T00:51:00.000Z");
  });

  it("handles the browser's zone-less datetime-local value", () => {
    const parts = getZonedParts(parseUserDateTime("2026-07-29T17:51", LA), LA);
    expect(parts.hours).toBe(17);
  });

  it("leaves a fully-qualified instant alone", () => {
    expect(parseUserDateTime("2026-07-29T17:51:00Z", LA).toISOString()).toBe("2026-07-29T17:51:00.000Z");
    expect(parseUserDateTime("2026-07-29T17:51:00+02:00", LA).toISOString()).toBe("2026-07-29T15:51:00.000Z");
  });

  it("keeps a date-only value on its own calendar day", () => {
    expect(getZonedParts(parseUserDateTime("2026-07-29", LA), LA).date).toBe("2026-07-29");
  });

  it("honours a different user zone", () => {
    const parts = getZonedParts(parseUserDateTime("2026-07-29T17:51:00", "Europe/Berlin"), "Europe/Berlin");
    expect(parts.hours).toBe(17);
  });

  it("returns an Invalid Date for junk rather than throwing", () => {
    expect(isNaN(parseUserDateTime("not a date", LA).getTime())).toBe(true);
    expect(isNaN(parseUserDateTime("", LA).getTime())).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CRUD-T2-002 — a deleted reminder came back from its calendar mirror
// ─────────────────────────────────────────────────────────────────────────────
describe("CRUD-T2-002: a deleted reminder's calendar mirror is found", () => {
  const LA = "America/Los_Angeles";
  const reminder = { title: "Call the plumber", fireAt: "2026-07-30T00:51:00.000Z" }; // 17:51 PDT on the 29th
  const mirror = { id: "ev1", title: "Call the plumber", date: "2026-07-29", tags: ["reminder"] };

  it("matches the mirror the chat tool created", () => {
    expect(findReminderMirrors([mirror], reminder, LA).map(e => e.id)).toEqual(["ev1"]);
  });

  it("matches case-insensitively, as the chat tool wrote it", () => {
    expect(findReminderMirrors([{ ...mirror, title: "call the PLUMBER" }], reminder, LA)).toHaveLength(1);
  });

  it("leaves a real calendar event with the same name alone", () => {
    // No "reminder" tag = the user's own event. Deleting a reminder must not
    // take an unrelated event with it.
    expect(findReminderMirrors([{ ...mirror, tags: [] }], reminder, LA)).toHaveLength(0);
  });

  it("leaves a mirror on a different day alone", () => {
    expect(findReminderMirrors([{ ...mirror, date: "2026-07-28" }], reminder, LA)).toHaveLength(0);
  });

  it("uses the USER's day, not UTC's", () => {
    // The instant above is July 30 in UTC and July 29 in Pacific. Matching on
    // the UTC day would miss the mirror and leave the orphan behind.
    expect(findReminderMirrors([mirror], reminder, LA)).toHaveLength(1);
    expect(findReminderMirrors([{ ...mirror, date: "2026-07-30" }], reminder, "UTC")).toHaveLength(1);
  });

  it("returns nothing for an unparseable fire time instead of matching everything", () => {
    expect(findReminderMirrors([mirror], { title: "Call the plumber", fireAt: "nonsense" }, LA)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CRUD-T1-001 / EDGE-004 — due dates rendered a day early, and hid the year
// ─────────────────────────────────────────────────────────────────────────────
describe("CRUD-T1-001: a stored date renders as the day it is", () => {
  it("never shifts the day, whatever the timestamp suffix", () => {
    const thisYear = new Date().getFullYear();
    expect(formatStoredDate(`${thisYear}-07-29`)).toBe("Jul 29");
    expect(formatStoredDate(`${thisYear}-07-29T00:00:00.000Z`)).toBe("Jul 29");
    expect(formatStoredDate(`${thisYear}-01-01T23:59:59.999Z`)).toBe("Jan 1");
    expect(formatStoredDate(`${thisYear}-12-31T00:00:00-08:00`)).toBe("Dec 31");
  });

  it("shows the year whenever it is not the current one (EDGE-004)", () => {
    expect(formatStoredDate("2126-12-31")).toBe("Dec 31, 2126");
    expect(formatStoredDate("2019-03-04")).toBe("Mar 4, 2019");
  });

  it("returns empty for junk rather than a misleading date", () => {
    expect(formatStoredDate("")).toBe("");
    expect(formatStoredDate(null)).toBe("");
    expect(formatStoredDate("not-a-date")).toBe("");
    expect(formatStoredDate("2026-13-45")).toBe("");
  });

  it("warns about an implausibly distant due date", () => {
    expect(farFutureWarning("2126-12-31")).toMatch(/check the year/i);
    expect(farFutureWarning(`${new Date().getFullYear() + 1}-01-01`)).toBe("");
    expect(farFutureWarning("")).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EDGE-001, second half — `1e10` must not become some OTHER number
// ─────────────────────────────────────────────────────────────────────────────
describe("EDGE-001: amount parsing does not invent a number", () => {
  const { parseAmount: pa } = { parseAmount: parseAmountImported };

  it("keeps exponent notation instead of silently rewriting it", () => {
    // The old strip regex dropped the `e`, turning "1e10" into "110" — the
    // dialog would have saved $110 for input the user reads as ten billion.
    expect(pa("1e10")).toBe(1e10);
    expect(pa("1.5e3")).toBe(1500);
  });

  it("still strips ordinary currency formatting", () => {
    expect(pa("$1,234.50")).toBe(1234.5);
    expect(pa("-42")).toBe(-42);
  });

  it("and the parsed exponent is then rejected by the ceiling", () => {
    expect(validateTransactionAmount(pa("1e10"))).not.toBeNull();
  });
});
