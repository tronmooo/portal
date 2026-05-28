/**
 * Deterministic fixture seeder for the smoke account.
 *
 * Strategy:
 *   1. Wipe everything the smoke user owns (profiles, expenses, etc.).
 *   2. Re-create a small but representative dataset whose IDs and shapes the
 *      contract tests can rely on.
 *
 * Keep this dataset SMALL and STABLE. Every entity here is referenced by at
 * least one assertion in tests/smoke/contracts/. Adding to this file means
 * adding/extending assertions in lockstep.
 *
 * Run via:
 *   npx tsx tests/smoke/fixture/seed.ts            # full reset + seed
 *   npx tsx tests/smoke/fixture/seed.ts --reset    # wipe only
 *   npx tsx tests/smoke/fixture/seed.ts --verify   # report current shape
 */
import { api, expectOk } from "./api";

// ─── Canonical fixture spec ────────────────────────────────────────────────
// If you change a value here, you MUST update the matching assertion in
// tests/smoke/contracts/*. The test suite reads these constants directly.

export const FIXTURE = {
  selfName: "Smoke Self",
  people: ["Smoke Spouse", "Smoke Child"],
  asset: {
    name: "Smoke House",
    type: "property",
    fields: { currentValue: 500000, address: "123 Test Lane" },
  },
  vehicle: {
    name: "Smoke Car",
    type: "vehicle",
    fields: { currentValue: 25000, year: 2024, make: "Test", model: "Sedan" },
  },
  liability: {
    name: "Smoke Mortgage",
    type: "loan",
    fields: { currentBalance: 350000, interestRate: 6.5, monthlyPayment: 2200 },
  },
  expenses: [
    // Categories must match server allow-list (see invariants.test.ts ALLOWED_EXPENSE_CATEGORIES)
    { description: "Smoke Groceries", amount: 120, category: "food",      date: "2026-05-01" },
    { description: "Smoke Gas",       amount:  50, category: "transport", date: "2026-05-10" },
    { description: "Smoke Coffee",    amount:  15, category: "food",      date: "2026-05-15" },
  ],
  obligation: {
    name: "Smoke Internet Bill",
    amount: 75,
    frequency: "monthly",
    nextDueDate: "2026-06-15",
    category: "utilities",
  },
  tracker: {
    name: "Smoke Weight",
    category: "health",
    unit: "lbs",
    entries: [
      { date: "2026-05-01", value: 180 },
      { date: "2026-05-15", value: 178 },
    ],
  },
  task: {
    title: "Smoke Task: file tax docs",
    priority: "medium",
    status: "todo",
  },
  event: {
    title: "Smoke Event: dentist",
    date: "2026-06-20",
    time: "10:00",
  },
};

// ─── Wipe ──────────────────────────────────────────────────────────────────

async function wipeAll(): Promise<void> {
  // The order matters: delete leaf entities before profiles so cascade rules
  // never delete something we'd want to count.
  const entityEndpoints = [
    "/expenses", "/obligations", "/events", "/tasks", "/trackers",
    "/documents", "/habits", "/journal", "/artifacts", "/goals", "/incomes",
  ];
  for (const path of entityEndpoints) {
    const r = await api<any[]>("GET", path);
    const items: any[] = Array.isArray(r.data) ? r.data : (r.data?.items || []);
    for (const item of items) {
      if (!item.id) continue;
      await api("DELETE", `${path}/${item.id}`);
    }
  }
  // Profiles last. Self profile cannot be deleted in some setups — skip it
  // and let it be reused.
  const profRes = await api<any[]>("GET", "/profiles");
  const profiles: any[] = Array.isArray(profRes.data) ? profRes.data : [];
  // Delete children first (leaves of the tree), then roots.
  const sorted = [...profiles].sort((a, b) => {
    const aDepth = a.parentProfileId ? 1 : 0;
    const bDepth = b.parentProfileId ? 1 : 0;
    return bDepth - aDepth;
  });
  for (const p of sorted) {
    if (p.type === "self") continue; // keep the user's own self profile
    await api("DELETE", `/profiles/${p.id}`);
  }
}

// ─── Seed ──────────────────────────────────────────────────────────────────

async function ensureSelfProfile(): Promise<string> {
  const r = expectOk(await api<any[]>("GET", "/profiles"), "list profiles");
  const self = r.find((p: any) => p.type === "self");
  if (self) {
    // Make sure the name is canonical.
    if (self.name !== FIXTURE.selfName) {
      await api("PATCH", `/profiles/${self.id}`, { name: FIXTURE.selfName });
    }
    return self.id;
  }
  const created = expectOk(
    await api("POST", "/profiles", { name: FIXTURE.selfName, type: "self" }),
    "create self",
  );
  return (created as any).id;
}

