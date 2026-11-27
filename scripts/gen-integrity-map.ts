// Regenerate docs/INTEGRITY_MAP.md: the dependency map (what each kind of
// record is stored as, changed through, feeds and takes with it) and the
// coverage matrix (data type × operation × door, with the evidence for each).
//   npx tsx scripts/gen-integrity-map.ts
// The model is tests/integrity/model.ts; the doors are read from the code by
// scripts/workflow-inventory.ts; tests/integrity-model.test.ts keeps both honest.
import fs from "fs";
import path from "path";
import { TOOL_DEFINITIONS } from "../server/ai-engine";
import { ROOT, buildInventory, type Coverage } from "./workflow-inventory";
import {
  MODEL, OPERATIONS, OPERATION_MEANING, PROFILE_DOORS, CROSS_CUTTING, entityOfRoute, entityOfTool, operationOfRoute, operationOfTool, parseCoverKey,
  type Operation, type Door,
} from "../tests/integrity/model";
import { allScenarios } from "../tests/integrity/framework";
import "../tests/integrity/scenarios/index";

export interface Cell {
  /** the door exists */
  doors: string[];
  /** integrity scenarios that verify it with database + derived evidence */
  verifiedBy: string[];
  /** other tests that name it */
  tests: Coverage;
}
export interface MatrixRow { entity: string; label: string; op: Operation; ui: Cell; api: Cell; chat: Cell }

const empty = (): Cell => ({ doors: [], verifiedBy: [], tests: { local: [], contract: [], live: [] } });
const merge = (into: Coverage, from: Coverage) => { for (const k of ["local", "contract", "live"] as const) for (const f of from[k]) if (!into[k].includes(f)) into[k].push(f); };

export function buildMatrix() {
  const inv = buildInventory(TOOL_DEFINITIONS.map((t: any) => t.name));
  const scenarios = allScenarios();
  const rows = new Map<string, MatrixRow>();
  const row = (entity: string, op: Operation) => {
    const k = `${entity}.${op}`;
    if (!rows.has(k)) rows.set(k, { entity, label: MODEL.find((m) => m.key === entity)!.label, op, ui: empty(), api: empty(), chat: empty() });
    return rows.get(k)!;
  };
  const routeByKey = new Map(inv.routes.map((r) => [`${r.method} ${r.path}`, r]));
  const toolByName = new Map(inv.tools.map((t) => [t.name, t]));

  for (const r of inv.routes) {
    const e = entityOfRoute(r.path);
    const op = operationOfRoute(r.method, r.path);
    if (!e || e.system || op === "read") continue;
    const m = row(e.key, op);
    m.api.doors.push(`${r.method} ${r.path}`);
    merge(m.api.tests, r.tests);
    if (r.ui.length) { m.ui.doors.push(...r.ui.filter((f) => !m.ui.doors.includes(f))); }
  }
  for (const t of inv.tools) {
    const e = entityOfTool(t.name);
    const op = operationOfTool(t.name);
    if (!e || e.system || !op) continue;
    const m = row(e.key, op);
    m.chat.doors.push(t.name);
    merge(m.chat.tests, t.tests);
  }
  // profile-backed records are also created / edited / deleted through the profile doors
  for (const e of MODEL.filter((m) => m.profileBacked)) {
    for (const op of ["create", "edit", "delete"] as const) {
      const m = row(e.key, op);
      for (const key of PROFILE_DOORS[op].routes) {
        const r = routeByKey.get(key);
        if (!r) throw new Error(`profile door ${key} is not a route any more`);
        m.api.doors.push(`${key} (as a ${e.key})`);
        merge(m.api.tests, r.tests);
        if (r.ui.length && !m.ui.doors.length) m.ui.doors.push(...r.ui);
      }
      for (const name of PROFILE_DOORS[op].tools) {
        const tool = toolByName.get(name);
        if (!tool) throw new Error(`profile tool ${name} is gone`);
        if (!m.chat.doors.length) { m.chat.doors.push(`${name} (as a ${e.key})`); merge(m.chat.tests, tool.tests); }
      }
    }
  }
  const crossCutting: Record<string, string[]> = {};
  for (const s of scenarios) {
    for (const key of s.covers) {
      const c = parseCoverKey(key);
      if (c === null) throw new Error(`scenario ${s.id} covers an unknown key ${key}`);
      if (c === "cross-cutting") { (crossCutting[key] ??= []).push(s.id); continue; }
      const m = row(c.entity, c.op);
      const cell = m[c.door as Door];
      if (!cell.verifiedBy.includes(s.id)) cell.verifiedBy.push(s.id);
    }
  }
  const order = (r: MatrixRow) => MODEL.findIndex((m) => m.key === r.entity) * 100 + OPERATIONS.indexOf(r.op);
  return { inv, scenarios, rows: [...rows.values()].sort((a, b) => order(a) - order(b)), crossCutting };
}

