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
};

// The server enforces a rolling 60-writes/min budget per user. The suite's
// write bursts (CRUD/guardrail files) can momentarily exceed it, and a 429 is
// a clean rejection (nothing was written), so waiting out the window and
// retrying is side-effect-free. Without this, gate runs failed
// nondeterministically on the suite's own rate limiter — different files each
// run — which is contention, not a product regression.
const RATE_LIMIT_BACKOFFS_MS = [3_000, 8_000, 15_000, 25_000];

export async function api<T = any>(
  method: string,
  path: string,
  body?: any,
  opts: { token?: string } = {},
): Promise<ApiResponse<T>> {
  const token = opts.token ?? (await getSmokeToken());
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* leave as string */ }
    if (r.status === 429 && attempt < RATE_LIMIT_BACKOFFS_MS.length) {
      await new Promise(res => setTimeout(res, RATE_LIMIT_BACKOFFS_MS[attempt]));
      continue;
    }
    return { status: r.status, ok: r.ok, data: parsed, headers: r.headers };
  }
}

/** Convenience: assert a request succeeded. */
export function expectOk<T>(r: ApiResponse<T>, msg = ""): T {
  if (!r.ok) {
    const detail = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
    throw new Error(`${msg || "API call failed"}: ${r.status} ${detail}`);
  }
  return r.data;
}
