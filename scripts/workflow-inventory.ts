// Workflow inventory — every door into the app, and the tests that touch it.
//
// WHY (owner, 2026-11-24: "list every single workflow … make sure every one of
// those works in the front end and back end … on both web and mobile"): there
// was no single list. The API routes live in four server files, the chat tools
// in two, the screens in App.tsx, and ~500 test files each name the few routes
// they care about. Nobody could say which workflows had no test at all.
//
// This module READS the code (no hand-kept list to drift):
//   · every API route (method + path) the server registers,
//   · every chat tool in TOOL_DEFINITIONS (passed in by the caller),
//   · every screen route in client/src/App.tsx,
// and, for each, the test files that reference it, by layer:
//   local    — runs in `npx vitest run` (listed in vitest.config.ts)
//   contract — the pre-push contract suite (deployed app, smoke account)
//   live     — a live scenario / live check / acceptance rig
//   browser  — a live check that opens the screen in a real browser
//   touch    — … in a touch (phone) context
//
// A reference is EVIDENCE, not proof: a test that names a route may assert
// little about it. The value is in the other direction — a route NO test
// names is certainly unproven.
//
// Used by scripts/gen-workflow-matrix.ts (writes docs/WORKFLOW_MATRIX.md) and
// tests/workflow-matrix.test.ts (a new route or tool with no domain fails).

import fs from "fs";
import path from "path";

export const ROOT = process.cwd();

// ── Domains ──────────────────────────────────────────────────────────────────

export const DOMAINS = [
  "Account & access",
  "Profiles",
  "Assets & ownership",
  "Accounts & net worth",
  "Liabilities",
  "Auto Pay",
  "Bills & obligations",
  "Finance",
  "Tasks",
  "Calendar",
  "Habits",
  "Goals",
  "Trackers & health",
  "Wellness dashboard",
  "Executive dashboard & alerts",
  "Documents & artifacts",
  "Workspaces",
  "Journal & notes",
  "Record details",
  "AI chat",
  "System (not a user workflow)",
] as const;
export type Domain = (typeof DOMAINS)[number];

/** First path segment after /api → domain. A segment missing here fails the
 *  guard test, so a new resource has to be placed before it ships. */
const SEGMENT_DOMAIN: Record<string, Domain> = {
  auth: "Account & access", onboarding: "Account & access", "onboarding-status": "Account & access",
  preferences: "Account & access", export: "Account & access", data: "Account & access",
  public: "Account & access", "audit-log": "Account & access", import: "Account & access",
  profiles: "Profiles", "profile-types": "Profiles", "profile-bootstrap": "Profiles",
  relationships: "Profiles", "entity-links": "Profiles",
  assets: "Assets & ownership", valuations: "Assets & ownership", "asset-party-links": "Assets & ownership",
  "ownership-history": "Assets & ownership", parties: "Assets & ownership",
  accounts: "Accounts & net worth", "net-worth": "Accounts & net worth",
  liabilities: "Liabilities", loans: "Liabilities", "liability-payments": "Liabilities",
  "liability-profile-links": "Liabilities", "liability-asset-links": "Liabilities",
  autopay: "Auto Pay",
  obligations: "Bills & obligations", "obligation-occurrences": "Bills & obligations",
  finance: "Finance", "finance-import": "Finance", expenses: "Finance", incomes: "Finance",
  paychecks: "Finance", budgets: "Finance", cashflow: "Finance", "receipt-extract": "Finance",
  anomalies: "Finance",
  tasks: "Tasks",
  events: "Calendar", calendar: "Calendar", "date-rules": "Calendar",
  habits: "Habits",
  goals: "Goals",
  trackers: "Trackers & health", "tracker-entries": "Trackers & health",
  wellness: "Wellness dashboard", "wellness-widgets": "Wellness dashboard",
  dashboard: "Executive dashboard & alerts", "dashboard-enhanced": "Executive dashboard & alerts",
  "dashboard-bootstrap": "Executive dashboard & alerts", "exec-widgets": "Executive dashboard & alerts",
  notifications: "Executive dashboard & alerts", insights: "Executive dashboard & alerts",
  "weekly-review": "Executive dashboard & alerts", "ai-digest": "Executive dashboard & alerts",
  activity: "Executive dashboard & alerts", stats: "Executive dashboard & alerts",
  documents: "Documents & artifacts", artifacts: "Documents & artifacts", upload: "Documents & artifacts",
  "chat-artifacts": "Documents & artifacts",
  "smart-fill": "Workspaces", workspace: "Workspaces",
  journal: "Journal & notes", notes: "Journal & notes", captures: "Journal & notes",
  details: "Record details",
  chat: "AI chat", ai: "AI chat", "ai-transform": "AI chat", memories: "AI chat", search: "AI chat",
  enrich: "AI chat",
  cron: "System (not a user workflow)", warmup: "System (not a user workflow)",
  version: "System (not a user workflow)", diagnostics: "System (not a user workflow)",
  "client-errors": "System (not a user workflow)", cleanup: "System (not a user workflow)",
  admin: "System (not a user workflow)",
};

