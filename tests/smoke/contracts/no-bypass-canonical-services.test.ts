/**
 * Build-time guard: writes go through the canonical action services.
 *
 * The orchestration layer (server/actions/*) exists so that expense, event
 * and tracker-entry creation each have ONE pipeline — validation, dedup,
 * category/value canon, attribution, implied writes — whatever door the
 * request came through. The historical failure mode was a new route or tool
 * calling storage.create* directly and quietly forking the rules again.
 *
 * This guard pins the remaining direct-call sites as per-file BUDGETS. Every
 * remaining site is deliberate (bulk import loops where the duplicate guard
 * would fight legitimately repeating rows; deterministic fast-path quick
 * logs; the engine's internal self-heal/merge mechanics). Budgets may only
 * ever go DOWN — migrate a site to the service, then lower the number. A new
 * direct call pushes the count over budget and fails this test; the fix is
 * to call the service (server/actions/expense-service.ts, event-service.ts,
 * tracker-entry-service.ts), not to raise the budget.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const REPO = path.resolve(__dirname, "..", "..", "..");

// file → { pattern → allowed count }
const BUDGETS: Record<string, Record<string, number>> = {
  "server/routes.ts": {
    "storage.createExpense(": 2, // finance-import + bank-CSV bulk loops
    "storage.createEvent(": 2,   // finance-import loop + liability schedule mirror
    "storage.logEntry(": 2,      // smart-entry route + finance-import loop
  },
  "server/ai-engine.ts": {
    "storage.createExpense(": 0, // fully consolidated
    "storage.createEvent(": 1,   // internal mirror write
    "storage.logEntry(": 7,      // fast-path quick logs (weight/bp/sleep/run/mood),
                                 // duplicate-tracker self-heal, update_tracker_entry
  },
};

describe("canonical services are the write path (contracts)", () => {
  for (const [file, budgets] of Object.entries(BUDGETS)) {
    const src = readFileSync(path.join(REPO, file), "utf8");
    for (const [needle, allowed] of Object.entries(budgets)) {
      it(`${file} calls ${needle.replace("(", "")} directly at most ${allowed}×`, () => {
        const count = src.split(needle).length - 1;
        expect(
          count,
          `${file} now has ${count} direct ${needle}...) calls (budget ${allowed}). ` +
            `New writes must go through the canonical service in server/actions/ ` +
            `so every door shares one pipeline; if you migrated a site to the ` +
            `service, LOWER this budget instead.`,
        ).toBeLessThanOrEqual(allowed);
      });
    }
  }
});