export type CellState = "verified" | "tested" | "untested" | "none";
export const stateOf = (c: Cell): CellState =>
  c.verifiedBy.length ? "verified" : !c.doors.length ? "none" : c.tests.local.length + c.tests.contract.length + c.tests.live.length ? "tested" : "untested";

function render(): string {
  const { inv, scenarios, rows, crossCutting } = buildMatrix();
  const L: string[] = [];
  const out = (s = "") => L.push(s);
  const cell = (c: Cell, door: Door) => {
    const st = stateOf(c);
    if (st === "none") return "—";
    if (st === "verified") return `**V** ${c.verifiedBy.map((v) => `\`${v}\``).join(" ")}`;
    if (door === "ui") return c.doors.length ? "screen" : "—";
    const n = c.tests.local.length + c.tests.contract.length + c.tests.live.length;
    return st === "tested" ? `t${n}${c.tests.contract.length + c.tests.live.length ? " (live)" : ""}` : "**none**";
  };

  out("# Integrity map");
  out();
  out("Generated by `npx tsx scripts/gen-integrity-map.ts` — do not edit by hand.");
  out("The model is `tests/integrity/model.ts`; the doors (routes, chat tools, screens) are read from the code.");
  out();
  out("Two parts. **The dependency map** says, for each kind of record, where it is stored, every door that");
  out("changes it, every figure computed from it (and the one module that computes it), and what else must");
  out("change when it changes. **The coverage matrix** says, for each data type × operation × door, what");
  out("evidence there is that the door works — and it separates a test that *names* a door from a scenario that");
  out("*verifies its consequences*.");
  out();
  const doorCells = rows.flatMap((r) => (["api", "chat"] as const).map((d) => stateOf(r[d])));
  const count = (s: CellState) => doorCells.filter((c) => c === s).length;
  const uiRows = rows.filter((r) => r.ui.doors.length || r.ui.verifiedBy.length);
  out("## Summary");
  out();
  out(`- ${MODEL.filter((m) => !m.system).length} data types, ${OPERATIONS.length} operations, 3 doors (the app's screens, the API, AI Chat).`);
  out(`- ${rows.length} data type × operation rows have at least one door.`);
  out(`- API and AI Chat: ${count("verified") + count("tested") + count("untested")} doors. **${count("verified")}** are verified by an integrity scenario (the action, the stored row and the dependent figures); **${count("tested")}** more are named by an existing test (evidence, not proof — see docs/WORKFLOW_MATRIX.md); **${count("untested")}** have no test at all.`);
  out(`- Screens: ${uiRows.length} operations are offered by a screen; **${uiRows.filter((r) => r.ui.verifiedBy.length).length}** are driven by an integrity browser scenario (desktop mouse and phone touch). The rest are covered per screen by the live browser checks listed in docs/WORKFLOW_MATRIX.md, not by a database-verified scenario.`);
  out(`- ${scenarios.length} integrity scenarios; ${scenarios.filter((s) => s.browser).length} drive a browser, ${scenarios.filter((s) => s.chat).length} drive AI Chat.`);
  out();
  out("## Dependency map");
  for (const e of MODEL.filter((m) => !m.system)) {
    out();
    out(`### ${e.label} \`${e.key}\``);
    out();
    out(`**Stored in:** ${e.stores.map((s) => `\`${s}\``).join(", ") || "—"}`);
    out();
    const mine = rows.filter((r) => r.entity === e.key);
    if (mine.length) {
      out("**Changed through:**");
      out();
      out("| Operation | API | AI Chat | Screens that call it |");
      out("|---|---|---|---|");
      for (const r of mine) {
        const screens = [...new Set(r.ui.doors.map((f) => f.replace(/^client\/src\//, "")))];
        out(`| ${r.op} | ${r.api.doors.map((d) => `\`${d.replace("/api", "")}\``).join("<br>") || "—"} | ${r.chat.doors.map((d) => `\`${d}\``).join("<br>") || "—"} | ${screens.slice(0, 4).map((s) => `\`${s}\``).join("<br>")}${screens.length > 4 ? `<br>+${screens.length - 4} more` : ""} |`);
      }
      out();
    }
    if (e.derived.length) {
      out("**Feeds (a write must move each of these):**");
      out();
      out("| Figure | Computed by | Shown on |");
      out("|---|---|---|");
      for (const d of e.derived) out(`| ${d.name} | \`${d.source}\` | ${d.shownOn.join("; ")} |`);
      out();
    }
    if (e.dependents.length) { out("**Takes with it / must stay true:**"); out(); for (const d of e.dependents) out(`- ${d}`); out(); }
    out(`**Shown on:** ${e.screens.map((s) => `\`${s}\``).join(" ")}`);
  }
  out();
  out("## Coverage matrix");
  out();
  out("`V` = verified by the named integrity scenario (the action, the stored row and the dependent figures were checked).");
  out("`tN` = named by N existing tests (`(live)` = at least one runs against the deployed app). `screen` = a screen calls it;");
  out("its browser checks are per screen in docs/WORKFLOW_MATRIX.md. `none` = a door with no test. `—` = no such door.");
  out();
  out("| Data type | Operation | Screens | API | AI Chat |");
  out("|---|---|---|---|---|");
  for (const r of rows) out(`| ${r.label} | ${r.op} | ${cell(r.ui, "ui")} | ${cell(r.api, "api")} | ${cell(r.chat, "chat")} |`);
  out();
  out("### Cross-cutting properties");
  out();
  out("| Property | Verified by |");
  out("|---|---|");
  for (const [k, what] of Object.entries(CROSS_CUTTING)) out(`| ${what} | ${(crossCutting[k] || []).map((s) => `\`${s}\``).join(" ") || "**none**"} |`);
  out();
  out("## Gaps");
  out();
  const noTest = rows.flatMap((r) => (["api", "chat"] as const).filter((d) => stateOf(r[d]) === "untested").map((d) => `- **${r.label} · ${r.op} · ${d === "api" ? "API" : "AI Chat"}**: ${r[d].doors.map((x) => `\`${x}\``).join(", ")}`));
  out(`### Doors with no test at all (${noTest.length})`);
  out();
  for (const g of noTest) out(g);
  out();
  const unverified = rows.flatMap((r) => (["api", "chat"] as const).filter((d) => stateOf(r[d]) === "tested").map((d) => `${r.label} · ${r.op} · ${d === "api" ? "API" : "Chat"}`));
  out(`### Doors a test names but no integrity scenario verifies (${unverified.length})`);
  out();
  out(unverified.join("; ") + ".");
  out();
  const uiUnverified = rows.filter((r) => r.ui.doors.length && !r.ui.verifiedBy.length).map((r) => `${r.label} · ${r.op}`);
  out(`### Operations a screen offers that no integrity browser scenario drives (${uiUnverified.length})`);
  out();
  out(uiUnverified.join("; ") + ".");
  out();
  out("## Scenarios");
  out();
  out("| Scenario | Area | Evidence it owes | Covers |");
  out("|---|---|---|---|");
  for (const s of scenarios) out(`| \`${s.id}\` — ${s.title} | ${s.area} | ${s.requires.join(" + ")}${s.browser ? " · browser" : ""}${s.chat ? " · chat" : ""} | ${s.covers.join(", ")} |`);
  out();
  out("## Operations");
  out();
  for (const op of OPERATIONS) out(`- **${op}** — ${OPERATION_MEANING[op]}`);
  out();
  void inv;
  return L.join("\n");
}

if (process.argv[1] && process.argv[1].endsWith("gen-integrity-map.ts")) {
  const file = path.join(ROOT, "docs/INTEGRITY_MAP.md");
  fs.writeFileSync(file, render());
  const { rows } = buildMatrix();
  console.log(`wrote ${path.relative(ROOT, file)} (${rows.length} rows)`);
}