/** A path whose first segment is one domain but whose workflow is another. */
const PATH_DOMAIN_OVERRIDES: Array<[RegExp, Domain]> = [
  [/^\/api\/profiles\/:[^/]+\/(valuation|lifecycle|rollup)/, "Assets & ownership"],
  [/^\/api\/finance\/webhook/, "System (not a user workflow)"],
];

export function domainOfRoute(routePath: string): Domain | null {
  for (const [re, d] of PATH_DOMAIN_OVERRIDES) if (re.test(routePath)) return d;
  const seg = routePath.split("/")[2] || "";
  return SEGMENT_DOMAIN[seg] ?? null;
}

/** Chat tool name → domain. First match wins; no match fails the guard. */
const TOOL_DOMAIN_RULES: Array<[RegExp, Domain]> = [
  [/dashboard|notification|explain_dashboard/, "Executive dashboard & alerts"],
  [/record_detail|records_by_detail/, "Record details"],
  [/journal|_note$|_notes$/, "Journal & notes"],
  [/memory|recall_actions|undo_last_action|^search$|^navigate$|^get_summary$|extract_actions|bulk_action|generate_(chart|report|table)|find_(duplicates|orphans)|repair_|get_related|get_entity_history|link_entities|refresh_ai_summary/, "AI chat"],
  [/medication|dose|tracker/, "Trackers & health"],
  [/habit/, "Habits"],
  [/goal/, "Goals"],
  [/task/, "Tasks"],
  [/event|calendar|date_rules/, "Calendar"],
  [/artifact|document/, "Documents & artifacts"],
  [/obligation/, "Bills & obligations"],
  [/liability|loan|undo_last_payment/, "Liabilities"],
  [/asset|ownership|revalue/, "Assets & ownership"],
  [/account|net_worth/, "Accounts & net worth"],
  [/expense|income|paycheck|budget|cashflow|spending|financial/, "Finance"],
  [/profile|relationship|domain/, "Profiles"],
];

export function domainOfTool(name: string): Domain | null {
  for (const [re, d] of TOOL_DOMAIN_RULES) if (re.test(name)) return d;
  return null;
}

const READ_TOOL = /^(get_|query_|search|read_|recall_|find_|generate_|explain_|validate_|retrieve_|open_|navigate$|preview_)/;
export const isReadTool = (name: string) => READ_TOOL.test(name);

// ── Reading the code ─────────────────────────────────────────────────────────

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export interface ApiRoute { method: Method; path: string; file: string }

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function walk(dir: string, keep: (rel: string) => boolean, out: string[] = []): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      walk(rel, keep, out);
    } else if (keep(rel)) out.push(rel);
  }
  return out;
}

const SERVER_ROUTE_FILES = () => walk("server", (f) => /\.ts$/.test(f) && !f.includes("/shims/"));

/** Every `app.<method>("/api/…"` the server registers (the path may sit on the
 *  next line), plus the workspace routes, which are registered from a constant. */
export function extractApiRoutes(): ApiRoute[] {
  const seen = new Map<string, ApiRoute>();
  const add = (method: string, p: string, file: string) => {
    const r: ApiRoute = { method: method.toUpperCase() as Method, path: p.replace(/\/$/, ""), file };
    seen.set(`${r.method} ${r.path}`, seen.get(`${r.method} ${r.path}`) ?? r);
  };
  for (const file of SERVER_ROUTE_FILES()) {
    const src = read(file);
    const re = /\b(?:app|router)\.(get|post|put|patch|delete)\(\s*["'`](\/api\/[^"'`]*)["'`]/g;
    for (let m; (m = re.exec(src)); ) add(m[1], m[2], file);
    const paths = /export const WORKSPACE_AI_PATHS = \[([\s\S]*?)\]/.exec(src);
    if (paths) for (const p of paths[1].match(/\/api\/[^"'`]+/g) ?? []) add("POST", p, file);
  }
  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

export interface Screen { path: string; component: string }

export function extractScreens(): Screen[] {
  const src = read("client/src/App.tsx");
  const out: Screen[] = [];
  const re = /<Route\s+path="([^"]+)"\s+component=\{(\w+)\}/g;
  for (let m; (m = re.exec(src)); ) out.push({ path: m[1], component: m[2] });
  return out;
}

// ── Finding references ───────────────────────────────────────────────────────

export interface PathRef { path: string; method: Method | null }

