// A journal entry belongs to ONE person. This file pins the rule that broke on
// 2026-08-20: "Journal this for Sarah: we went hiking today" was appended into
// the entry that day already had — John Hancock's — and the card badged the
// result JOHN HANCOCK. The lookup keyed on the DATE alone, so Sarah's day
// landed inside John's journal.
//
// upsertJournalEntry is the single door both chat and REST write through
// (server/content-service), so scoping it by owner covers every path.

import { describe, it, expect, beforeEach } from "vitest";
import { upsertJournalEntry } from "../server/content-service";

const SELF = "profile-self";
const SARAH = "profile-sarah";
const JOHN = "profile-john";

function fakeStorage() {
  const rows: any[] = [];
  const links: Array<{ profileId: string; type: string; id: string }> = [];
  let seq = 0;
  return {
    rows,
    links,
    async getProfiles() {
      return [
        { id: SELF, name: "Me", type: "self" },
        { id: SARAH, name: "Sarah Miller", type: "person" },
        { id: JOHN, name: "John Hancock", type: "person" },
      ];
    },
    async getJournalEntries() {
      return rows.map((r) => ({ ...r }));
    },
    async createJournalEntry(data: any) {
      // Mirrors supabase-storage: an entry with no owner is stamped self.
      const linkedProfiles = data.linkedProfiles?.length ? [...data.linkedProfiles] : [SELF];
      const row = {
        id: `journal-${++seq}`,
        date: data.date,
        mood: data.mood,
        content: data.content || "",
        tags: data.tags || [],
        linkedProfiles,
      };
      rows.push(row);
      return { ...row };
    },
    async updateJournalEntry(id: string, patch: any) {
      const row = rows.find((r) => r.id === id);
      if (!row) return undefined;
      Object.assign(row, patch);
      return { ...row };
    },
    async linkProfileTo(profileId: string, type: string, id: string) {
      links.push({ profileId, type, id });
    },
  } as any;
}

const DAY = "2026-08-20";
let storage: ReturnType<typeof fakeStorage>;
beforeEach(() => { storage = fakeStorage(); });

describe("the reported bug — one person's entry never lands in another's", () => {
  it("Sarah's entry is a NEW row when John already has one that day", async () => {
    await upsertJournalEntry(storage, {
      content: "John had a rough morning.", entryDate: DAY, profileId: JOHN,
    });
    const { entry, appended } = await upsertJournalEntry(storage, {
      content: "We went hiking today and she was in a really good mood.",
      mood: "great", entryDate: DAY, profileId: SARAH,
    });

    expect(appended).toBe(false);
    expect(storage.rows).toHaveLength(2);
    expect(entry.linkedProfiles).toEqual([SARAH]);
    expect(entry.content).toBe("We went hiking today and she was in a really good mood.");
    // John's row is untouched — his journal never sees Sarah's day.
    const john = storage.rows.find((r: any) => r.linkedProfiles.includes(JOHN));
    expect(john.content).toBe("John had a rough morning.");
    expect(john.linkedProfiles).toEqual([JOHN]);
  });

  it("the user's own entry never absorbs a person's entry, in either order", async () => {
    await upsertJournalEntry(storage, { content: "My own day.", entryDate: DAY });
    const forSarah = await upsertJournalEntry(storage, { content: "Sarah's day.", entryDate: DAY, profileId: SARAH });
    expect(forSarah.appended).toBe(false);
    expect(forSarah.entry.linkedProfiles).toEqual([SARAH]);

    const mine = await upsertJournalEntry(storage, { content: "More of my day.", entryDate: DAY });
    expect(mine.appended).toBe(true);
    expect(mine.entry.linkedProfiles).toEqual([SELF]);
    expect(mine.entry.content).toBe("My own day.\n\nMore of my day.");
    expect(storage.rows).toHaveLength(2);
  });

  it("three people on one day are three rows", async () => {
    for (const pid of [SARAH, JOHN, undefined]) {
      await upsertJournalEntry(storage, { content: `entry ${pid ?? "self"}`, entryDate: DAY, profileId: pid ?? null });
    }
    expect(storage.rows).toHaveLength(3);
    expect(storage.rows.map((r: any) => r.linkedProfiles)).toEqual([[SARAH], [JOHN], [SELF]]);
  });

  it("the entry is linked to its owner on the junction table, and only to them", async () => {
    await upsertJournalEntry(storage, { content: "Sarah's day.", entryDate: DAY, profileId: SARAH });
    expect(storage.links).toEqual([{ profileId: SARAH, type: "journal", id: "journal-1" }]);
  });
});

describe("same person, same day — still one entry", () => {
  it("appends instead of duplicating, with no [Name] prefix", async () => {
    await upsertJournalEntry(storage, { content: "Morning was good.", entryDate: DAY, profileId: SARAH });
    const { entry, appended } = await upsertJournalEntry(storage, {
      content: "Evening was better.", entryDate: DAY, profileId: SARAH,
    });
    expect(appended).toBe(true);
    expect(storage.rows).toHaveLength(1);
    expect(entry.content).toBe("Morning was good.\n\nEvening was better.");
    expect(entry.content).not.toContain("[");
    expect(entry.linkedProfiles).toEqual([SARAH]);
  });

  it("a retried turn does not append the same text twice", async () => {
    await upsertJournalEntry(storage, { content: "We went hiking.", entryDate: DAY, profileId: SARAH });
    const retry = await upsertJournalEntry(storage, { content: "We went hiking.", entryDate: DAY, profileId: SARAH });
    expect(retry.appended).toBe(false);
    expect(storage.rows).toHaveLength(1);
    expect(storage.rows[0].content).toBe("We went hiking.");
  });

  it("a different DAY for the same person is a different row", async () => {
    await upsertJournalEntry(storage, { content: "Wednesday.", entryDate: DAY, profileId: SARAH });
    await upsertJournalEntry(storage, { content: "Thursday.", entryDate: "2026-08-21", profileId: SARAH });
    expect(storage.rows).toHaveLength(2);
  });
});

describe("legacy rows written before the fix", () => {
  it("a row already carrying two owners is matched by either, not stolen by both", async () => {
    // What the bug left behind: one row owned by John AND Sarah.
    storage.rows.push({ id: "legacy", date: DAY, mood: "neutral", content: "shared", tags: [], linkedProfiles: [JOHN, SARAH] });
    const sarah = await upsertJournalEntry(storage, { content: "Sarah again.", entryDate: DAY, profileId: SARAH });
    expect(sarah.entry.id).toBe("legacy");
    // No new owner is introduced by the append.
    expect(sarah.entry.linkedProfiles.sort()).toEqual([JOHN, SARAH].sort());
    // And the user's own write still refuses to touch it.
    const mine = await upsertJournalEntry(storage, { content: "Mine.", entryDate: DAY });
    expect(mine.entry.id).not.toBe("legacy");
    expect(mine.entry.linkedProfiles).toEqual([SELF]);
  });
});
