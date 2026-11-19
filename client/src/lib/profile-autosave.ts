// What the Edit dialog still has to save.
//
// The dialog saves by itself: there is no Save button to forget. Each save
// sends ONLY what changed since the last successful save (never the whole
// field map, Rule 6), and a value that is not yet valid (half an email
// address) is held back and reported, not sent and not lost.
//
// Pure, so the same logic is tested directly (tests/profile-autosave.test.ts).

export interface EditFormState {
  name: string;
  notes: string;
  fields: Record<string, string>;
}

export interface PendingProfilePatch {
  /** The PATCH body for what changed and is valid; null when nothing is ready. */
  patch: { name?: string; notes?: string; fields?: Record<string, string | number> } | null;
  /** key → why it was held back ("name" for the name). */
  blocked: Record<string, string>;
}

/** A typed value as it is stored: a number when it is one, else the text. */
export function parseFieldInput(value: string): string | number {
  const v = String(value ?? "");
  const n = Number(v);
  return v.trim() !== "" && !Number.isNaN(n) ? n : v;
}

/** Why this value can't be saved yet, or null. */
export function fieldInputProblem(key: string, value: string): string | null {
  const v = String(value ?? "");
  if (v === "") return null;
  const k = key.toLowerCase();
  if (k.includes("email") && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "Enter a valid email address";
  if (k.includes("phone") && !/^\+?[\d\s()-]{7,15}$/.test(v)) return "Enter a valid phone number";
  return null;
}

const same = (a: string | undefined, b: string | undefined) => (a ?? "") === (b ?? "");

/**
 * Everything in `current` that differs from `saved`, split into what can be
 * sent now and what is held back. A field that is absent and one that is
 * empty are the same thing (the form shows suggested fields as empty boxes).
 */
export function pendingProfilePatch(saved: EditFormState, current: EditFormState): PendingProfilePatch {
  const blocked: Record<string, string> = {};
  const patch: NonNullable<PendingProfilePatch["patch"]> = {};

  if (!same(saved.name.trim(), current.name.trim())) {
    if (current.name.trim() === "") blocked.name = "A name is required";
    else patch.name = current.name.trim();
  }
  if (!same(saved.notes, current.notes)) patch.notes = current.notes;

  const fields: Record<string, string | number> = {};
  for (const key of new Set([...Object.keys(saved.fields), ...Object.keys(current.fields)])) {
    if (same(saved.fields[key], current.fields[key])) continue;
    const value = current.fields[key] ?? "";
    const problem = fieldInputProblem(key, value);
    if (problem) { blocked[key] = problem; continue; }
    fields[key] = parseFieldInput(value);
  }
  if (Object.keys(fields).length > 0) patch.fields = fields;

  return { patch: Object.keys(patch).length > 0 ? patch : null, blocked };
}

/** `saved` after `patch` was accepted by the server, taking the values from `sent`. */
export function applySavedPatch(saved: EditFormState, sent: EditFormState, patch: NonNullable<PendingProfilePatch["patch"]>): EditFormState {
  const next: EditFormState = { name: saved.name, notes: saved.notes, fields: { ...saved.fields } };
  if (patch.name !== undefined) next.name = sent.name;
  if (patch.notes !== undefined) next.notes = sent.notes;
  for (const key of Object.keys(patch.fields || {})) next.fields[key] = sent.fields[key] ?? "";
  return next;
}
