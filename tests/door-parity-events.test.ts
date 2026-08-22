// ─── Door parity: calendar events ───────────────────────────────────────────
//
// The REST POST /api/events was a bare schema→create with no duplicate guard
// and no category folding, while the chat tool carried both. The canonical
// event service (server/actions/event-service.ts) now owns the pipeline;
// these tests pin the parity and the structural idempotency.
import { describe, it, expect } from "vitest";
import { executeTool } from "../server/ai-engine";
import { createEventRecord, canonicalEventCategory } from "../server/actions/event-service";
import { MemStorage, driveDoor, withStorage, normalizeRow, normalizeManifest, ledgerRows } from "./door-parity/harness";

let seq = 0;
const nextUser = () => `door-parity-ev-${++seq}`;

const BASE = { title: "Soccer practice", date: "2026-09-03", time: "07:00", category: "personal" };

describe("door parity — event create", () => {
  it("chat and REST produce the same row, manifest, and ledger contract", async () => {
    const rows: any[] = [];
    for (const door of ["chat", "rest"] as const) {
      const store = new MemStorage();
      const outcome = await driveDoor(store, door, "create_event", BASE, () => {
        if (door === "chat") return executeTool("create_event", { ...BASE }, nextUser());
        return createEventRecord(store, { ...BASE, source: "manual" });
      });
      expect(outcome.ok, `${door}: ok`).toBe(true);
      expect(outcome.envelope?.verification?.database_record_exists, `${door}: verified`).toBe(true);
      const stored = await withStorage(store, () => store.getEvents());
      expect(stored, `${door}: one row`).toHaveLength(1);
      rows.push(normalizeRow(stored[0]));
      expect(normalizeManifest(outcome.mutations), `${door}: manifest`).toEqual([
        { op: "create", entityType: "event", endpoint: "/api/events", domains: ["events"] },
      ]);
      expect((await ledgerRows(store))[0], `${door}: ledger`).toEqual({
        tool: "create_event", source: door, entityType: "event", reversible: true,
      });
    }
    expect(rows[0]).toEqual(rows[1]);
  });

  it("same title + same date is the same event, for every door", async () => {
    const store = new MemStorage();
    const first = await createEventRecord(store, { ...BASE, source: "manual" });
    expect(first.error).toBeUndefined();
    // The replayed confirm / chatty model / double-submit all collapse.
    const replay = await createEventRecord(store, { ...BASE, source: "extraction" });
    expect(replay.deduped).toBe(true);
    expect(replay.id).toBe(first.id);
    expect(await store.getEvents()).toHaveLength(1);
  });

  it("category folding is shared: aliases map, junk buckets to other", () => {
    expect(canonicalEventCategory("medical")).toBe("health");
    expect(canonicalEventCategory("appointment")).toBe("other");
    expect(canonicalEventCategory(undefined)).toBe("personal");
    expect(canonicalEventCategory("work")).toBe("work");
  });

  it("weekday-set recurrence pulls the start date into the set", async () => {
    const store = new MemStorage();
    // 2026-09-06 is a Sunday; a Mon/Wed/Fri series must start on the Monday.
    const created = await createEventRecord(store, {
      title: "Gym", date: "2026-09-06", recurrence: "weekly:1,3,5", source: "manual",
    });
    expect(created.error).toBeUndefined();
    expect(created.date).toBe("2026-09-07");
    expect(String(created.recurrence)).toMatch(/^weekly:/);
  });

  it("attributes by name through the canonical resolver, never guessing on ambiguity", async () => {
    const store = new MemStorage();
    const roy = await store.createProfile({ name: "Roy Smith", type: "person" } as any);
    await store.createProfile({ name: "Royale", type: "person" } as any);
    const created = await createEventRecord(store, {
      title: "Dinner", date: "2026-09-10", forProfile: "Roy", source: "manual",
    });
    expect(created.error).toBeUndefined();
    expect(created.linkedProfiles).toEqual([roy.id]);

    const ambiguous = await createEventRecord(store, {
      title: "Lunch", date: "2026-09-11", forProfile: "Zebulon", source: "manual",
    });
    expect(ambiguous.error).toBeUndefined();
    expect(ambiguous.linkedProfiles).toEqual([]);
  });
});
