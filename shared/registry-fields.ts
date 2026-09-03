// Registry-driven forms (profile_type_definitions.field_schema) render every
// numeric field as an <input type="number"> whose change event carries a
// STRING. The dialog used to save that string as the field value, so a
// vehicle's year or mileage was stored as "12500" while the same field edited
// elsewhere was stored as 12500 (D264). Coerce by the schema, at submit.

export interface RegistryFieldDef { key: string; type?: string }

const NUMERIC_TYPES = new Set(["number", "currency", "percentage"]);

/** A number for a numeric field whose value parses (money punctuation tolerated); the raw value otherwise. */
export function coerceRegistryFieldValue(type: string | undefined, raw: unknown): unknown {
  if (!type || !NUMERIC_TYPES.has(type)) return raw;
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (trimmed === "") return raw;
  const n = Number(trimmed.replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : raw;
}

/** The submitted field map with every numeric schema field coerced (unknown keys untouched). */
export function coerceRegistryFields(schema: RegistryFieldDef[] | null | undefined, fields: Record<string, unknown>): Record<string, unknown> {
  const byKey = new Map((schema || []).map((f) => [f.key, f.type] as const));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = coerceRegistryFieldValue(byKey.get(k), v);
  return out;
}
