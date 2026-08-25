// Boot the real Express app against the test double and drive a write end to
// end: does a mutation actually come back with a manifest header, and does the
// client's decoder read it?
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startHarness, type Harness } from "./helpers/route-harness";
import { decodeWriteManifest, WRITE_MANIFEST_HEADER } from "@shared/write-manifest";

const LIAB_ID = "11111111-2222-4333-8444-555555555555";

describe("end-to-end: a write returns a usable manifest", () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness(); });
  afterEach(async () => { await h.close(); });

  it("ships a manifest header a client can decode", async () => {
    const r = await h.api("POST", "/api/tasks", { title: "Smoke test task" });
    expect(r.status).toBeLessThan(300);
    const raw = r.headers?.[WRITE_MANIFEST_HEADER] ?? r.headers?.["X-Write-Manifest"];
    expect(raw, "no manifest header on the response").toBeTruthy();
    const manifest = decodeWriteManifest(String(raw));
    expect(manifest).not.toBeNull();
    expect(manifest!.domains).toContain("tasks");
    expect(manifest!.changes.some((c) => c.endpoint === "/api/tasks" && c.op === "create")).toBe(true);
  });

  it("ships the per-domain version token", async () => {
    const r = await h.api("POST", "/api/tasks", { title: "Another" });
    const token = r.headers?.["x-data-version"] ?? r.headers?.["X-Data-Version"];
    expect(String(token)).toMatch(/^[a-z]+:\d+(,[a-z]+:\d+)*$/);
  });

  it("bumps only the written domain, leaving unrelated caches addressable", async () => {
    await h.api("POST", "/api/tasks", { title: "Scoped" });
    expect(h.db.lastBumpedDomains).toEqual(["tasks"]);
  });

  it("reports BOTH the payment and the balance it moved — the reference case", async () => {
    // The whole reason this machinery exists. POST .../payments writes the
    // payment row AND the liability profile whose balance it paid down. The
    // response only ever carried the payment, so the card, the profile totals
    // and net worth had nothing to update from and waited for a refetch.
    h.db.profiles.push({
      id: LIAB_ID, name: "Car loan", type: "liability", type_key: "auto_loan",
      fields: { currentBalance: 10000, annualInterestRate: 6, monthlyPayment: 400 },
      linkedProfiles: [],
    });

    const r = await h.api("POST", `/api/liabilities/${LIAB_ID}/payments`, {
      amount: 400, paymentDate: "2026-08-25",
    });
    expect(r.status).toBeLessThan(300);

    const manifest = decodeWriteManifest(String(r.headers?.[WRITE_MANIFEST_HEADER]));
    expect(manifest, "a payment shipped no manifest").not.toBeNull();

    // The payment itself, addressed to the list the liability page reads.
    const payment = manifest!.changes.find((c) => c.endpoint === `/api/liabilities/${LIAB_ID}/payments`);
    expect(payment?.op).toBe("create");

    // …and the liability row, carrying the balance the client renders.
    const profile = manifest!.changes.find((c) => c.endpoint === "/api/profiles" && c.id === LIAB_ID);
    expect(profile?.op).toBe("update");
    expect((profile?.row as any)?.fields?.currentBalance).toBeCloseTo(9650, 2);
    // All three names the app reads a balance by — writing only currentBalance
    // is what left the dashboard showing the pre-payment number.
    expect((profile?.row as any)?.fields?.remainingBalance).toBeCloseTo(9650, 2);
    expect((profile?.row as any)?.fields?.loanBalance).toBeCloseTo(9650, 2);

    // Every domain that renders either of them.
    for (const d of ["liabilities", "profiles", "assets", "obligations", "expenses"]) {
      expect(manifest!.domains, d).toContain(d);
    }
  });

  it("a GET still answers normally after all of this", async () => {
    await h.api("POST", "/api/tasks", { title: "Then read" });
    const g = await h.api("GET", "/api/tasks");
    expect(g.status).toBe(200);
    expect(Array.isArray(g.data)).toBe(true);
    expect(g.data.some((t: any) => t.title === "Then read")).toBe(true);
  });
});
