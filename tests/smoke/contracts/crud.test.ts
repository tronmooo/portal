/**
 * CRUD contracts — every entity must round-trip cleanly through
 * create → read → update → delete. This catches schema drift quickly.
 *
 * Tests use one-off entities (suffixed with a timestamp) so they never
 * collide with the canonical fixture data.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { api, expectOk } from "../fixture/api";
import { ensureSeeded } from "../fixture/setup";
import type { SeedResult } from "../fixture/seed";

let fixture: SeedResult;

beforeAll(async () => {
  fixture = await ensureSeeded();
}, 120_000);

async function roundTrip(opts: {
  label: string;
  endpoint: string;
  create: any;
  update: any;
  readField: string;
  expectedUpdated: any;
}) {
  const created = expectOk(await api("POST", opts.endpoint, opts.create), `create ${opts.label}`);
  const id = (created as any).id;
  expect(id, `${opts.label} create returned no id`).toBeTruthy();

  const fetched = expectOk(await api("GET", `${opts.endpoint}/${id}`), `read ${opts.label}`);
  expect((fetched as any)[opts.readField]).toBe((opts.create as any)[opts.readField]);

  const updated = expectOk(await api("PATCH", `${opts.endpoint}/${id}`, opts.update), `update ${opts.label}`);
  for (const [k, v] of Object.entries(opts.expectedUpdated)) {
    expect((updated as any)[k]).toEqual(v);
  }

  const del = await api("DELETE", `${opts.endpoint}/${id}`);
  expect(del.ok, `${opts.label} delete failed: ${del.status}`).toBe(true);

  const after = await api("GET", `${opts.endpoint}/${id}`);
  expect(after.status, `${opts.label} still readable after delete`).toBe(404);
}

describe("contract: CRUD", () => {
  it("CRUD-01: expenses", async () => {
    const stamp = Date.now();
    await roundTrip({
      label: "expense",
      endpoint: "/expenses",
      create: { description: `Probe ${stamp}`, amount: 12.34, category: "food", date: "2026-05-20", linkedProfiles: [fixture.selfId] },
      update: { amount: 56.78 },
      readField: "description",
      expectedUpdated: { amount: 56.78 },
    });
  });

  it("CRUD-02: obligations", async () => {
    const stamp = Date.now();
    await roundTrip({
      label: "obligation",
      endpoint: "/obligations",
      create: { name: `Probe Bill ${stamp}`, amount: 30, frequency: "monthly", nextDueDate: "2026-07-01", category: "utilities", linkedProfiles: [fixture.selfId] },
      update: { amount: 45 },
      readField: "name",
      expectedUpdated: { amount: 45 },
    });
  });

  it("CRUD-03: tasks", async () => {
    const stamp = Date.now();
    await roundTrip({
      label: "task",
      endpoint: "/tasks",
      create: { title: `Probe Task ${stamp}`, priority: "low", status: "todo", linkedProfiles: [fixture.selfId] },
      update: { status: "done" },
      readField: "title",
      expectedUpdated: { status: "done" },
    });
  });

  it("CRUD-04: events", async () => {
    const stamp = Date.now();
    await roundTrip({
      label: "event",
      endpoint: "/events",
      create: { title: `Probe Event ${stamp}`, date: "2026-08-01", time: "09:00", linkedProfiles: [fixture.selfId] },
      update: { time: "11:00" },
      readField: "title",
      expectedUpdated: { time: "11:00" },
    });
  });

  it("CRUD-05: trackers (with entries)", async () => {
    const stamp = Date.now();
    const created = expectOk(await api("POST", "/trackers", {
      name: `Probe Tracker ${stamp}`,
      category: "health",
      unit: "x",
      fields: [{ name: "value", type: "number" }],
      linkedProfiles: [fixture.selfId],
    }), "create tracker");
    const trackerId = (created as any).id;

    const entry = expectOk(await api("POST", `/trackers/${trackerId}/entries`, {
      values: { value: 7 },
      timestamp: "2026-05-20T12:00:00Z",
    }), "add entry");
    expect((entry as any).id, "entry must have id").toBeTruthy();

    const renamed = expectOk(await api("PATCH", `/trackers/${trackerId}`, { name: `Probe Tracker ${stamp} v2` }), "rename");
    expect((renamed as any).name).toContain("v2");

    const del = await api("DELETE", `/trackers/${trackerId}`);
    expect(del.ok).toBe(true);
  });

  it("CRUD-06: profiles (person)", async () => {
    const stamp = Date.now();
    await roundTrip({
      label: "person profile",
      endpoint: "/profiles",
      create: { name: `Probe Person ${stamp}`, type: "person", fields: { _parentProfileId: fixture.selfId } },
      update: { name: `Probe Person ${stamp} renamed` },
      readField: "type",
      expectedUpdated: { name: `Probe Person ${stamp} renamed` },
    });
  });
});
