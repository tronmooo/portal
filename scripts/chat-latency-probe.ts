// ── Chat latency probe ───────────────────────────────────────────────────────
// Posts representative messages to /api/chat and prints wall-clock latency,
// the route that served each reply (meta.route: fast-lane / frontdoor /
// agent), and the action count. Run before/after a perf change to compare.
//
// ⚠️ WRITE WARNING: several probes are logging commands — they create real
// rows for the authenticated user. Use a test account.
//
// Usage:
//   PROBE_BASE=http://localhost:5000 PROBE_TOKEN=<bearer> npx tsx scripts/chat-latency-probe.ts
//   PROBE_ONLY=reads  → skip the write probes.

const BASE = process.env.PROBE_BASE || "http://localhost:5000";
const TOKEN = process.env.PROBE_TOKEN || "";
const ONLY_READS = process.env.PROBE_ONLY === "reads";

interface Probe {
  label: string;
  message: string;
  writes: boolean;
}

const PROBES: Probe[] = [
  { label: "help (deterministic fast path)", message: "help", writes: false },
  { label: "simple tracker log (fast lane)", message: "drank a glass of water", writes: true },
  { label: "simple expense (fast lane)", message: "spent $3.50 on a probe-test coffee", writes: true },
  { label: "reminder (fast lane)", message: "remind me to run the latency probe tomorrow at 9am", writes: true },
  { label: "read query (agent loop)", message: "how much did I spend this week?", writes: false },
  { label: "conversational (agent/frontdoor)", message: "what's a good way to build a savings habit?", writes: false },
  { label: "multi-action (agent loop)", message: "I ate a probe-test sandwich and walked 1 mile and took my vitamins", writes: true },
];

async function runProbe(p: Probe): Promise<void> {
  const t0 = Date.now();
  try {
    const resp = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: JSON.stringify({ message: p.message, history: [], debug: true }),
    });
    const ms = Date.now() - t0;
    if (!resp.ok) {
      console.log(`✗ ${p.label}: HTTP ${resp.status} in ${ms}ms`);
      return;
    }
    const body: any = await resp.json();
    const route = body?.meta?.route || "agent";
    const model = body?.meta?.model || "";
    const actionCount = Array.isArray(body?.actions) ? body.actions.length : 0;
    console.log(
      `✓ ${p.label}: ${ms}ms  route=${route}${model ? ` model=${model}` : ""} actions=${actionCount}\n` +
      `    reply: ${String(body?.reply || "").slice(0, 100).replace(/\n/g, " ")}`,
    );
  } catch (err: any) {
    console.log(`✗ ${p.label}: ${err?.message || err} after ${Date.now() - t0}ms`);
  }
}

(async () => {
  console.log(`Chat latency probe → ${BASE} ${TOKEN ? "(authenticated)" : "(NO TOKEN — expect 401s on real deployments)"}`);
  for (const p of PROBES) {
    if (ONLY_READS && p.writes) {
      console.log(`− ${p.label}: skipped (PROBE_ONLY=reads)`);
      continue;
    }
    // Sequential on purpose: parallel probes would contend for the same
    // serverless instance and skew timings.
    await runProbe(p);
  }
})();
