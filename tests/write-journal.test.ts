import { describe, it, expect } from "vitest";
import { createWriteJournal, writeJournalContext, journalStorageCall } from "../server/write-journal";

/** Run a body inside a fresh journal and return what it recorded. */
function journaled(body: () => void) {
  const journal = createWriteJournal();
  writeJournalContext.run(journal, body);
  return { journal, manifest: journal.drain() };
}

describe("write journal — what a request actually changed", () => {
  it("reports BOTH entities a liability payment touches", () => {
    // This is the bug the whole manifest exists for. Recording a payment
    // writes the payment row AND the liability profile whose balance it moved.
    // The response only ever carried the payment, so the balance had nothing to
    // update from and waited for a refetch.
    const { manifest } = journaled(() => {
      journalStorageCall("createLiabilityPayment", [{ liabilityProfileId: "liab-1", amount: 200 }],
        { id: "pay-1", liabilityProfileId: "liab-1", amount: 200 });
      journalStorageCall("updateProfile", ["liab-1", {}],
        { id: "liab-1", name: "Car loan", fields: { currentBalance: 800 } });
    });

    expect(manifest.changes).toHaveLength(2);
    const payment = manifest.changes.find((c) => c.id === "pay-1")!;
    expect(payment.op).toBe("create");
    expect(payment.endpoint).toBe("/api/liabilities/liab-1/payments");
    const liability = manifest.changes.find((c) => c.id === "liab-1")!;
    expect(liability.op).toBe("update");
    expect(liability.endpoint).toBe("/api/profiles");
    expect((liability.row as any).fields.currentBalance).toBe(800);

    // …and every domain that renders either of them.
    for (const d of ["liabilities", "obligations", "expenses", "profiles", "assets", "people"]) {
      expect(manifest.domains).toContain(d);
    }
  });

  it("takes a delete's id from the arguments, since a delete returns a boolean", () => {
    const { manifest } = journaled(() => journalStorageCall("deleteTask", ["t1"], true));
    expect(manifest.changes).toEqual([{ op: "delete", endpoint: "/api/tasks", id: "t1" }]);
    expect(manifest.domains).toEqual(["tasks"]);
  });

  it("records nothing for infrastructure calls", () => {
    // These run on every request. Counting them as writes would make every
    // request report "everything" and defeat the entire design.
    const { journal, manifest } = journaled(() => {
      journalStorageCall("bumpDataVersion", [], 7);
      journalStorageCall("setResponseCache", ["k", {}, 1000], undefined);
      journalStorageCall("enableRequestMemo", [], undefined);
      journalStorageCall("recallMemory", ["dentist"], [{ id: "m1" }]);
      journalStorageCall("wouldCreateCycle", ["a", "b"], false);
    });
    expect(journal.dirty).toBe(false);
    expect(manifest.changes).toEqual([]);
  });

  it("degrades an unrecognized write to everything rather than to nothing", () => {
    const { manifest } = journaled(() => journalStorageCall("createWidget", [{}], { id: "w1" }));
    expect(manifest.domains).toEqual(["everything"]);
  });

  it("collapses repeated writes to one row into its final state", () => {
    const { manifest } = journaled(() => {
      journalStorageCall("updateProfile", ["p1", {}], { id: "p1", name: "old", fields: { currentBalance: 900 } });
      journalStorageCall("updateProfile", ["p1", {}], { id: "p1", name: "new", fields: { currentBalance: 800 } });
    });
    expect(manifest.changes).toHaveLength(1);
    expect((manifest.changes[0].row as any).name).toBe("new");
  });

  it("keeps the domains and drops the detail past the change cap", () => {
    const { manifest } = journaled(() => {
      for (let i = 0; i < 120; i++) {
        journalStorageCall("createExpense", [{}], { id: `e${i}`, amount: i });
      }
    });
    expect(manifest.domains).toEqual(["expenses"]);
    expect(manifest.changes).toEqual([]);
    expect(manifest.truncated).toBe(true);
  });

  it("is inert outside a request", () => {
    // Cron jobs and startup call storage too; they must not throw.
    expect(() => journalStorageCall("createTask", [{}], { id: "t" })).not.toThrow();
  });

  it("reports everything when a write recorded no domain at all", () => {
    expect(createWriteJournal().drain().domains).toEqual(["everything"]);
  });
});
