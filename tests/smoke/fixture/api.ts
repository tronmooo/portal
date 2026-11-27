/**
 * Shared HTTP + auth helper for the smoke suite.
 *
 * Why: every contract test needs the same pattern (sign in once, then make
 * authenticated requests). Centralising means one place to fix when auth
 * shape changes.
 */
import { SMOKE_EMAIL, SMOKE_PASSWORD, API_BASE, SB_URL, SB_ANON } from "./account";

let cachedToken: string | null = null;
let cachedAt = 0;
const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 min — supabase tokens last 1h

export async function getSmokeToken(force = false): Promise<string> {
  if (!force && cachedToken && Date.now() - cachedAt < TOKEN_TTL_MS) return cachedToken;
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(SB_URL, SB_ANON);
  const { data, error } = await sb.auth.signInWithPassword({
    email: SMOKE_EMAIL,
    password: SMOKE_PASSWORD,
  });
  if (error || !data.session) {
    throw new Error(`Smoke auth failed: ${error?.message || "no session"}`);
  }
  cachedToken = data.session.access_token;
  cachedAt = Date.now();
  return cachedToken;
}

export type ApiResponse<T = any> = {
  status: number;
  ok: boolean;
  data: T;
  headers: Headers;
  /** Duration of the final attempt (time waiting out a 429 is not counted). */
  ms: number;
};

// The server enforces a rolling 60-writes/min budget per user. Every gate
// that runs against production (the pre-push contract suite, Live E2E, other
// sessions' live sweeps) writes as the ONE smoke account, so their bursts add
// up and a run can be rejected with 429 mid-scenario. A 429 is a clean
// rejection (nothing was written), so waiting out the window and retrying is
// side-effect-free. Without it a gate goes red on contention, not on a product
// regression — Live E2E on 2026-11-09 failed 3 scenarios that passed on rerun.
// EVERY request a production gate makes goes through fetchWithRateLimitRetry.
// Guard: tests/live-gate-rate-limit.test.ts.
export const RATE_LIMIT_BACKOFFS_MS = [3_000, 8_000, 15_000, 25_000];

/** fetch(), retried after a 429 on the backoff schedule above. `ms` is the
 * duration of the FINAL attempt only, so latency checks never count the
 * time spent waiting out the rate-limit window. */
export async function fetchWithRateLimitRetry(
  url: string,
  init: RequestInit,
  backoffsMs: readonly number[] = RATE_LIMIT_BACKOFFS_MS,
): Promise<{ response: Response; ms: number; retries: number }> {
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    const response = await fetch(url, init);
    const ms = Date.now() - t0;
    if (response.status === 429 && attempt < backoffsMs.length) {
      await response.text().catch(() => undefined);
      await new Promise(res => setTimeout(res, backoffsMs[attempt]));
      continue;
    }
    return { response, ms, retries: attempt };
  }
}

// What the app's own client does (client/src/lib/queryClient.ts): it sends
// back the newest data version the server has told it, so a read made right
// after a write is never answered from another server instance's pre-write
// cache. Without it a gate was "another device" to itself and could read ~2 s
// behind its own write — checks failed on rows they had just created
// (2026-11-27: "the chat did not log the run" for a run it had logged).
// Only for the smoke account's own token: another account has other versions.
const seenVersions: Record<string, number> = {};
function noteVersions(raw: unknown): void {
  for (const part of String(raw ?? "").split(",")) {
    const [k, v] = part.split(":");
    const n = Number(v);
    if (k && Number.isFinite(n) && n > (seenVersions[k] ?? 0)) seenVersions[k] = n;
  }
}

export async function api<T = any>(
  method: string,
  path: string,
  body?: any,
  opts: { token?: string } = {},
): Promise<ApiResponse<T>> {
  const token = opts.token ?? (await getSmokeToken());
  const own = !opts.token;
  const seen = Object.entries(seenVersions).map(([k, v]) => `${k}:${v}`).join(",");
  const { response: r, ms } = await fetchWithRateLimitRetry(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(own && seen ? { "X-Data-Version": seen } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* leave as string */ }
  if (own) {
    noteVersions(r.headers?.get?.("x-data-version"));
    noteVersions(r.headers?.get?.("x-server-data-version"));
    if (parsed && typeof parsed === "object" && typeof parsed.dataVersion === "string") noteVersions(parsed.dataVersion);
  }
  return { status: r.status, ok: r.ok, data: parsed, headers: r.headers, ms };
}

/** Convenience: assert a request succeeded. */
export function expectOk<T>(r: ApiResponse<T>, msg = ""): T {
  if (!r.ok) {
    const detail = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
    throw new Error(`${msg || "API call failed"}: ${r.status} ${detail}`);
  }
  return r.data;
}
