// The entity matrix: for each kind of thing chat can write, the tool call that
// writes it and the page that must show it on the FIRST render afterwards.
//
// Tool inputs match the real schemas in server/ai-engine.ts — the mock model
// only chooses WHICH tool runs; the tool itself is production code.
export interface Case {
  name: string;
  /** Builds the chat message. `n` is a unique needle string for this run. */
  turn: (n: string) => string;
  /** Route to navigate to immediately after the turn. */
  route: string;
  /** Selector proving the DESTINATION view has rendered (not the previous one). */
  marker: string;
  /** How to confirm the row reached the database. */
  dbCheck: (storage: any, n: string) => Promise<boolean>;
  /** For deletes: the needle must be ABSENT rather than present. */
  expectAbsent?: boolean;
  /** Extra surfaces that must show the same write on first render. */
  alsoOn?: Array<{ route: string; marker: string }>;
}

const has = (rows: any[], n: string, fields: string[]) =>
  rows.some((r) => fields.some((f) => String(r?.[f] ?? "").includes(n)));

export const CASES: Case[] = [
  {
    name: "task",
    turn: (n) => `##create_task {"title":"${n}"}`,
    route: "/tasks",
    marker: '[data-testid="page-tasks"]',
    dbCheck: async (s, n) => has(await s.getTasks(), n, ["title"]),
    alsoOn: [{ route: "/dashboard", marker: '[data-testid="page-dashboard"]' }],
  },
  {
    name: "habit",
    turn: (n) => `##create_habit {"name":"${n}","frequency":"daily"}`,
    route: "/dashboard",
    marker: '[data-testid="page-dashboard"]',
    dbCheck: async (s, n) => has(await s.getHabits(), n, ["name"]),
  },
  {
    name: "expense",
    turn: (n) => `##create_expense {"description":"${n}","amount":42,"category":"Food"}`,
    route: "/dashboard",
    marker: '[data-testid="page-dashboard"]',
    dbCheck: async (s, n) => has(await s.getExpenses(), n, ["description"]),
  },
  {
    name: "income",
    turn: (n) => `##log_income {"source":"${n}","amount":900,"category":"salary"}`,
    route: "/dashboard/finance",
    marker: '[data-testid="page-finance"]',
    dbCheck: async (s, n) => has(await s.getIncomes(), n, ["description", "source"]),
  },
  {
    name: "calendar event",
    turn: (n) => `##create_event {"title":"${n}","date":"${new Date().toISOString().slice(0, 10)}"}`,
    route: "/calendar",
    marker: '[data-testid="calendar-page"]',
    dbCheck: async (s, n) => has(await s.getEvents(), n, ["title"]),
  },
  {
    name: "asset",
    turn: (n) => `##create_profile {"type":"asset","name":"${n}"}`,
    route: "/linked?tab=assets",
    marker: '[data-testid="button-create-asset"]',
    dbCheck: async (s, n) => has(await s.getProfiles(), n, ["name"]),
  },
  {
    name: "liability",
    turn: (n) => `##create_liability {"name":"${n}","amount":5000,"liabilityType":"loan"}`,
    route: "/liabilities",
    marker: '[data-testid="button-create-liability"]',
    dbCheck: async (s, n) => has(await s.getProfiles(), n, ["name"]),
  },
  {
    name: "subscription",
    turn: (n) => `##create_profile {"type":"subscription","name":"${n}"}`,
    route: "/liabilities",
    marker: '[data-testid="button-create-liability"]',
    dbCheck: async (s, n) => has(await s.getProfiles(), n, ["name"]),
  },
  {
    name: "tracker",
    turn: (n) => `##create_tracker {"name":"${n}","category":"health","fields":[{"name":"reading","type":"number"},{"name":"notes","type":"text"}]}`,
    route: "/trackers",
    marker: '[data-testid="page-trackers"]',
    dbCheck: async (s, n) => has(await s.getTrackers(), n, ["name"]),
  },
  {
    name: "multi-action turn",
    turn: (n) => `##create_task {"title":"${n}"} ##create_expense {"description":"${n}","amount":7,"category":"Food"}`,
    route: "/tasks",
    marker: '[data-testid="page-tasks"]',
    dbCheck: async (s, n) =>
      has(await s.getTasks(), n, ["title"]) && has(await s.getExpenses(), n, ["description"]),
    alsoOn: [{ route: "/dashboard", marker: '[data-testid="page-dashboard"]' }],
  },
];
