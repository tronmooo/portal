/**
 * NOTES ARE NOT ARTIFACTS (user rule 2026-08-20), in the chat card AND in the
 * database.
 *
 * The report: "Make me a note tomorrow to call Mike" saved the note, and the
 * chat action card underneath it read "Create Artifact". Notes are stored as
 * artifact rows of type "note" — an implementation detail — but to the user a
 * note is a note: it must never be labelled an artifact and must never land on
 * the Artifacts tab. A CHECKLIST is an artifact. So is a chart, but only when
 * the user asks for one ("create an artifact of a chart of my weight").
 *
 * Notes were briefly stored as artifact rows of type "note". They are not
 * artifacts and no longer share that table — see
 * migrations/20260820_notes_table.sql.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { isNoteArtifactInput } from "../server/ai-engine";
import { MemStorage } from "../server/storage";
import { createNote, listNotes, updateNote, deleteNote } from "../server/content-service";

describe("a create_artifact call that is really a note", () => {
  it("recognizes an explicit type:'note'", () => {
    expect(isNoteArtifactInput({ type: "note", title: "Call Mike", content: "Call Mike" })).toBe(true);
  });

  it("recognizes a missing type — the old silent fallback to 'note'", () => {
    expect(isNoteArtifactInput({ title: "Call Mike", content: "Call Mike" })).toBe(true);
    expect(isNoteArtifactInput({ type: "", content: "x" })).toBe(true);
  });

  it("recognizes a type the artifact schema does not know", () => {
    // These used to fall back to "note" inside the executor, so they were
    // notes wearing an artifact card.
    expect(isNoteArtifactInput({ type: "memo", content: "x" })).toBe(true);
    expect(isNoteArtifactInput({ type: "reminder", content: "x" })).toBe(true);
  });
});

describe("real artifacts stay artifacts", () => {
  it.each([
    ["checklist"],
    ["chart"],
    ["markdown"],
    ["code"],
    ["html"],
    ["svg"],
    ["mermaid"],
    ["doc"],
    ["sheet"],
  ])("type:'%s' is an artifact", (type) => {
    expect(isNoteArtifactInput({ type, content: "x" })).toBe(false);
  });

  it("is case-insensitive about the type name", () => {
    expect(isNoteArtifactInput({ type: "Checklist", content: "x" })).toBe(false);
    expect(isNoteArtifactInput({ type: "NOTE", content: "x" })).toBe(true);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Storage separation: a note is written to, read from and deleted from the
// notes table. The artifacts table never sees it.
// ─────────────────────────────────────────────────────────────────────────────
describe("notes live in their own table", () => {
  let storage: MemStorage;
  beforeEach(() => { storage = new MemStorage(); });

  it("createNote writes a note and no artifact", async () => {
    const { note } = await createNote(storage, { content: "Robert's gate code is 4821", source: "chat" });
    expect(note.id).toBeTruthy();
    expect(await storage.getNote(note.id)).toBeTruthy();
    expect(await storage.getArtifacts()).toHaveLength(0);
  });

  it("a note derives a title from its body when none is given", async () => {
    const { note } = await createNote(storage, { content: "The gate code is 4821. Use the side entrance." });
    expect(note.title).toBe("The gate code is 4821.");
  });

  it("listNotes reads the notes table, not the artifacts table", async () => {
    await createNote(storage, { content: "Gate code 4821" });
    await storage.createArtifact({ type: "checklist", title: "Packing list", content: "", items: [{ text: "socks" }] } as any);
    const found = await listNotes(storage);
    expect(found).toHaveLength(1);
    expect(found[0].content).toBe("Gate code 4821");
    expect(await storage.getArtifacts()).toHaveLength(1);
  });

  it("the same note twice is one row — a retried turn does not duplicate", async () => {
    await createNote(storage, { content: "Gate code 4821" });
    const second = await createNote(storage, { content: "gate code 4821" });
    expect(second.deduped).toBe(true);
    expect(await listNotes(storage)).toHaveLength(1);
  });

  it("update and delete go through the notes table", async () => {
    const { note } = await createNote(storage, { content: "Gate code 4821" });
    const updated = await updateNote(storage, note.id, { append: "Side entrance." });
    expect(updated?.content).toContain("Side entrance.");
    expect(await deleteNote(storage, note.id)).toBe(true);
    expect(await storage.getNote(note.id)).toBeUndefined();
  });

  it("profile isolation: Jane's note never surfaces under Robert", async () => {
    await createNote(storage, { content: "Jane prefers mornings", profileId: "p-jane" });
    expect(await listNotes(storage, { profileId: "p-robert" })).toHaveLength(0);
    expect(await listNotes(storage, { profileId: "p-jane" })).toHaveLength(1);
  });

  it("a legacy artifact row of type 'note' is never served as an artifact", async () => {
    // Code can deploy ahead of the migration that moves these rows; a leftover
    // must not reappear on the Artifacts tab.
    await storage.createArtifact({ type: "note", title: "Legacy", content: "old" } as any);
    expect(await storage.getArtifacts()).toHaveLength(0);
  });
});