const API_REF = /\/api\/(?:\$\{[^}]*\}|[\w\-.:/])*/g;
const METHOD_WORD = /\b(GET|POST|PUT|PATCH|DELETE|DEL)\b/gi;
const asMethod = (w: string): Method => (w.toUpperCase() === "DEL" ? "DELETE" : (w.toUpperCase() as Method));
/** The live checks and the contract suite call the API through helpers whose
 *  base already ends in /api: `post("/autopay/run")`, `api("GET", "/tasks")`. */
const BARE_REF = /["'`](\/(?:\$\{[^}]*\}|[\w\-.:/])+)/g;

/** Every "/api/…" a file mentions, with the HTTP method named beside it (in
 *  the same call) when there is one. No method → it can only vouch for a GET. */
export function apiRefs(src: string, opts: { bare?: boolean } = {}): PathRef[] {
  const out: PathRef[] = [];
  if (opts.bare) {
    for (let m; (m = BARE_REF.exec(src)); ) {
      const p = m[1].replace(/[./]+$/, "");
      const first = p.split("/")[1] || "";
      if (first === "api" || !(first in SEGMENT_DOMAIN)) continue;
      const lineStart = src.lastIndexOf("\n", m.index) + 1;
      const b = src.slice(Math.max(lineStart, m.index - 60), m.index).match(METHOD_WORD);
      // Only beside a method: a bare "/tasks" on its own is a screen, not a call.
      if (b) out.push({ path: `/api${p}`, method: asMethod(b[b.length - 1]) });
    }
  }
  for (let m; (m = API_REF.exec(src)); ) {
    const p = m[0].replace(/[./]+$/, "");
    const before = src.slice(Math.max(0, m.index - 60), m.index);
    const lineStart = before.lastIndexOf("\n") + 1;
    const sameLineBefore = before.slice(lineStart);
    const after = src.slice(m.index + m[0].length, m.index + m[0].length + 120);
    let method: Method | null = null;
    const b = sameLineBefore.match(METHOD_WORD);
    if (b) method = asMethod(b[b.length - 1]);
    else {
      const a = /method:\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]/i.exec(after);
      if (a) method = a[1].toUpperCase() as Method;
    }
    out.push({ path: p, method });
  }
  return out;
}

const isDynamic = (seg: string) => seg.startsWith(":") || seg.includes("${");

/** The registered route a referenced path means: same number of segments,
 *  literals equal, the most literal route winning ("/tasks/trash" over
 *  "/tasks/:id"). A `${…}` in the reference only stands for a parameter. */
export function matchPattern<T extends { path: string }>(refPath: string, patterns: T[]): T | null {
  const segs = refPath.split("?")[0].split("/").filter(Boolean);
  let best: T | null = null;
  let bestScore = -1;
  for (const r of patterns) {
    const rs = r.path.split("/").filter(Boolean);
    if (rs.length !== segs.length) continue;
    let score = 0;
    let ok = true;
    for (let i = 0; i < rs.length; i++) {
      if (rs[i].startsWith(":")) continue;
      if (isDynamic(segs[i]) || rs[i] !== segs[i]) { ok = false; break; }
      score++;
    }
    if (ok && score > bestScore) { best = r; bestScore = score; }
  }
  return best;
}

// ── Test layers ──────────────────────────────────────────────────────────────

export type Layer = "local" | "contract" | "live" | "unlisted";

export interface TestFile {
  file: string;
  layer: Layer;
  src: string;
  /** Opens a real browser. */
  browser: boolean;
  /** … in a touch (phone) context. */
  touch: boolean;
}

function configIncludes(configFile: string): Set<string> {
  const src = read(configFile);
  return new Set((src.match(/tests\/[\w\-./]+\.test\.tsx?/g) ?? []));
}

