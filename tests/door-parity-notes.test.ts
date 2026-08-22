// ─── Door parity: notes ─────────────────────────────────────────────────────
//
// Notes are the cheapest parity proof because their mutation layer was
// consolidated long ago (server/content-service.ts: "AI CHAT AND MANUAL
// CREATION USE THE SAME CODE"). What was NOT shared until the mutation-outcome
// contract: the REST door wrote with no read-back verification, no undo-ledger
// row, and no change manifest. This suite pins the full contract for both
// doors so every later canonical service (expenses, tracker entries, events,
// profile facts) has a template with teeth.
import { describe, it, expect } from "vitest";
import { executeTool } from "../server/ai-engine";
import { createNote, deleteNote } from "../server/content-service";
import {
  MemStorage,
  driveDoor,
  withStorage,
  normalizeRow,
  normalizeManifest,
  ledgerRows,
} from "./door-parity/harness";

const CONTENT = "Garage door code is 4321";
const TITLE = "Garage door";

let seq = 0;
const nextUser = () => `door-parity-notes-${++seq}`;

/** The chat door: the create_note tool, driven with no model in the loop. */
async function chatCreate(storage: MemStorage, userId: string) {
  return driveDoor(storage, "chat", "create_note", { content: CONTENT, title: TITLE }, () =>
    executeTool("create_note", { content: CONTENT, title: TITLE }, userId),
  );
}

/** The REST door: what POST /api/notes runs (server/routes.ts). */
async function restCreate(storage: MemStorage) {
  return driveDoor(storage, "rest", "create_note", { content: CONTENT, title: TITLE }, async () => {
    const result = await createNote(storage, {
      content: CONTENT, title: TITLE, profileId: null, tags: [], source: "manual",
    });
    return { ...result.note, ...(result.deduped ? { deduped: true } : {}) };
  });
}

describe("door parity — note create", () => {
  it("chat and REST produce the same row, manifest, and ledger contract", async () => {
    const chatStore = new MemStorage();
    const restStore = new MemStorage();

    const chatOutcome = await chatCreate(chatStore, nextUser());
    const restOutcome = await restCreate(restStore);

    // Both doors succeeded with a verified write.
    expect(chatOutcome.ok).toBe(true);
    expect(restOutcome.ok).toBe(true);
    expect(chatOutcome.envelope?.verification?.database_record_exists).toBe(true);
    expect(restOutcome.envelope?.verification?.database_record_exists).toBe(true);

    // Same database end state (ids/timestamps/door-marks normalized away).
    const chatRows = await withStorage(chatStore, () => chatStore.getArtifacts());
    const restRows = await withStorage(restStore, () => restStore.getArtifacts());
    expect(chatRows).toHaveLength(1);
    expect(restRows).toHaveLength(1);
    const [chatRow, restRow] = [normalizeRow(chatRows[0]), normalizeRow(restRows[0])];
    expect(chatRow?.type).toBe("note");
    expect(chatRow?.title).toBe(restRow?.title);
    expect(chatRow?.content).toBe(restRow?.content);

    // Same change manifest: one precise create, no "everything" fallback.
    const want = [{ op: "create", entityType: "artifact", endpoint: "/api/artifacts", domains: ["artifacts"] }];
    expect(normalizeManifest(chatOutcome.mutations)).toEqual(want);
    expect(normalizeManifest(restOutcome.mutations)).toEqual(want);

    // One undo-ledger row each, naming the door it came through.
    expect(await ledgerRows(chatStore)).toEqual([
      { tool: "create_note", source: "chat", entityType: "artifact", reversible: true },
    ]);
    expect(await ledgerRows(restStore)).toEqual([
      { tool: "create_note", source: "rest", entityType: "artifact", reversible: true },
    ]);
  });

  it("replaying the same create dedupes: no second row, no ledger row, no create claim", async () => {
    const store = new MemStorage();
    const first = await restCreate(store);
    expect(first.ok).toBe(true);
    expect(first.deduped).toBeFalsy();

    const replay = await restCreate(store);
    expect(replay.ok).toBe(true);
    expect(replay.deduped).toBe(true);
    // A dedupe wrote nothing: claiming a create would put a phantom row in
    // the client's lists, and a ledger row would make Undo destroy the
    // record the user already had.
    expect(replay.mutations).toEqual([]);
    expect(await withStorage(store, () => store.getArtifacts())).toHaveLength(1);
    expect(await ledgerRows(store)).toHaveLength(1);
  });
});

describe("door parity — note delete", () => {
  it("both doors delete with a verified read-back and a delete manifest", async () => {
    for (const door of ["chat", "rest"] as const) {
      const store = new MemStorage();
      const created = await restCreate(store);
      const id = created.entity?.id;
      expect(id, `${door}: created note id`).toBeTruthy();

      const outcome = await driveDoor(store, door, "delete_note", { id }, async () => {
        // The chat tool addresses notes by title (the model has no ids); the
        // REST route addresses them by id. Same note either way.
        if (door === "chat") return executeTool("delete_note", { title: TITLE }, nextUser());
        const ok = await deleteNote(store, id!);
        return ok ? { id } : { error: "Note not found" };
      });

      expect(outcome.ok, `${door}: delete ok`).toBe(true);
      expect(await withStorage(store, () => store.getArtifacts())).toHaveLength(0);
      expect(normalizeManifest(outcome.mutations)).toEqual([
        { op: "delete", entityType: "artifact", endpoint: "/api/artifacts", domains: ["artifacts"] },
      ]);
      // The ledger lists newest first (it feeds undo_last_action).
      const ledger = await ledgerRows(store);
      expect(ledger).toHaveLength(2);
      expect(ledger[0]).toEqual({
        tool: "delete_note", source: door, entityType: "artifact", reversible: true,
      });
    }
  });
});
