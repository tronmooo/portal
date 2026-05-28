/**
 * Performance benchmark for recursive net-worth rollup, using direct
 * Supabase seeding for speed (vs the API route which is ~50ms/insert).
 *
 * Tree shape: ~541 profiles across 5 levels, scoped to the QA user.
 *
 * This script ONLY measures and cleans up; the seeding is done by the
 * agent (Claude) via execute_sql calls before invoking this script.
 *
 * Pass the root profile id and the JSON path holding all seeded ids:
 *   ROOT_ID=<uuid> SEED_FILE=/tmp/perf_ids.json npx tsx tests/perf-rollup-sql.ts
 *
 * Cleanup happens via direct DB delete to avoid 541 API round-trips.
 */

import { computeAssetRollup, type AssetLike } from "../shared/asset-rollup";
import fs from "node:fs";

const API_BASE = "https://portol.me/api";
const TEST_EMAIL = "testfix2026@aol.com";
const TEST_PASSWORD = "Testtest1!";

const ROOT_ID = process.env.ROOT_ID;
if (!ROOT_ID) throw new Error("ROOT_ID env var required");

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
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}`, ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path} -> ${res.status}: ${await res.text()}`);
  return res.json().catch(() => ({}));
}

function time<T>(fn: () => Promise<T>): Promise<{ ms: number; result: T }> {
  const t0 = performance.now();
  return fn().then(result => ({ ms: performance.now() - t0, result }));
}

async function main() {
  authToken = await login();
  console.log("Login OK");

  // Cold flat list
  const flatCold = await time(() => api(`/profiles?limit=2000`));
  const flatItems: any[] = Array.isArray(flatCold.result) ? flatCold.result : (flatCold.result.items || []);
  console.log(`cold GET /api/profiles : ${flatCold.ms.toFixed(0)}ms  (${flatItems.length} profiles total in account)`);

  // Cold tree
  const treeCold = await time(() => api(`/profiles/${ROOT_ID}/tree`));
  console.log(`cold GET tree           : ${treeCold.ms.toFixed(0)}ms`);

  // Cold detail
  const detailCold = await time(() => api(`/profiles/${ROOT_ID}/detail`));
  console.log(`cold GET detail         : ${detailCold.ms.toFixed(0)}ms`);

  // Warm tree x5
  const warm: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t = await time(() => api(`/profiles/${ROOT_ID}/tree`));
    warm.push(t.ms);
  }
  console.log(`warm tree x5            : ${warm.map(x => x.toFixed(0)).join(", ")}ms  median=${warm.sort((a,b)=>a-b)[2].toFixed(0)}ms`);

  // JS rollup
  const root = flatItems.find((p: any) => p.id === ROOT_ID);
  if (!root) { console.log("Root not in flat list!"); return; }
  const t0 = performance.now();
  const r = computeAssetRollup(root as AssetLike, flatItems as AssetLike[]);
  const rollupMs = performance.now() - t0;
  console.log(`JS computeAssetRollup   : ${rollupMs.toFixed(2)}ms`);
  console.log(`  totalValue=$${r.totalValue}  descendants=${r.descendantCount}  maxDepth=${r.maxDepth}`);

  // Walk tree for cross-check
  let count = 0, sum = 0;
  function walk(n: any) { count++; sum += Number(n?.fields?.currentValue ?? n?.fields?.purchasePrice ?? 0) || 0; (n.children || []).forEach(walk); }
  walk(treeCold.result);
  console.log(`tree walk               : ${count} nodes, sum=$${sum}`);

  console.log("\n=== Targets ===");
  const targets = [
    ["cold flat < 1500ms", flatCold.ms < 1500],
    ["cold tree < 1500ms", treeCold.ms < 1500],
    ["warm tree median < 750ms", warm.sort((a,b)=>a-b)[2] < 750],
    ["tree node count >= 500", count >= 500],
    ["JS rollup < 50ms", rollupMs < 50],
    ["rollup.descendantCount > 500", r.descendantCount > 500],
    ["rollup maxDepth >= 4", r.maxDepth >= 4],
  ];
  for (const [k, v] of targets) console.log(`  ${v ? "PASS" : "FAIL"} ${k}`);
}

main().catch(e => { console.error("FATAL", e); process.exit(1); });
