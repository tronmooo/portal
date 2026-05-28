/**
 * Cache & instant-UI contracts.
 *
 * The rule: a mutation through POST/PATCH/DELETE must be reflected on the
 * next GET, even if the GET goes through the server's cache layer. This
 * suite is the last line of defence against the "I added a row but I have
 * to refresh to see it" class of bug.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { api, expectOk } from "../fixture/api";
import { ensureSeeded } from "../fixture/setup";
import type { SeedResult } from "../fixture/seed";

let fixture: SeedResult;

beforeAll(async () => {
  fixture = await ensureSeeded();
}, 120_000);

describe("contract: cache invalidation", () => {
  it("CACHE-01: creating an expense increments the list length on the immediately-following GET", async () => {
    const before = expectOk(await api<any[]>("GET", "/expenses")) as any[];
    const created = expectOk(await api("POST", "/expenses", {
      description: `Cache Probe ${Date.now()}`,
      amount: 1,
      category: "other",
      date: "2026-05-21",
      linkedProfiles: [fixture.selfId],
    }));
    try {
      const after = expectOk(await api<any[]>("GET", "/expenses")) as any[];
      expect(after.length, "list length didn't grow after create").toBe(before.length + 1);
      expect(after.find(e => e.id === (created as any).id), "new row not in list").toBeTruthy();
    } finally {
      await api("DELETE", `/expenses/${(created as any).id}`);
    }
  });

  it("CACHE-02: deleting an expense decrements list length on the immediately-following GET", async () => {
    const probe = expectOk(await api("POST", "/expenses", {
      description: `Cache Probe Del ${Date.now()}`,
      amount: 1,
      category: "other",
      date: "2026-05-21",
      linkedProfiles: [fixture.selfId],
    }));
    const before = expectOk(await api<any[]>("GET", "/expenses")) as any[];
    await api("DELETE", `/expenses/${(probe as any).id}`);
    const after = expectOk(await api<any[]>("GET", "/expenses")) as any[];
    expect(after.length).toBe(before.length - 1);
    expect(after.find(e => e.id === (probe as any).id), "deleted row still present").toBeUndefined();
  });

  it("CACHE-03: PATCH amount is reflected on next GET", async () => {
    const probe = expectOk(await api("POST", "/expenses", {
      description: `Cache Probe Patch ${Date.now()}`,
      amount: 10,
      category: "other",
      date: "2026-05-21",
      linkedProfiles: [fixture.selfId],
    }));
    try {
      await api("PATCH", `/expenses/${(probe as any).id}`, { amount: 999 });
      const after = expectOk(await api<any>("GET", `/expenses/${(probe as any).id}`));
      expect(Number((after as any).amount)).toBe(999);
    } finally {
      await api("DELETE", `/expenses/${(probe as any).id}`);
    }
  });

  it("CACHE-04: creating a tracker shows up in the global trackers list", async () => {
    const probe = expectOk(await api("POST", "/trackers", {
      name: `Cache Tracker ${Date.now()}`,
      category: "health",
      unit: "x",
      fields: [{ name: "value", type: "number" }],
      linkedProfiles: [fixture.selfId],
    }));
    try {
      const after = expectOk(await api<any[]>("GET", "/trackers")) as any[];
      expect(after.find(t => t.id === (probe as any).id), "new tracker not in list").toBeTruthy();
    } finally {
      await api("DELETE", `/trackers/${(probe as any).id}`);
    }
  });
});
