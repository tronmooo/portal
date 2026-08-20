/**
 * NOTES ARE NOT ARTIFACTS (user rule 2026-08-20).
 *
 * The report: "Make me a note tomorrow to call Mike" saved the note, and the
 * chat action card underneath it read "Create Artifact". Notes are stored as
 * artifact rows of type "note" — an implementation detail — but to the user a
 * note is a note: it must never be labelled an artifact and must never land on
 * the Artifacts tab. A CHECKLIST is an artifact. So is a chart, but only when
 * the user asks for one ("create an artifact of a chart of my weight").
 */
import { describe, it, expect } from "vitest";
import { isNoteArtifactInput } from "../server/ai-engine";

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
