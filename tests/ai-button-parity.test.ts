// ── UI ↔ AI CRUD parity (matrix-driven) ──────────────────────────────────────
// The machine-checkable "the AI chat can do everything the dashboard can"
// contract, driven by shared/ai-parity-matrix.ts — the single source of truth
// that also generates docs/ai-crud-parity.md. Rules enforced here:
//   • covered/added rows: every referenced AI tool must exist in the registry,
//     so a renamed/removed tool that silently breaks parity fails CI.
//   • planned rows: allowed while the 2026-07 parity effort is in flight; some
//     reference EXISTING tools being extended (update_task tag merge,
//     update_obligation occurrence ops, update_artifact pinned), so no
//     existence assertion either way. Flip to "added" as each batch lands.
//   • excluded rows: must carry a reason and reference no tools — these are
//     the deliberate "the AI won't do this" list.
// When a new dashboard capability ships, add its row to the matrix (not here).
import { describe, it, expect } from "vitest";
import { TOOL_DEFINITIONS } from "../server/ai-engine";
import { PARITY_MATRIX } from "../shared/ai-parity-matrix";

const toolNames = new Set(TOOL_DEFINITIONS.map((t: any) => t.name));

describe("AI ↔ dashboard CRUD parity matrix", () => {
  const covered = PARITY_MATRIX.filter((r) => r.status === "covered" || r.status === "added");
  const planned = PARITY_MATRIX.filter((r) => r.status === "planned");
  const excluded = PARITY_MATRIX.filter((r) => r.status === "excluded");

  for (const row of covered) {
    it(`${row.entity} — "${row.operation}" maps to real tool(s): ${row.aiTools.join(" | ")}`, () => {
      expect(row.aiTools.length, `row has no aiTools`).toBeGreaterThan(0);
      const missing = row.aiTools.filter((t) => !toolNames.has(t));
      expect(missing, `unknown tools: ${missing.join(", ")}`).toEqual([]);
    });
  }

  it("excluded rows carry a reason and no tools", () => {
    for (const row of excluded) {
      expect(row.reason, `${row.entity} / ${row.operation} excluded without a reason`).toBeTruthy();
      expect(row.aiTools, `${row.entity} / ${row.operation} excluded but references tools`).toEqual([]);
    }
  });

  it("planned rows name the tool(s) they will land as", () => {
    for (const row of planned) {
      expect(row.aiTools.length, `${row.entity} / ${row.operation} planned without target tools`).toBeGreaterThan(0);
    }
  });

  it("covers the full dashboard surface", () => {
    // Superset of the old 33-row DASHBOARD_ACTIONS table.
    expect(PARITY_MATRIX.length).toBeGreaterThanOrEqual(80);
    expect(covered.length).toBeGreaterThanOrEqual(60);
  });

  it("no duplicate entity+operation rows", () => {
    const keys = PARITY_MATRIX.map((r) => `${r.entity}::${r.operation}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
