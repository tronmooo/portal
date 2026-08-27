// Entry-point parity for bill payments — a static guard.
//
// Every entry point (REST route, AI tool, extraction executor, autopay cron)
// must pay through payBillOccurrence and undo through unpayBillOccurrence.
// Each rule below pins the bug class that consolidating killed; a new call
// site that resurrects a retired path fails here by name.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
const ENTRY_FILES = ["server/routes.ts", "server/ai-engine.ts", "server/action-executor.ts"];

describe("bill payments: one operation, every entry point", () => {
  it("the retired implementations are gone (payObligation, payOccurrence)", () => {
    // Six divergent pay implementations is the bug this suite exists to bury.
    for (const f of [...ENTRY_FILES, "server/storage.ts", "server/supabase-storage.ts"]) {
      const src = read(f);
      expect(src, `${f} resurrects payObligation`).not.toMatch(/\bpayObligation\s*\(/);
      expect(src, `${f} resurrects payOccurrence`).not.toMatch(/\bpayOccurrence\s*\(/);
    }
  });

  it("no entry point calls the ledger core directly", () => {
    // applyLiabilityPayment is payBillOccurrence's internal ledger step. An
    // entry point calling it directly skips the occurrence stamp, the due-date
    // policy, the account debit and the expense — the exact partial-pay bug.
    for (const f of ENTRY_FILES) {
      expect(read(f), `${f} bypasses payBillOccurrence`).not.toMatch(/\bapplyLiabilityPayment\s*\(/);
    }
  });

  it("the occurrence surface is typed — no (storage as any) reach-arounds", () => {
    // These methods were off-interface, so every caller cast and the noun
    // coverage test could not see them (every occurrence write nuked all
    // cache domains). They are on IStorage now; casts would hide regressions.
    const promoted = [
      "payOccurrence", "skipOccurrence", "getLiabilitySchedule", "rescheduleOccurrence",
      "setOccurrenceFields", "setOccurrenceEstimate", "setOccurrenceActual",
      "addOccurrenceCharge", "removeOccurrenceCharge", "pauseLiability",
      "resumeLiability", "adjustAccountBalance", "updateOccurrenceOverride",
    ];
    for (const f of ENTRY_FILES) {
      const src = read(f);
      for (const m of promoted) {
        expect(src, `${f} calls ${m} through a cast`).not.toContain(`(storage as any).${m}(`);
      }
    }
  });

  it("no entry point touches liability_payments with raw supabase", () => {
    // The undo route used to do `.supabase.from("liability_payments").delete()`
    // — no write journal, no manifest, no reversal of anything the pay wrote.
    for (const f of ENTRY_FILES) {
      expect(read(f), `${f} reaches around the storage layer for payments`)
        .not.toMatch(/from\(\s*["'`]liability_payments["'`]\s*\)/);
    }
  });

  it("raw createLiabilityPayment appears only at the documented exemption", () => {
    // The backup import restores HISTORY: raw ledger rows, deliberately no
    // due-date advance / account debit / expense. Everything else pays
    // through the operation.
    for (const f of ENTRY_FILES) {
      const src = read(f);
      const count = (src.match(/storage\.createLiabilityPayment\(/g) || []).length;
      const budget = f === "server/routes.ts" ? 1 : 0;
      expect(count, `${f}: unexpected raw createLiabilityPayment call`).toBeLessThanOrEqual(budget);
    }
  });

  it("undo is the full inverse everywhere — no bare deleteLiabilityPayment from entry points", () => {
    for (const f of ENTRY_FILES) {
      expect(read(f), `${f} deletes a payment without reversing it`)
        .not.toMatch(/storage\.deleteLiabilityPayment\(/);
    }
  });
});
