/**
 * Isolation contracts — user A must never see user B's data.
 *
 * We sign in as a second account (the QA account `testfix2026@aol.com`) and
 * confirm that none of the smoke fixture's entity IDs leak through any GET
 * endpoint.
 *
 * This is the test that would have caught past cross-account regressions
 * where /api/* used the wrong claim and returned cached data from a previous
 * session.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { api } from "../fixture/api";
import { ensureSeeded } from "../fixture/setup";
import type { SeedResult } from "../fixture/seed";
import { SB_URL, SB_ANON } from "../fixture/account";

const OTHER_EMAIL = "testfix2026@aol.com";
const OTHER_PASSWORD = "Testtest1!";

async function getOtherToken(): Promise<string> {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(SB_URL, SB_ANON);
  const { data, error } = await sb.auth.signInWithPassword({
    email: OTHER_EMAIL,
    password: OTHER_PASSWORD,
  });
  if (error || !data.session) throw new Error(`Other auth failed: ${error?.message}`);
  return data.session.access_token;
}

let fixture: SeedResult;
let otherToken: string;

beforeAll(async () => {
  fixture = await ensureSeeded();
  otherToken = await getOtherToken();
}, 120_000);

describe("contract: cross-account isolation", () => {
  const endpoints = ["/profiles", "/expenses", "/obligations", "/tasks", "/events", "/trackers"];

  for (const ep of endpoints) {
    it(`ISO-${ep}: other user cannot see smoke fixture rows via GET ${ep}`, async () => {
      const r = await api<any[]>("GET", ep, undefined, { token: otherToken });
      const items: any[] = Array.isArray(r.data) ? r.data : (r.data?.items || []);
      const smokeIds = new Set<string>([
        fixture.selfId,
        ...fixture.peopleIds,
        fixture.assetId,
        fixture.vehicleId,
        fixture.liabilityId,
        ...fixture.expenseIds,
        fixture.obligationId,
        fixture.trackerId,
        fixture.taskId,
        fixture.eventId,
      ]);
      const leaks = items.filter(i => smokeIds.has(i.id));
      expect(leaks, `${ep} leaked ids: ${leaks.map(l => l.id).join(",")}`).toHaveLength(0);
    });
  }

  it("ISO-write: other user cannot PATCH a smoke fixture entity", async () => {
    const r = await api("PATCH", `/expenses/${fixture.expenseIds[0]}`, { amount: 99999 }, { token: otherToken });
    expect(r.status, "patch should be forbidden (403/404)").toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  it("ISO-delete: smoke fixture entity survives a DELETE attempt by another user", async () => {
    // The server's delete is idempotent and may return 200 to a non-owner; what
    // matters is that the row remains visible (and identical) to the true owner.
    await api("DELETE", `/expenses/${fixture.expenseIds[1]}`, undefined, { token: otherToken });
    const check = await api<any>("GET", `/expenses/${fixture.expenseIds[1]}`);
    expect(check.ok, `smoke expense ${fixture.expenseIds[1]} did not survive cross-account delete (status ${check.status})`).toBe(true);
    expect((check.data as any).id).toBe(fixture.expenseIds[1]);
  });
});
