// The production gates (Live E2E's scenario suite and the pre-push contract
// suite) all write as ONE smoke account, which the server limits to 60 writes
// a minute. On 2026-11-09 Live E2E went red on 3 scenarios that passed on a
// rerun: a 429 from that shared budget, not a regression. CLAUDE.md says a red
// Live E2E run is a real regression, so the gates must never go red on
// contention. Every request they make goes through fetchWithRateLimitRetry.
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fetchWithRateLimitRetry } from "./smoke/fixture/api";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const GATE_FILES = [
  "tests/live-scenarios.test.ts",
  ...readdirSync(join(ROOT, "tests/smoke/contracts")).filter((f) => f.endsWith(".ts")).map((f) => `tests/smoke/contracts/${f}`),
];

afterEach(() => { vi.unstubAllGlobals(); });

const respond = (status: number) => new Response(JSON.stringify({ status }), { status });

describe("fetchWithRateLimitRetry", () => {
  it("waits out a 429 and returns the retried response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(respond(429))
      .mockResolvedValueOnce(respond(429))
      .mockResolvedValueOnce(respond(200));
    vi.stubGlobal("fetch", fetchMock);
    const { response, retries } = await fetchWithRateLimitRetry("https://x.test/api/profiles", { method: "POST" }, [1, 1, 1]);
    expect(response.status).toBe(200);
    expect(retries).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("times only the final attempt, so a latency check never counts the wait", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(respond(429)).mockResolvedValueOnce(respond(200)));
    const t0 = Date.now();
    const { ms } = await fetchWithRateLimitRetry("https://x.test/api/profiles", { method: "POST" }, [200]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
    expect(ms).toBeLessThan(150);
  });

  it("gives up after the schedule and returns the 429, so a real outage still fails", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => respond(429));
    vi.stubGlobal("fetch", fetchMock);
    const { response, retries } = await fetchWithRateLimitRetry("https://x.test/api/profiles", { method: "POST" }, [1, 1]);
    expect(response.status).toBe(429);
    expect(retries).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never retries other failures", async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(500));
    vi.stubGlobal("fetch", fetchMock);
    const { response } = await fetchWithRateLimitRetry("https://x.test/api/profiles", { method: "DELETE" }, [1, 1]);
    expect(response.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("production gates go through the retrying fetch", () => {
  it("lists the gate files it checks", () => {
    expect(GATE_FILES).toContain("tests/live-scenarios.test.ts");
    expect(GATE_FILES.length).toBeGreaterThan(5);
  });

  it.each(GATE_FILES)("%s makes no bare fetch() call", (file) => {
    const bare = read(file).split("\n").map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /(^|[^\w.])fetch\(/.test(line) && !/^\s*(\/\/|\*)/.test(line));
    expect(bare.map(({ n, line }) => `${file}:${n}: ${line.trim()}`)).toEqual([]);
  });

  it("Live E2E's api() helper uses fetchWithRateLimitRetry", () => {
    expect(read("tests/live-scenarios.test.ts")).toMatch(/await fetchWithRateLimitRetry\(`\$\{BASE\}\$\{path\}`/);
  });
});

// ── One gate at a time on the shared account ────────────────────────────────
// The contract suite wipes the smoke account when it starts. Two gate runs that
// overlapped deleted each other's records (2026-11-10: 9–11 contract failures,
// 404s and wrong list counts, on a healthy production). gate-lock.ts makes them
// take turns.
import { acquireGateLock, type GateLockIo } from "./smoke/fixture/gate-lock";

function memoryIo(): GateLockIo & { value: string | null; writes: number } {
  const store = { value: null as string | null, writes: 0 };
  return Object.assign(store, {
    async read() { await new Promise((r) => setTimeout(r, 1)); return store.value; },
    async write(v: string) { await new Promise((r) => setTimeout(r, 1)); store.value = v; store.writes++; },
  });
}
const fast = { settleMs: 15, pollMs: 5, heartbeatMs: 60_000, log: () => undefined };

describe("gate lock", () => {
  it("never lets two runs hold the account at once", async () => {
    const io = memoryIo();
    let inside = 0;
    let maxInside = 0;
    const run = async (gate: string) => {
      const release = await acquireGateLock(io, { gate, ...fast });
      inside++; maxInside = Math.max(maxInside, inside);
      await new Promise((r) => setTimeout(r, 30));
      inside--;
      await release();
    };
    await Promise.all([run("contracts"), run("live-e2e"), run("contracts"), run("live-e2e")]);
    expect(maxInside).toBe(1);
    expect(io.value).toBe(""); // released
  });

  it("waits for a live holder, then takes the lock when it is released", async () => {
    const io = memoryIo();
    const first = await acquireGateLock(io, { gate: "contracts", ...fast });
    let secondHeld = false;
    const second = acquireGateLock(io, { gate: "live-e2e", ...fast }).then((rel) => { secondHeld = true; return rel; });
    await new Promise((r) => setTimeout(r, 60));
    expect(secondHeld).toBe(false);
    await first();
    const release = await second;
    expect(secondHeld).toBe(true);
    expect(JSON.parse(io.value!).gate).toBe("live-e2e");
    await release();
  });

  it("takes over a lock whose holder crashed (expired)", async () => {
    const io = memoryIo();
    io.value = JSON.stringify({ holder: "contracts@dead:1:x", gate: "contracts", expiresAt: Date.now() - 1 });
    const release = await acquireGateLock(io, { gate: "live-e2e", ...fast });
    expect(JSON.parse(io.value!).holder).toMatch(/^live-e2e@/);
    await release();
  });

  it("gives up after maxWaitMs and names the run holding the account", async () => {
    const io = memoryIo();
    io.value = JSON.stringify({ holder: "contracts@ci:42:abcd", gate: "contracts", expiresAt: Date.now() + 60_000 });
    await expect(acquireGateLock(io, { gate: "live-e2e", ...fast, maxWaitMs: 30 }))
      .rejects.toThrow(/contracts@ci:42:abcd/);
  });

  it("release never clears a lock another run has taken", async () => {
    const io = memoryIo();
    const release = await acquireGateLock(io, { gate: "contracts", ...fast });
    const other = JSON.stringify({ holder: "live-e2e@x:1:y", gate: "live-e2e", expiresAt: Date.now() + 60_000 });
    io.value = other;
    await release();
    expect(io.value).toBe(other);
  });
});

describe("every production gate takes the lock", () => {
  it("the contract suite holds it for the whole run and reseeds fresh", () => {
    expect(read("vitest.smoke.config.ts")).toMatch(/globalSetup:\s*\[\s*"tests\/smoke\/fixture\/global-setup\.ts"\s*\]/);
    const setup = read("tests/smoke/fixture/global-setup.ts");
    expect(setup).toMatch(/acquireGateLock\(/);
    expect(setup).toMatch(/rmSync\(LOCK_FILE/);
  });

  it("Live E2E holds it before its first write", () => {
    const src = read("tests/live-scenarios.test.ts");
    const lock = src.indexOf("releaseGateLock = await acquireGateLock(");
    const firstWrite = src.indexOf('api("POST", "/profiles"');
    expect(lock).toBeGreaterThan(0);
    expect(firstWrite).toBeGreaterThan(lock);
    expect(src).toMatch(/await releaseGateLock\?\.\(\)/);
  });
});
