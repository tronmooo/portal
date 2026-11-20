// Guards for the "Liability rules" section of CLAUDE.md.
//
// Every assertion here is one of the Liabilities tutorial findings of
// 2026-11-18. Each was fixed once; these keep it fixed. A rule whose behaviour
// has its own suite is pinned there (named beside the rule in CLAUDE.md) —
// this file covers the page-level rules that had no guard at all: undo any of
// them and a test below fails, naming the bug that comes back.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
const page = src("client/src/pages/liability-detail.tsx");
const list = src("client/src/pages/trackers.tsx");
const engine = src("server/ai-engine.ts");

describe("L1 — one debt is one record", () => {
  it("create_liability does not also create a '<name> payment' bill", () => {
    const at = engine.indexOf('case "create_liability": {');
    const end = engine.indexOf('case "update_liability": {');
    expect(at).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(at);
    const body = engine.slice(at, end);
    // The redirect of a bill MISNAMED as a liability goes through executeTool;
    // what must never return is a second record written beside the debt.
    expect(body).not.toMatch(/storage\.createObligation\(/);
    expect(body).not.toMatch(/`\$\{input\.name\} payment`/);
  });
});

describe("L3 — a rate is a percent, typed and stored", () => {
  it("the terms form stores what was typed under `interestRate`, with no unit guess", () => {
    expect(page).toContain("Object.assign(fields, storedRateFields(v.rate));");
    expect(page).not.toMatch(/r > 1 \? r \/ 100 : r/);
    // …and opens from the percent reader, not the decimal `terms.annualRate`.
    expect(page).not.toMatch(/setTRate\(terms\.annualRate/);
  });
});

describe("L4 — the list and the page describe a debt the same way", () => {
  it("the list reads the subtype from the type_key column", () => {
    const at = list.indexOf("const liabilitySubcategoryOf = ");
    expect(at).toBeGreaterThan(-1);
    expect(list.slice(at, at + 900)).toContain("liabilityTypeKeyOf(p)");
  });

  it("the list dates a loan from the temporal engine, never from a stored origin date ('1601d overdue')", () => {
    expect(list).toMatch(/const rawDue = isRecurringBillRecord\(liab\)/);
    const at = list.indexOf("const rawDue = isRecurringBillRecord(liab)");
    expect(list.slice(at, at + 600)).toMatch(/: \(getRecordTemporalStatus\(/);
  });

  it("the nested panel lists children — a nested liability is stored as parentProfileId", () => {
    expect(page).toMatch(/p\?\.parentProfileId !== liabilityId/);
  });
});

describe("L5 — payments", () => {
  it("'Extra principal' sends the extra alone, typed extra_principal", () => {
    expect(page).toContain('else if (preset === "extra") initial = "100.00";');
    expect(page).toMatch(/paymentDialog\.preset === "extra" \? \{ paymentType: "extra_principal"/);
  });

  it("reversing a payment takes two taps (Rule 8)", () => {
    expect(page).toMatch(/onClick=\{\(\) => confirmReverse\(`reverse-\$\{p\.id\}`, onReverse\)\}/);
    expect(page).not.toMatch(/onClick=\{onReverse\}/);
  });
});

describe("L6 — a profile reopened after a write made elsewhere shows it", () => {
  it("the detail query never blanket-disables its mount refetch (stale header balance)", () => {
    const detail = src("client/src/pages/profile-detail.tsx");
    const at = detail.indexOf('queryKey: ["/api/profiles", id, "detail"]');
    expect(at).toBeGreaterThan(-1);
    const query = detail.slice(at, at + 6000);
    expect(query).not.toMatch(/refetchOnMount: false/);
  });
});

describe("the rules are written down", () => {
  it("CLAUDE.md carries the Liability rules and names this guard", () => {
    const rules = src("CLAUDE.md");
    expect(rules).toContain("## Liability rules");
    expect(rules).toContain("tests/liability-rules-guards.test.ts");
    for (const n of ["L1", "L2", "L3", "L4", "L5", "L6", "L7"]) expect(rules, n).toContain(`**${n}.`);
  });
});
