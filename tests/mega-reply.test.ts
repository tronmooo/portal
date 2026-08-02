// Pins the deterministic sectioned mega reply: grouping by dashboard section
// in display order, derived-section honesty notes, dedupe/failure/skip lines,
// and the validation footer.
import { describe, it, expect } from "vitest";
import { buildMegaReply, type MegaValidationSummary } from "../server/ai-mega-plan";
import type { OperationOutcome } from "../server/ai-bulk-log";

function outcome(partial: Partial<OperationOutcome> & Pick<OperationOutcome, "tool" | "status">): OperationOutcome {
  return { index: 0, raw: partial.raw ?? "op", ...partial } as OperationOutcome;
}

describe("buildMegaReply", () => {
  it("groups outcomes by section in fixed display order with headers", () => {
    const reply = buildMegaReply([
      outcome({ tool: "create_liability", status: "ok", raw: "internet bill", section: "bills" }),
      outcome({ tool: "create_task", status: "ok", raw: "call the dentist", section: "tasks" }),
      outcome({ tool: "create_reminder", status: "ok", raw: "registration renewal", section: "attention" }),
    ]);
    const attention = reply.indexOf("**Attention**");
    const tasks = reply.indexOf("**Tasks**");
    const bills = reply.indexOf("**Bills**");
    expect(attention).toBeGreaterThan(-1);
    expect(tasks).toBeGreaterThan(attention);
    expect(bills).toBeGreaterThan(tasks);
  });

  it("derived sections open with an honesty note", () => {
    const reply = buildMegaReply([
      outcome({ tool: "create_reminder", status: "ok", raw: "registration renewal", section: "attention" }),
    ]);
    expect(reply).toContain("Attention is computed from urgent source records");
  });

  it("renders dedupe, failure, and skip lines honestly and counts them in the header", () => {
    const reply = buildMegaReply([
      outcome({ tool: "create_liability", status: "ok", raw: "internet", section: "bills" }),
      outcome({ tool: "create_obligation", status: "deduped", raw: "internet bill", section: "bills", detail: "same recurring payment — saved once" }),
      outcome({ tool: "create_habit", status: "failed", raw: "water goal", section: "habits", error: "Validation failed: bad frequency" }),
      outcome({ tool: "create_task", status: "skipped", raw: "clean car", section: "tasks", error: "Ran out of time" }),
    ]);
    expect(reply).toContain("1 saved, 1 failed, 1 not run");
    expect(reply).toContain("↩️ internet bill — same recurring payment — saved once");
    expect(reply).toContain("✗ water goal — Validation failed: bad frequency");
    expect(reply).toContain("⏸ clean car — Ran out of time");
  });

  it("all-ok header claims every operation and mentions Documents were skipped", () => {
    const reply = buildMegaReply([
      outcome({ tool: "create_task", status: "ok", raw: "a", section: "tasks" }),
      outcome({ tool: "create_task", status: "ok", raw: "b", section: "tasks" }),
    ]);
    expect(reply).toContain("2 separate operations");
    expect(reply).toContain("Documents were skipped");
  });

  it("renders the validation footer with verified saves, recurrence, and no-duplicates", () => {
    const validation: MegaValidationSummary = {
      verifiedSaves: 3,
      totalOk: 3,
      recurrenceChecked: 2,
      recurrenceConfirmed: 2,
      duplicateWarnings: [],
    };
    const reply = buildMegaReply(
      [
        outcome({ tool: "create_task", status: "ok", raw: "a", section: "tasks" }),
        outcome({ tool: "create_liability", status: "ok", raw: "b", section: "bills", recurrenceVerified: true }),
        outcome({ tool: "create_liability", status: "ok", raw: "c", section: "bills", recurrenceVerified: true }),
      ],
      validation,
    );
    expect(reply).toContain("All 3 saves verified in the database");
    expect(reply).toContain("recurrence confirmed for 2 recurring records");
    expect(reply).toContain("no duplicates created");
  });

  it("flags unverified recurrence on the item line and reports partial verification", () => {
    const validation: MegaValidationSummary = {
      verifiedSaves: 1,
      totalOk: 2,
      recurrenceChecked: 1,
      recurrenceConfirmed: 0,
      duplicateWarnings: ["Two records named 'Phone' now exist — review Bills."],
    };
    const reply = buildMegaReply(
      [
        outcome({ tool: "create_liability", status: "ok", raw: "phone bill", section: "bills", recurrenceVerified: false }),
        outcome({ tool: "create_task", status: "ok", raw: "budget", section: "tasks" }),
      ],
      validation,
    );
    expect(reply).toContain("couldn't confirm future occurrences");
    expect(reply).toContain("1 of 2 saves verified");
    expect(reply).toContain("recurrence confirmed for 0 of 1");
    expect(reply).toContain("⚠️ Two records named 'Phone' now exist");
    expect(reply).not.toContain("no duplicates created");
  });

  it("offers the continue hint when the budget ran out", () => {
    const reply = buildMegaReply(
      [outcome({ tool: "create_task", status: "skipped", raw: "x", section: "tasks", error: "Ran out of time" })],
      { verifiedSaves: 0, totalOk: 0, recurrenceChecked: 0, recurrenceConfirmed: 0, duplicateWarnings: [], continueHint: true },
    );
    expect(reply).toContain('say "continue"');
  });

  it("handles the empty plan", () => {
    expect(buildMegaReply([])).toContain("couldn't extract any operations");
  });
});
