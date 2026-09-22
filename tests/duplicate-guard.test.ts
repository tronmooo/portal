/**
 * Rule 35 — the universal duplicate guard (shared/duplicate-guard.ts).
 */
import { describe, it, expect } from "vitest";
import { findPossibleDuplicates, takeDuplicateControls, duplicateQuestion, normalizeDuplicateName } from "../shared/duplicate-guard";

const NOW = new Date("2026-09-22T12:00:00Z");
const A = "avery";
const M = "morgan";

const row = (over: Record<string, any>) => ({
  id: "x", amount: 12, description: "Lunch", date: "2026-09-22", linkedProfiles: [A],
  createdAt: "2026-09-22T11:59:30Z", ...over,
});

describe("findPossibleDuplicates — tiers", () => {
  it("same request/operation stamp → high (1.0) regardless of anything else", () => {
    const v = findPossibleDuplicates(
      { entityType: "expense", requestId: "req-1", amount: 999, ownerIds: [M] },
      [row({ id: "r", request_id: "req-1" })], { now: NOW },
    );
    expect(v.tier).toBe("high");
    expect(v.matches[0]).toMatchObject({ id: "r", score: 1, reasons: ["same_request"] });
  });

  it("same owner + date + amount + normalized description → high", () => {
    const v = findPossibleDuplicates(
      { entityType: "expense", ownerIds: [A], date: "2026-09-22", amount: 12.004, description: "my lunch!" },
      [row({ createdAt: "2026-09-20T00:00:00Z" })], { now: NOW },
    );
    expect(v.tier).toBe("high");
    expect(v.matches[0].reasons).toEqual(expect.arrayContaining(["same_owner", "same_date", "same_amount", "same_name"]));
  });

  it("same owner + amount + date but a different description → medium", () => {
    const v = findPossibleDuplicates(
      { entityType: "expense", ownerIds: [A], date: "2026-09-22", amount: 12, description: "Parking" },
      [row({})], { now: NOW },
    );
    expect(v.tier).toBe("medium");
  });

  it("same name + owner moments ago with no day to compare → medium; outside the window → low", () => {
    // An undated income against a dated one: the day cannot disagree.
    const cand = { entityType: "income", ownerIds: [A], date: null, amount: 12, description: "Lunch" };
    expect(findPossibleDuplicates(cand, [row({ createdAt: "2026-09-22T11:59:00Z" })], { now: NOW }).tier).toBe("medium");
    expect(findPossibleDuplicates(cand, [row({ createdAt: "2026-09-22T11:00:00Z" })], { now: NOW }).tier).toBe("low");
  });

  it("two explicitly different days are two records, however recent (D63: yesterday's lunch vs today's)", () => {
    const cand = { entityType: "expense", ownerIds: [A], date: "2026-09-21", amount: 12, description: "Lunch" };
    expect(findPossibleDuplicates(cand, [row({ createdAt: "2026-09-22T11:59:00Z" })], { now: NOW }).tier).toBe("low");
    const evt = { entityType: "event", ownerIds: [A], date: "2026-09-24", name: "Dentist" };
    expect(findPossibleDuplicates(evt, [{ id: "e", title: "Dentist", date: "2026-09-22", linkedProfiles: [A], createdAt: "2026-09-22T11:59:00Z" }], { now: NOW }).tier).toBe("low");
  });

  it("a different owner's identical lunch is never a duplicate", () => {
    const v = findPossibleDuplicates(
      { entityType: "expense", ownerIds: [M], date: "2026-09-22", amount: 12, description: "Lunch" },
      [row({})], { now: NOW },
    );
    expect(v.tier).toBe("low");
    expect(v.matches).toEqual([]);
  });

  it("an amount off by more than half a cent is not the same amount", () => {
    const v = findPossibleDuplicates(
      { entityType: "expense", ownerIds: [A], date: "2026-09-22", amount: 12.01, description: "Lunch" },
      [row({ createdAt: "2026-09-20T00:00:00Z" })], { now: NOW },
    );
    expect(v.tier).toBe("low");
  });

  it("reads snake_case rows (linked_profiles / created_at) the way it reads camelCase ones", () => {
    const v = findPossibleDuplicates(
      { entityType: "income", ownerIds: [A], date: "2026-09-22", amount: 1000, description: "Paycheck" },
      [{ id: "i", amount: 1000, description: "paycheck", date: "2026-09-22", linked_profiles: [A], created_at: "2026-09-01T00:00:00Z" }], { now: NOW },
    );
    expect(v.tier).toBe("high");
  });

  it("events: same title, same day, same owner → high; a different clock time → medium", () => {
    const evt = { id: "e", title: "Meeting", date: "2026-09-22", time: "09:00", linkedProfiles: [A], createdAt: "2026-09-01T00:00:00Z" };
    expect(findPossibleDuplicates({ entityType: "event", ownerIds: [A], date: "2026-09-22", name: "Meeting", time: "09:00" }, [evt], { now: NOW }).tier).toBe("high");
    expect(findPossibleDuplicates({ entityType: "event", ownerIds: [A], date: "2026-09-22", name: "Meeting", time: "15:00" }, [evt], { now: NOW }).tier).toBe("medium");
  });

  it("undated tasks: the same title for the same owner moments ago → medium, an hour ago → low", () => {
    const cand = { entityType: "task", ownerIds: [A], name: "Buy milk" };
    expect(findPossibleDuplicates(cand, [{ id: "t", title: "buy milk", linkedProfiles: [A], createdAt: "2026-09-22T11:59:00Z" }], { now: NOW }).tier).toBe("medium");
    expect(findPossibleDuplicates(cand, [{ id: "t", title: "buy milk", linkedProfiles: [A], createdAt: "2026-09-22T10:59:00Z" }], { now: NOW }).tier).toBe("low");
  });

  it("soft-deleted rows never match; matches are sorted best first", () => {
    const v = findPossibleDuplicates(
      { entityType: "expense", ownerIds: [A], date: "2026-09-22", amount: 12, description: "Lunch" },
      [row({ id: "gone", deletedAt: "2026-09-22T00:00:00Z" }), row({ id: "diff", description: "Other" }), row({ id: "exact" })], { now: NOW },
    );
    expect(v.matches.map(m => m.id)).toEqual(["exact", "diff"]);
  });
});

