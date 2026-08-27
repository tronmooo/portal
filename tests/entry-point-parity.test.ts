// Cross-cutting entry-point parity — the "one operation per action" guard.
//
// Bill payments have their own parity file (tests/bill-entry-point-parity).
// This one pins the same architecture rule for the other unified operations:
// an entry point (REST route, AI tool, extraction executor) never calls the
// raw storage primitive when a canonical operation with a fuller side-effect
// set exists. Each rule names the bug class it pins.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
const count = (src: string, needle: RegExp) => (src.match(needle) || []).length;
const ENTRY_FILES = ["server/routes.ts", "server/ai-engine.ts", "server/action-executor.ts"] as const;

describe("habit completion: the pipeline is the only door", () => {
  it("raw checkinHabit appears only at the backup-import exemption", () => {
    // Bypassing completeHabitOccurrence skips the schedule check and the
    // tracker mirror — the "ring says done, chart says nothing" bug. The
    // backup import restores raw rows deliberately.
    const budgets: Record<string, number> = { "server/routes.ts": 1, "server/ai-engine.ts": 0, "server/action-executor.ts": 0 };
    for (const f of ENTRY_FILES) {
      expect(count(read(f), /storage\.checkinHabit\(/g), `${f}: raw checkinHabit`).toBeLessThanOrEqual(budgets[f]);
    }
  });

  it("no entry point calls deleteHabitCheckin directly", () => {
    // The raw delete leaves the mirrored tracker entry behind; the inverse
    // pipeline (uncompleteHabitOccurrence) removes both.
    for (const f of ENTRY_FILES) {
      expect(count(read(f), /storage\.deleteHabitCheckin\(/g), `${f}: bare un-check`).toBe(0);
    }
  });
});

describe("documents: the lifecycle module is the only door", () => {
  it("no entry point calls raw deleteDocument", () => {
    // deleteDocumentEverywhere carries the cascade (fields, derived events,
    // back-references, AI summaries); the raw method is just the row flip.
    for (const f of ENTRY_FILES) {
      expect(count(read(f), /storage\.deleteDocument\(/g), `${f}: bare document delete`).toBe(0);
    }
  });

  it("purgeDocument is called only from the purge route and the lifecycle module", () => {
    // The single byte-destroyer stays explicit — anything else re-creates the
    // "recoverable delete that already destroyed the file" zombie.
    expect(count(read("server/routes.ts"), /storage\.purgeDocument\(/g)).toBe(1);
    expect(count(read("server/ai-engine.ts"), /purgeDocument\(/g)).toBe(0);
    expect(count(read("server/action-executor.ts"), /purgeDocument\(/g)).toBe(0);
  });
});

describe("the retired reach-around is dead", () => {
  it("entry files never issue raw supabase writes against lifecycle tables", () => {
    for (const f of ENTRY_FILES) {
      const src = read(f);
      for (const table of ["liability_payments", "habit_checkins", "tracker_entries", "goals"]) {
        const raw = new RegExp(`supabase\\s*\\n?\\s*\\.from\\(["'\`]${table}["'\`]\\)\\s*\\n?\\s*\\.(delete|insert|update|upsert)\\(`);
        expect(raw.test(src), `${f}: raw supabase write to ${table}`).toBe(false);
      }
    }
  });
});
