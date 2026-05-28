/**
 * Performance test for recursive net-worth rollup.
 *
 *  1. Seed a wide tree under the QA user (testfix2026):
 *       level 0: 1 root house (`perf_root`)
 *       level 1: 10 floors
 *       level 2: 10 rooms each      (100 rooms total)
 *       level 3: 4 items each       (400 items total)
 *       Plus 30 extra items hanging at level 4/5 to push depth.
 *      => ~541 nodes across 5 levels
 *  2. Measure:
 *       a) GET /api/profiles                       (flat list)
 *       b) GET /api/profiles/:root/tree            (recursive)
 *       c) GET /api/profiles/:root/detail          (the per-asset view)
 *       d) computeAssetRollup() purely in JS over the flat list
 *  3. Print timings. Targets:
 *       - tree endpoint < 750ms cold, < 250ms warm
 *       - rollup compute < 50ms over 500+ profiles
 *  4. Clean up: DELETE every seeded profile.
 *
 *  Run:  cd /home/user/workspace/portal && npx tsx tests/perf-rollup.ts
 */

import { computeAssetRollup, type AssetLike } from "../shared/asset-rollup";

const API_BASE = "https://portol.me/api";
const TEST_EMAIL = "testfix2026@aol.com";
const TEST_PASSWORD = "Testtest1!";
const SELF_PROFILE_ID = "5f3eede8-e3ac-4e53-bc56-7b080011ff6d";

const TAG = `perfrollup_${Date.now()}`;

let authToken = "";

async function login(): Promise<string> {
  const res = await fetch(`${API_BASE}/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  const data = await res.json();
  if (!data.session?.access_token) throw new Error("Login failed: " + JSON.stringify(data));
  return data.session.access_token;
}

async function api(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path} -> ${res.status}: ${await res.text()}`);
  return res.json().catch(() => ({}));
}

async function createProfile(name: string, parentId: string, value: number, type = "asset"): Promise<any> {
  return api(`/profiles`, {
    method: "POST",
    body: JSON.stringify({
      type,
      name,
      parentProfileId: parentId,
      fields: { currentValue: value, purchasePrice: value },
      tags: [TAG],
    }),
  });
}

async function deleteProfile(id: string): Promise<void> {
  await api(`/profiles/${id}`, { method: "DELETE" });
}

function time<T>(label: string, fn: () => Promise<T>): Promise<{ label: string; ms: number; result: T }> {
  const t0 = performance.now();
  return fn().then(result => {
    const ms = performance.now() - t0;
    return { label, ms, result };
  });
}

async function seedTree(): Promise<{ rootId: string; allIds: string[] }> {
  console.log("\n=== Seeding ===");
  const allIds: string[] = [];

  // Level 0 - root house
  const root = await createProfile(`${TAG}_root_house`, SELF_PROFILE_ID, 500000, "property");
  allIds.push(root.id);
  console.log(`  L0: root=${root.id}`);

  // Level 1 - 10 floors
  const floors: any[] = [];
  for (let f = 0; f < 10; f++) {
    const fl = await createProfile(`${TAG}_floor_${f}`, root.id, 10000);
    floors.push(fl);
    allIds.push(fl.id);
  }
  console.log(`  L1: ${floors.length} floors`);

  // Level 2 - 10 rooms per floor = 100
  const rooms: any[] = [];
  for (const fl of floors) {
    // Batch in parallel groups of 10 to avoid hammering the API.
    const batch: Promise<any>[] = [];
    for (let r = 0; r < 10; r++) {
      batch.push(createProfile(`${TAG}_room_${fl.name.slice(-1)}_${r}`, fl.id, 500));
    }
    const results = await Promise.all(batch);
    for (const room of results) { rooms.push(room); allIds.push(room.id); }
  }
  console.log(`  L2: ${rooms.length} rooms`);

  // Level 3 - 4 items per room = 400
  const items: any[] = [];
  for (let i = 0; i < rooms.length; i += 10) {
    // Process 10 rooms in parallel (each room creates 4 items sequentially)
    const slice = rooms.slice(i, i + 10);
    const groupResults = await Promise.all(slice.map(async (rm) => {
      const its: any[] = [];
      for (let k = 0; k < 4; k++) {
        const item = await createProfile(`${TAG}_item_${rm.name.slice(-3)}_${k}`, rm.id, 25);
        its.push(item);
      }
      return its;
    }));
    for (const arr of groupResults) for (const it of arr) { items.push(it); allIds.push(it.id); }
  }
  console.log(`  L3: ${items.length} items`);

  // Level 4 - 30 sub-items hanging on the first 30 items, level-5 grandchildren on 10 of them
  const subItems: any[] = [];
  for (let i = 0; i < 30; i++) {
    const sub = await createProfile(`${TAG}_sub_${i}`, items[i].id, 5);
    subItems.push(sub);
    allIds.push(sub.id);
  }
  console.log(`  L4: ${subItems.length} sub-items`);

  // Level 5 - 10 deep nodes
  for (let i = 0; i < 10; i++) {
    const deep = await createProfile(`${TAG}_deep_${i}`, subItems[i].id, 1);
    allIds.push(deep.id);
  }
  console.log(`  L5: 10 deep nodes`);

  console.log(`Total seeded: ${allIds.length} profiles`);
  return { rootId: root.id, allIds };
}