export function loadTestFiles(): TestFile[] {
  const local = configIncludes("vitest.config.ts");
  // The local config also EXCLUDES a few it names; those do not run.
  const excluded = new Set(
    (/exclude:\s*\[([^\]]*)\]/.exec(read("vitest.config.ts"))?.[1].match(/tests\/[\w\-./]+\.test\.tsx?/g)) ?? [],
  );
  const liveConfigs = new Set([
    ...configIncludes("vitest.live.config.ts"),
    ...configIncludes("vitest.multiaction.config.ts"),
    ...configIncludes("vitest.e2e.config.ts"),
  ]);
  const files = [
    ...walk("tests", (f) => /\.tsx?$/.test(f) && !f.includes("/helpers/") && !f.includes("/fixture/")),
    ...walk("scripts", (f) => /(verify|post-deploy|full-tool-audit|combined-stress|mega-queries|test_)/.test(f) && /\.ts$/.test(f)),
  ];
  return files.map((file) => {
    const src = read(file);
    const posix = file.split(path.sep).join("/");
    let layer: Layer;
    if (posix.startsWith("tests/smoke/contracts/")) layer = "contract";
    else if (liveConfigs.has(posix)) layer = "live";
    else if (local.has(posix) && !excluded.has(posix)) layer = "local";
    else if (/\.test\.tsx?$/.test(posix)) layer = "unlisted";
    else layer = "live"; // a script run by hand: live checks, the acceptance rig, audits
    const browser = /from ["']playwright["']|require\(["']playwright["']\)|chromium\.launch/.test(src);
    const touch = browser && /hasTouch:\s*true|devices\[/.test(src);
    return { file: posix, layer, src, browser, touch };
  });
}

// ── The matrix ───────────────────────────────────────────────────────────────

export interface Coverage { local: string[]; contract: string[]; live: string[] }
const emptyCoverage = (): Coverage => ({ local: [], contract: [], live: [] });

export interface RouteRow extends ApiRoute {
  domain: Domain | null;
  write: boolean;
  /** Client files that call it — empty means no screen uses this route. */
  ui: string[];
  tests: Coverage;
}

export interface ToolRow {
  name: string;
  domain: Domain | null;
  write: boolean;
  tests: Coverage;
}

export interface ScreenRow extends Screen {
  /** Live browser checks that open this screen. */
  desktop: string[];
  touch: string[];
  /** jsdom tests that render the page component. */
  dom: string[];
}

export interface Inventory {
  routes: RouteRow[];
  tools: ToolRow[];
  screens: ScreenRow[];
  /** *.test.ts files no config runs. */
  unlisted: string[];
  testFileCount: number;
}

function push(list: string[], file: string) {
  if (!list.includes(file)) list.push(file);
}

export function buildInventory(toolNames: string[]): Inventory {
  const apiRoutes = extractApiRoutes();
  const tests = loadTestFiles();
  const byMethod = (m: Method) => apiRoutes.filter((r) => r.method === m);

  const rows = new Map<string, RouteRow>();
  for (const r of apiRoutes) {
    rows.set(`${r.method} ${r.path}`, {
      ...r, domain: domainOfRoute(r.path), write: r.method !== "GET", ui: [], tests: emptyCoverage(),
    });
  }
  const resolve = (ref: PathRef): RouteRow | null => {
    // A reference with no method beside it (a query key, a URL constant) can
    // only vouch for the read.
    const hit = matchPattern(ref.path, byMethod(ref.method ?? "GET"));
    return hit ? rows.get(`${hit.method} ${hit.path}`)! : null;
  };

  for (const t of tests) {
    if (t.layer === "unlisted") continue;
    for (const ref of apiRefs(t.src, { bare: t.layer !== "local" })) {
      const row = resolve(ref);
      if (row) push(row.tests[t.layer], t.file);
    }
  }
  for (const file of walk("client/src", (f) => /\.tsx?$/.test(f))) {
    for (const ref of apiRefs(read(file))) {
      const row = resolve(ref);
      if (row) push(row.ui, file.split(path.sep).join("/"));
    }
  }

  // A file that names most of the registry (a sweep, a generated list) says
  // nothing about any one tool, so it is not evidence for one.
  const toolRe = (name: string) => new RegExp(`["'\`#]${name}\\b(?!_)`);
  const sweeps = new Set(
    tests.filter((t) => toolNames.filter((n) => toolRe(n).test(t.src)).length > toolNames.length / 3).map((t) => t.file),
  );
  const tools: ToolRow[] = toolNames.map((name) => {
    const cov = emptyCoverage();
    const quoted = toolRe(name);
    for (const t of tests) {
      if (t.layer !== "unlisted" && !sweeps.has(t.file) && quoted.test(t.src)) push(cov[t.layer], t.file);
    }
    return { name, domain: domainOfTool(name), write: !isReadTool(name), tests: cov };
  });

  const screenList = extractScreens();
  const screens: ScreenRow[] = screenList.map((s) => ({ ...s, desktop: [], touch: [], dom: [] }));
  const HASH_REF = /#\/(?:\$\{[^}]*\}|[\w\-./:])*/g;
  for (const t of tests) {
    if (t.browser) {
      for (const m of t.src.match(HASH_REF) ?? []) {
        const hit = matchPattern(m.slice(1).replace(/[./]+$/, "") || "/", screenList);
        if (!hit) continue;
        const row = screens.find((s) => s.path === hit.path)!;
        push(t.touch ? row.touch : row.desktop, t.file);
      }
    } else if (t.layer === "local" && /\.dom\.test\.tsx$|\.test\.tsx$/.test(t.file)) {
      for (const row of screens) {
        const page = new RegExp(`\\b${row.component}\\b`);
        if (page.test(t.src)) push(row.dom, t.file);
      }
    }
  }

  return {
    routes: [...rows.values()],
    tools,
    screens,
    unlisted: tests.filter((t) => t.layer === "unlisted").map((t) => t.file).sort(),
    testFileCount: tests.length,
  };
}
