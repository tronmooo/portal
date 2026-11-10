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