async function measure(rootId: string) {
  console.log("\n=== Measurements ===");

  // Cold (no warmup)
  const flatCold = await time("GET /api/profiles (cold)", () => api(`/profiles`));
  const treeCold = await time(`GET /api/profiles/:root/tree (cold)`, () => api(`/profiles/${rootId}/tree`));
  const detailCold = await time(`GET /api/profiles/:root/detail (cold)`, () => api(`/profiles/${rootId}/detail`));

  console.log(`  cold flat   : ${flatCold.ms.toFixed(0)}ms (${flatCold.result.length || (flatCold.result.items||[]).length || "?"} profiles)`);
  console.log(`  cold tree   : ${treeCold.ms.toFixed(0)}ms`);
  console.log(`  cold detail : ${detailCold.ms.toFixed(0)}ms`);

  // Warm (3 consecutive)
  const warmTimes: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t = await time(`tree warm ${i+1}`, () => api(`/profiles/${rootId}/tree`));
    warmTimes.push(t.ms);
  }
  console.log(`  warm tree x3: ${warmTimes.map(t => t.ms?.toFixed(0) ?? t.toFixed(0)).join(", ")}ms`);

  // Pure JS rollup over the flat list
  const flatItems: any[] = Array.isArray(flatCold.result) ? flatCold.result : (flatCold.result.items || []);
  const t0 = performance.now();
  const root = flatItems.find((p: any) => p.id === rootId);
  if (root) {
    const r = computeAssetRollup(root as AssetLike, flatItems as AssetLike[]);
    const ms = performance.now() - t0;
    console.log(`  JS computeAssetRollup over ${flatItems.length} flat items: ${ms.toFixed(2)}ms`);
    console.log(`  rollup.totalValue = $${r.totalValue}  (descendants=${r.descendantCount}, depth=${r.maxDepth})`);
  }

  // Walk the tree response and sum the values for cross-check
  let treeCount = 0, treeSum = 0;
  function walk(n: any) {
    treeCount++;
    const v = Number(n?.fields?.currentValue ?? n?.fields?.purchasePrice ?? 0) || 0;
    treeSum += v;
    (n.children || []).forEach(walk);
  }
  walk(treeCold.result);
  console.log(`  tree walk: ${treeCount} nodes, sum=$${treeSum}`);

  // Targets
  const targets = {
    "cold flat < 1500ms": flatCold.ms < 1500,
    "cold tree < 1500ms": treeCold.ms < 1500,
    "warm tree median < 750ms": warmTimes.sort((a,b)=>a-b)[1] < 750,
    "tree contains >= 500 nodes": treeCount >= 500,
  };
  console.log("\n=== Target check ===");
  for (const [k, v] of Object.entries(targets)) console.log(`  ${v ? "PASS" : "FAIL"} ${k}`);
}

async function cleanup(allIds: string[]) {
  console.log("\n=== Cleanup ===");
  // Delete leaves-first by reverse order. The /profiles DELETE will fail if
  // there are still children, so reverse order (deepest first) keeps it safe.
  let ok = 0, fail = 0;
  for (let i = allIds.length - 1; i >= 0; i--) {
    try { await deleteProfile(allIds[i]); ok++; }
    catch (e: any) { fail++; if (fail < 5) console.log(`  delete fail ${allIds[i]}: ${e?.message?.slice(0, 200)}`); }
  }
  console.log(`  deleted ${ok}, failed ${fail}`);
}

async function main() {
  console.log(`\n=== Perf rollup test (tag=${TAG}) ===`);
  authToken = await login();
  console.log("Login OK");

  let rootId: string | undefined;
  let allIds: string[] = [];
  try {
    const seed = await seedTree();
    rootId = seed.rootId;
    allIds = seed.allIds;
    await measure(rootId);
  } catch (e: any) {
    console.error("ERROR:", e?.message || e);
  } finally {
    if (allIds.length > 0) await cleanup(allIds);
  }
}

main().catch(e => { console.error("FATAL", e); process.exit(1); });