async function createProfile(name: string, type: string, fields: any = {}): Promise<string> {
  const r = expectOk(await api("POST", "/profiles", { name, type, fields }), `create ${type} ${name}`);
  return (r as any).id;
}

async function linkProfileTo(profileId: string, entityType: string, entityId: string): Promise<void> {
  await api("POST", `/profiles/${profileId}/link`, { entityType, entityId });
}

export type SeedResult = {
  selfId: string;
  peopleIds: string[];
  assetId: string;
  vehicleId: string;
  liabilityId: string;
  expenseIds: string[];
  obligationId: string;
  trackerId: string;
  taskId: string;
  eventId: string;
};

export async function seed(): Promise<SeedResult> {
  const selfId = await ensureSelfProfile();

  const peopleIds = [];
  for (const name of FIXTURE.people) {
    peopleIds.push(await createProfile(name, "person", { _parentProfileId: selfId }));
  }

  const assetId = await createProfile(FIXTURE.asset.name, FIXTURE.asset.type, {
    ...FIXTURE.asset.fields,
    _parentProfileId: selfId,
  });
  const vehicleId = await createProfile(FIXTURE.vehicle.name, FIXTURE.vehicle.type, {
    ...FIXTURE.vehicle.fields,
    _parentProfileId: selfId,
  });
  const liabilityId = await createProfile(FIXTURE.liability.name, FIXTURE.liability.type, {
    ...FIXTURE.liability.fields,
    _parentProfileId: selfId,
  });

  // Expenses linked to self
  const expenseIds: string[] = [];
  for (const e of FIXTURE.expenses) {
    const r = expectOk(
      await api("POST", "/expenses", { ...e, linkedProfiles: [selfId] }),
      `create expense ${e.description}`,
    );
    expenseIds.push((r as any).id);
  }

  // Obligation linked to self + liability (so liability detail page can show it)
  const obRes = expectOk(
    await api("POST", "/obligations", { ...FIXTURE.obligation, linkedProfiles: [selfId, liabilityId] }),
    "create obligation",
  );
  const obligationId = (obRes as any).id;

  // Tracker
  const trRes = expectOk(
    await api("POST", "/trackers", {
      name: FIXTURE.tracker.name,
      category: FIXTURE.tracker.category,
      unit: FIXTURE.tracker.unit,
      fields: [{ name: "value", type: "number" }],
      linkedProfiles: [selfId],
    }),
    "create tracker",
  );
  const trackerId = (trRes as any).id;
  for (const entry of FIXTURE.tracker.entries) {
    await api("POST", `/trackers/${trackerId}/entries`, {
      values: { value: entry.value },
      timestamp: `${entry.date}T12:00:00Z`,
    });
  }

  // Task
  const tkRes = expectOk(
    await api("POST", "/tasks", { ...FIXTURE.task, linkedProfiles: [selfId] }),
    "create task",
  );
  const taskId = (tkRes as any).id;

  // Event
  const evRes = expectOk(
    await api("POST", "/events", { ...FIXTURE.event, linkedProfiles: [selfId] }),
    "create event",
  );
  const eventId = (evRes as any).id;

  return {
    selfId,
    peopleIds,
    assetId,
    vehicleId,
    liabilityId,
    expenseIds,
    obligationId,
    trackerId,
    taskId,
    eventId,
  };
}

// ─── CLI ───────────────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv[2];
  if (arg === "--reset") {
    process.stdout.write("[smoke-seed] wiping smoke account... ");
    await wipeAll();
    console.log("done.");
    return;
  }
  if (arg === "--verify") {
    const prof = expectOk(await api<any[]>("GET", "/profiles"));
    const exp = expectOk(await api<any[]>("GET", "/expenses"));
    console.log(`[smoke-seed] verify — profiles: ${prof.length}, expenses: ${Array.isArray(exp) ? exp.length : 0}`);
    return;
  }
  // Default: reset + seed.
  process.stdout.write("[smoke-seed] wiping... ");
  await wipeAll();
  console.log("done.");
  process.stdout.write("[smoke-seed] seeding... ");
  const result = await seed();
  console.log("done.");
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error("[smoke-seed] FAILED:", err);
    process.exit(1);
  });
}
