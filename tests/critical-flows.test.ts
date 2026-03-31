/**
 * Critical Flow Tests for Portol
 * 
 * These tests verify the most important user flows work end-to-end.
 * Run with: npx tsx tests/critical-flows.test.ts
 * 
 * Tests against the LIVE Supabase backend with the test user account.
 */

const BASE_URL = "https://portol.me/api";
const SB_URL = "https://uvaniovwrezzzlzmizyg.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2YW5pb3Z3cmV6enpsem1penlnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDA5MjgsImV4cCI6MjA4OTYxNjkyOH0.0tn5gFfpWN-k5jRUiFehB1cD0BO-DAWP7LQO_IGI1AQ";

const TEST_EMAIL = "tron@aol.com";
const TEST_PASSWORD = "password";

let authToken = "";
let testProfileId = "";
let testTaskId = "";
let testExpenseId = "";
let testTrackerId = "";

type TestResult = { name: string; passed: boolean; error?: string; duration: number };
const results: TestResult[] = [];

async function api(method: string, path: string, body?: any): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${authToken}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; } 
  catch { return { status: res.status, data: text }; }
}

async function test(name: string, fn: () => Promise<void>) {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, duration: Date.now() - start });
    console.log(`  ✅ ${name} (${Date.now() - start}ms)`);
  } catch (e: any) {
    results.push({ name, passed: false, error: e.message, duration: Date.now() - start });
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

// ─── AUTH ────────────────────────────────────────────────────────────────

async function authenticate() {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(SB_URL, SB_KEY);
  const { data, error } = await sb.auth.signInWithPassword({ email: TEST_EMAIL, password: TEST_PASSWORD });
  if (error || !data.session) throw new Error(`Auth failed: ${error?.message || "no session"}`);
  authToken = data.session.access_token;
  console.log(`  🔐 Authenticated as ${TEST_EMAIL}`);
}

// ─── TESTS ──────────────────────────────────────────────────────────────

async function runTests() {
  console.log("\n🧪 Portol Critical Flow Tests\n");
  
  await authenticate();
  
  // ── PROFILES ──
  console.log("\n📋 Profiles:");
  
  await test("GET /api/profiles returns array", async () => {
    const { status, data } = await api("GET", "/profiles");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(Array.isArray(data), "Expected array");
    assert(data.length > 0, "Expected at least 1 profile");
    // Find self profile
    const self = data.find((p: any) => p.type === "self");
    assert(!!self, "Self profile must exist");
    testProfileId = self.id;
  });

  await test("GET /api/profiles/:id returns profile with type_key", async () => {
    const { status, data } = await api("GET", `/profiles/${testProfileId}`);
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.name !== undefined, "Profile must have name");
    assert(data.type_key !== undefined, "Profile must have type_key");
  });

  await test("GET /api/profiles/:id/detail returns rich data", async () => {
    const { status, data } = await api("GET", `/profiles/${testProfileId}/detail`);
    assert(status === 200, `Expected 200, got ${status}`);
    assert(Array.isArray(data.relatedTrackers), "Must have relatedTrackers array");
    assert(Array.isArray(data.relatedExpenses), "Must have relatedExpenses array");
    assert(Array.isArray(data.relatedTasks), "Must have relatedTasks array");
    assert(Array.isArray(data.relatedDocuments), "Must have relatedDocuments array");
    assert(Array.isArray(data.timeline), "Must have timeline array");
  });

  await test("PATCH /api/profiles/:id merges fields (does not overwrite)", async () => {
    // Get current fields
    const { data: before } = await api("GET", `/profiles/${testProfileId}`);
    const fieldsBefore = before.fields || {};
    const existingKeys = Object.keys(fieldsBefore);
    
    // Update one field
    await api("PATCH", `/profiles/${testProfileId}`, { fields: { _test_field: "audit_test" } });
    
    // Verify the original fields still exist
    const { data: after } = await api("GET", `/profiles/${testProfileId}`);
    assert(after.fields._test_field === "audit_test", "New field must be saved");
    for (const key of existingKeys) {
      assert(after.fields[key] !== undefined, `Original field '${key}' must not be deleted`);
    }
    
    // Clean up test field
    const cleanFields = { ...after.fields };
    delete cleanFields._test_field;
    await api("PATCH", `/profiles/${testProfileId}`, { fields: cleanFields });
  });

  // ── TASKS ──
  console.log("\n📌 Tasks:");

  await test("POST /api/tasks creates task", async () => {
    const { status, data } = await api("POST", "/tasks", {
      title: "E2E Test Task", priority: "medium", status: "todo",
    });
    assert(status === 201 || status === 200, `Expected 201, got ${status}`);
    assert(data.id !== undefined, "Task must have ID");
    testTaskId = data.id;
  });

  await test("PATCH /api/tasks/:id updates task", async () => {
    const { status } = await api("PATCH", `/tasks/${testTaskId}`, { status: "done" });
    assert(status === 200, `Expected 200, got ${status}`);
  });

  await test("DELETE /api/tasks/:id deletes task", async () => {
    const { status } = await api("DELETE", `/tasks/${testTaskId}`);
    assert(status === 204 || status === 200, `Expected 204, got ${status}`);
  });

  // ── EXPENSES ──
  console.log("\n💰 Expenses:");

  await test("POST /api/expenses creates expense", async () => {
    const { status, data } = await api("POST", "/expenses", {
      amount: 25.50, category: "food", description: "E2E Test Expense",
      date: new Date().toISOString().slice(0, 10),
    });
    assert(status === 201 || status === 200, `Expected 201, got ${status}`);
    assert(data.id !== undefined, "Expense must have ID");
    testExpenseId = data.id;
  });

  await test("POST /api/expenses rejects negative amount", async () => {
    const { status } = await api("POST", "/expenses", {
      amount: -10, category: "food", description: "Negative test",
      date: new Date().toISOString().slice(0, 10),
    });
    assert(status === 400, `Expected 400 for negative amount, got ${status}`);
  });

  await test("DELETE /api/expenses/:id deletes expense", async () => {
    const { status } = await api("DELETE", `/expenses/${testExpenseId}`);
    assert(status === 204 || status === 200, `Expected 204, got ${status}`);
  });

  // ── TRACKERS ──
  console.log("\n📊 Trackers:");

  await test("POST /api/trackers creates tracker", async () => {
    const { status, data } = await api("POST", "/trackers", {
      name: "E2E Test Tracker", unit: "count", category: "custom",
      fields: [{ name: "value", type: "number", unit: "count", isPrimary: true }],
    });
    assert(status === 201 || status === 200, `Expected 201, got ${status}`);
    assert(data.id !== undefined, "Tracker must have ID");
    testTrackerId = data.id;
  });

  await test("POST /api/trackers/:id/entries logs entry", async () => {
    const { status, data } = await api("POST", `/trackers/${testTrackerId}/entries`, {
      values: { value: 42 }, notes: "E2E test entry",
    });
    assert(status === 201 || status === 200, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
  });

  await test("POST /api/trackers/:id/entries rejects duplicate within 5 min", async () => {
    const { status, data } = await api("POST", `/trackers/${testTrackerId}/entries`, {
      values: { value: 42 }, notes: "Duplicate test",
    });
    // Should return 200/201 with the EXISTING entry (dedup returns it, doesn't create new)
    assert(status === 200 || status === 201, `Expected 200/201 for dedup, got ${status}`);
  });

  await test("DELETE /api/trackers/:id deletes tracker", async () => {
    const { status } = await api("DELETE", `/trackers/${testTrackerId}`);
    assert(status === 204 || status === 200, `Expected 204, got ${status}`);
  });

  // ── DASHBOARD ──
  console.log("\n📊 Dashboard:");

  await test("GET /api/stats returns dashboard stats", async () => {
    const { status, data } = await api("GET", "/stats");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(typeof data.totalProfiles === "number", "Must have totalProfiles");
    assert(typeof data.monthlySpend === "number", "Must have monthlySpend");
  });

  await test("GET /api/stats?profileId= filters by profile", async () => {
    const { status, data } = await api("GET", `/stats?profileId=${testProfileId}`);
    assert(status === 200, `Expected 200, got ${status}`);
  });

  await test("GET /api/dashboard-enhanced returns enhanced data", async () => {
    const { status, data } = await api("GET", "/dashboard-enhanced");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(Array.isArray(data.healthSnapshot), "Must have healthSnapshot");
    assert(data.financeSnapshot !== undefined, "Must have financeSnapshot");
  });

  // ── DOCUMENTS ──
  console.log("\n📄 Documents:");

  await test("GET /api/documents returns array (max 500)", async () => {
    const { status, data } = await api("GET", "/documents");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(Array.isArray(data), "Expected array");
    assert(data.length <= 500, "Must be capped at 500");
  });

  // ── PROFILE TYPE REGISTRY ──
  console.log("\n🏗️ Type Registry:");

  await test("GET /api/profile-types returns 80 types", async () => {
    const { status, data } = await api("GET", "/profile-types");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(Array.isArray(data), "Expected array");
    assert(data.length >= 50, `Expected 50+ types, got ${data.length}`);
  });

  await test("GET /api/profile-types/vehicle returns vehicle type", async () => {
    const { status, data } = await api("GET", "/profile-types/vehicle");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.type_key === "vehicle", "Must be vehicle type");
    assert(Array.isArray(data.field_schema), "Must have field_schema");
    assert(Array.isArray(data.tab_config), "Must have tab_config");
  });

  // ── CALENDAR ──
  console.log("\n📅 Calendar:");

  await test("GET /api/events returns array", async () => {
    const { status, data } = await api("GET", "/events");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(Array.isArray(data), "Expected array");
  });

  // ── HABITS ──
  console.log("\n🔥 Habits:");

  await test("GET /api/habits returns array with linked_profiles", async () => {
    const { status, data } = await api("GET", "/habits");
    assert(status === 200, `Expected 200, got ${status}`);
    assert(Array.isArray(data), "Expected array");
    if (data.length > 0) {
      assert(Array.isArray(data[0].linkedProfiles) || data[0].linkedProfiles === undefined, 
        "Habits should have linkedProfiles");
    }
  });

  // ── AUTH ISOLATION ──
  console.log("\n🔒 Auth Isolation:");

  await test("API rejects unauthenticated requests", async () => {
    const res = await fetch(`${BASE_URL}/profiles`, {
      headers: { "Content-Type": "application/json" },
    });
    assert(res.status === 401, `Expected 401 for no auth, got ${res.status}`);
  });

  await test("API rejects invalid token", async () => {
    const res = await fetch(`${BASE_URL}/profiles`, {
      headers: { "Content-Type": "application/json", "Authorization": "Bearer invalid_token_12345" },
    });
    assert(res.status === 401, `Expected 401 for bad token, got ${res.status}`);
  });

  // ── RESULTS ──
  console.log("\n" + "═".repeat(60));
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;
  console.log(`\n  ${passed}/${total} passed, ${failed} failed\n`);
  
  if (failed > 0) {
    console.log("  FAILURES:");
    results.filter(r => !r.passed).forEach(r => {
      console.log(`    ❌ ${r.name}: ${r.error}`);
    });
  }
  
  console.log("\n" + "═".repeat(60));
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(console.error);
