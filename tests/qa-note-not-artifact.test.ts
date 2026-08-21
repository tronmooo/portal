// A note is a note — in the router, in the action type, and on the card.
//
// From the QA report: "Make a note for Sarah…" produced a "Create Artifact"
// confirmation with an "Open artifact" button. The note system exists; the
// artifact system had quietly become the fallback home for structured data,
// and the confirmation card described the storage table rather than the object
// the user asked for.

import { describe, it, expect } from "vitest";
import { checkContentRouting, CONTENT_TOOL_KIND, routeContent } from "@shared/content-routing";
import { TOOL_ACTION_MAP } from "../server/ai-engine";
import { actionLabel, actionRoute } from "../client/src/lib/action-cards";

const NOTE_MSG = "Make a note for Sarah that she prefers morning appointments";

describe("QA req 2 — an explicit note never becomes an artifact", () => {
  it("routes the message to the note kind", () => {
    const plan = routeContent(NOTE_MSG);
    const note = plan.actions.find((a) => a.kind === "note");
    expect(note, "the router must see a note").toBeTruthy();
    expect(note!.explicit).toBe(true);
  });

  it("refuses create_artifact for an explicit note request", () => {
    const violation = checkContentRouting("create_artifact", NOTE_MSG);
    expect(violation, "create_artifact must be blocked").not.toBeNull();
    expect(violation!.requestedKind).toBe("note");
    expect(violation!.modelDirective).toContain("create_note");
  });

  it("allows create_note for the same message", () => {
    expect(checkContentRouting("create_note", NOTE_MSG)).toBeNull();
  });

  it("knows artifact tools write documents", () => {
    for (const tool of ["create_artifact", "update_artifact", "delete_artifact"]) {
      expect(CONTENT_TOOL_KIND[tool], tool).toBe("document");
    }
  });
});

describe("QA req 2 — the card describes the object that was created", () => {
  it("maps create_note to its own action type, not the artifact one", () => {
    expect(TOOL_ACTION_MAP.create_note).toBe("create_note");
    expect(TOOL_ACTION_MAP.create_artifact).toBe("create_artifact");
  });

  it("labels the card 'Create Note'", () => {
    expect(actionLabel("create_note")).toBe("Create Note");
    expect(actionLabel("create_note")).not.toContain("Artifact");
  });
});

describe("QA req 1 — navigation uses the canonical owner id", () => {
  const SARAH = "11111111-1111-4111-8111-111111111111";
  const JOHN = "22222222-2222-4222-8222-222222222222";

  it("sends a note for Sarah to Sarah's Notes tab", () => {
    expect(actionRoute("create_note", { _ownerProfileId: SARAH })).toBe(`/profiles/${SARAH}/notes`);
  });

  it("never routes to a different profile than the one the mutation returned", () => {
    const route = actionRoute("create_note", { _ownerProfileId: SARAH, forProfile: "John Hancock" });
    expect(route).toContain(SARAH);
    expect(route).not.toContain(JOHN);
  });

  it("falls back to the artifacts list rather than guessing a profile", () => {
    expect(actionRoute("create_note", {})).toBe("/artifacts");
  });

  it("opens a created profile by its returned id", () => {
    expect(actionRoute("create_profile", { _entityId: SARAH })).toBe(`/profiles/${SARAH}`);
    // Name in the payload must never win over the id.
    expect(actionRoute("create_profile", { _entityId: SARAH, name: "John Hancock" }))
      .toBe(`/profiles/${SARAH}`);
  });
});
