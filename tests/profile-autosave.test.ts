// The Edit dialog saves by itself.
//
// 2026-11-19 (owner request): "when I press edit and I edit things I want it
// to automatically save right away". The dialog no longer has a Save button:
// it saves shortly after typing stops, when a field is left, and on close.
// What each save sends is decided here.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { pendingProfilePatch, applySavedPatch, parseFieldInput, fieldInputProblem, type EditFormState } from "../client/src/lib/profile-autosave";

const SAVED: EditFormState = { name: "Sony WH-1000XM5", notes: "", fields: { brand: "Sony", purchasePrice: "599", email: "" } };
const edit = (over: Partial<EditFormState> & { fields?: Record<string, string> }): EditFormState =>
  ({ ...SAVED, ...over, fields: { ...SAVED.fields, ...(over.fields || {}) } });

describe("what an autosave sends", () => {
  it("nothing when nothing changed", () => {
    expect(pendingProfilePatch(SAVED, edit({}))).toEqual({ patch: null, blocked: {} });
  });
  it("only the field that changed, as a number when it is one", () => {
    expect(pendingProfilePatch(SAVED, edit({ fields: { purchasePrice: "549" } })))
      .toEqual({ patch: { fields: { purchasePrice: 549 } }, blocked: {} });
  });
  it("an empty suggested box is not a change, a cleared value is", () => {
    expect(pendingProfilePatch(SAVED, edit({ fields: { serialNumber: "" } })).patch).toBeNull();
    expect(pendingProfilePatch(SAVED, edit({ fields: { brand: "" } })).patch).toEqual({ fields: { brand: "" } });
  });
  it("name and notes travel on their own", () => {
    expect(pendingProfilePatch(SAVED, edit({ name: "Sony headphones", notes: "gift" })).patch)
      .toEqual({ name: "Sony headphones", notes: "gift" });
  });
  it("an unfinished email is held back, and the rest still saves", () => {
    const r = pendingProfilePatch(SAVED, edit({ fields: { email: "bob@", brand: "Sony Corp" } }));
    expect(r.patch).toEqual({ fields: { brand: "Sony Corp" } });
    expect(r.blocked).toEqual({ email: "Enter a valid email address" });
  });
  it("an empty name is never sent", () => {
    const r = pendingProfilePatch(SAVED, edit({ name: "  " }));
    expect(r.patch).toBeNull();
    expect(r.blocked.name).toMatch(/required/i);
  });
  it("after a save, the same values are no longer pending; a later edit is", () => {
    const sent = edit({ fields: { purchasePrice: "549" } });
    const { patch } = pendingProfilePatch(SAVED, sent);
    const saved = applySavedPatch(SAVED, sent, patch!);
    expect(pendingProfilePatch(saved, sent).patch).toBeNull();
    // Typed while that save was in flight: still pending afterwards.
    const later = { ...sent, fields: { ...sent.fields, brand: "Sony Corp" } };
    expect(pendingProfilePatch(saved, later).patch).toEqual({ fields: { brand: "Sony Corp" } });
  });
  it("a held-back value is not marked saved", () => {
    const sent = edit({ fields: { email: "bob@", brand: "Sony Corp" } });
    const saved = applySavedPatch(SAVED, sent, pendingProfilePatch(SAVED, sent).patch!);
    expect(pendingProfilePatch(saved, edit({ fields: { email: "bob@example.com", brand: "Sony Corp" } })).patch)
      .toEqual({ fields: { email: "bob@example.com" } });
  });
  it("parses and validates single values", () => {
    expect(parseFieldInput("45000")).toBe(45000);
    expect(parseFieldInput("WH-1000XM5")).toBe("WH-1000XM5");
    expect(parseFieldInput("")).toBe("");
    expect(fieldInputProblem("phone", "555")).toMatch(/phone/i);
    expect(fieldInputProblem("phone", "555-123-4567")).toBeNull();
    expect(fieldInputProblem("color", "x")).toBeNull();
  });
});

describe("the Edit dialog is wired to autosave", () => {
  const src = readFileSync(resolve(__dirname, "../client/src/pages/profile-detail.tsx"), "utf8");
  const start = src.indexOf("function EditProfileDialog(");
  const body = src.slice(start, src.indexOf("// TYPE-SPECIFIC TABS DEFINITION", start));
  it("has no Save button, and a status line instead", () => {
    expect(start).toBeGreaterThan(0);
    expect(body).not.toMatch(/button-save-profile/);
    expect(body).toMatch(/data-testid="edit-save-status"/);
  });
  it("saves after typing stops, on leaving a field, and on close", () => {
    expect(body).toMatch(/setTimeout\(\(\) => \{ void flush\(\); \}, 800\)/);
    expect(body).toMatch(/onBlur=\{\(\) => \{ void flush\(\); \}\}/);
    expect(body).toMatch(/const closeAfterSaving = \(\) => \{ void flush\(\); onClose\(\); \}/);
  });
  it("sends only the pending patch, never the whole field map", () => {
    expect(body).toMatch(/apiRequest\("PATCH", `\/api\/profiles\/\$\{profile\.id\}`, patch\)/);
    expect(body).not.toMatch(/fields: parsedFields/);
  });
});