describe("helpers", () => {
  it("normalizes names like createNameKey", () => {
    expect(normalizeDuplicateName("My Rent!")).toBe("rent");
    expect(normalizeDuplicateName(null)).toBe("");
  });
  it("takeDuplicateControls strips the control keys and reads them", () => {
    const out = takeDuplicateControls({ amount: 1, __allowDuplicate: true, __requestId: "r", __operationId: "" } as any);
    expect(out.data).toEqual({ amount: 1 });
    expect(out.allowDuplicate).toBe(true);
    expect(out.requestId).toBe("r");
    expect(out.operationId).toBeNull();
  });
  it("duplicateQuestion names the record and its day", () => {
    expect(duplicateQuestion({ description: "Lunch", date: "2026-09-22" })).toBe("This looks like Lunch from 2026-09-22 — log it again?");
  });
});

describe("selfProfileId — unowned rows are the primary user's", () => {
  const unowned = { id: "u", amount: 20, description: "lunch", date: "2026-09-02", linkedProfiles: [], createdAt: "2026-09-02T00:00:00Z" };
  it("an unowned candidate matches an unowned row as self's when selfProfileId is given", () => {
    const cand = { entityType: "expense", ownerIds: [], date: "2026-09-02", amount: 20, description: "lunch", selfProfileId: "self-1" };
    expect(findPossibleDuplicates(cand, [unowned], { now: NOW }).tier).toBe("high");
    expect(findPossibleDuplicates({ ...cand, ownerIds: ["self-1"] }, [unowned], { now: NOW }).tier).toBe("high");
  });
  it("Avery's identical lunch does not match an unowned (self) row", () => {
    const cand = { entityType: "expense", ownerIds: [A], date: "2026-09-02", amount: 20, description: "lunch", selfProfileId: "self-1" };
    expect(findPossibleDuplicates(cand, [unowned], { now: NOW }).tier).toBe("low");
  });
  it("without selfProfileId an unowned row only matches an unowned candidate (storage retry semantics)", () => {
    expect(findPossibleDuplicates({ entityType: "expense", ownerIds: ["self-1"], date: "2026-09-02", amount: 20, description: "lunch" }, [unowned], { now: NOW }).tier).toBe("low");
    expect(findPossibleDuplicates({ entityType: "expense", ownerIds: [], date: "2026-09-02", amount: 20, description: "lunch" }, [unowned], { now: NOW }).tier).toBe("high");
  });
});
