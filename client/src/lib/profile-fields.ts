// ── Shared person/pet identity field helpers ─────────────────────────────────
// Extracted (2026-07-08) so the profiles grid card AND the new lightweight
// hub Info page (pages/profile-info.tsx) classify + label identity fields the
// same way. Presentation-agnostic and pure — unit-tested in
// tests/profile-fields.test.ts.

/** Human-readable age from a birthday string, or null if unparseable/implausible. */
export function computeAge(birthday: any): string | null {
  if (!birthday || typeof birthday !== "string") return null;
  const d = new Date(birthday);
  if (isNaN(d.getTime())) return null;
  const diff = Date.now() - d.getTime();
  const years = diff / (365.25 * 24 * 60 * 60 * 1000);
  if (years < 0 || years > 130) return null;
  if (years < 2) {
    const months = Math.floor(years * 12);
    return `${months} mo`;
  }
  return `${Math.floor(years)} yr`;
}

// Identity fields shown on the Info page, in display order. Superset of the
// profiles-grid whitelist (which caps at 5) — the Info page is the full quick
// reference, so it shows every identity field that has a value.
export const PERSON_INFO_FIELDS: Array<{ key: string; label: string }> = [
  { key: "birthday",         label: "Birthday" },
  { key: "sex",              label: "Sex" },
  { key: "gender",           label: "Gender" },
  { key: "email",            label: "Email" },
  { key: "phone",            label: "Phone" },
  { key: "address",          label: "Address" },
  { key: "relationship",     label: "Relationship" },
  { key: "emergencyContact", label: "Emergency" },
  { key: "bloodType",        label: "Blood Type" },
  { key: "allergies",        label: "Allergies" },
  { key: "height",           label: "Height" },
  { key: "occupation",       label: "Occupation" },
];

export const PET_INFO_FIELDS: Array<{ key: string; label: string }> = [
  { key: "species",      label: "Species" },
  { key: "breed",        label: "Breed" },
  { key: "birthday",     label: "Birthday" },
  { key: "sex",          label: "Sex" },
  { key: "color",        label: "Color" },
  { key: "weight",       label: "Weight" },
  { key: "microchipId",  label: "Microchip" },
  { key: "vet",          label: "Vet" },
];

/** The field definitions for a profile type (person/self → person, pet → pet). */
export function infoFieldsForType(type: string | undefined): Array<{ key: string; label: string }> {
  return type === "pet" ? PET_INFO_FIELDS : PERSON_INFO_FIELDS;
}

/** Case-insensitive lookup against a flattened fields object. */
export function readField(fields: Record<string, any> | undefined, key: string): any {
  if (!fields) return undefined;
  if (fields[key] !== undefined) return fields[key];
  const lc = key.toLowerCase();
  for (const k of Object.keys(fields)) {
    if (k.toLowerCase() === lc) return fields[k];
  }
  // Birthday aliases.
  if (lc === "birthday") return fields.dateOfBirth ?? fields.dob;
  return undefined;
}
