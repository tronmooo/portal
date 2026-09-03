/**
 * The MINIMAL patch that turns one field map into another.
 *
 * A caller that reads a profile, rewrites its field map and hands the WHOLE
 * map back to updateProfile is writing every field it read — including the
 * ones another edit changed in between. The merge (mergeFieldWrite) takes the
 * incoming spelling as truth, so the stale copy wins and that edit is gone:
 * a form save reverted by the detail read's alias cleanup firing beside it, or
 * by a chat turn that read the profile seconds earlier. Writing only what
 * actually changed leaves every other field to whoever wrote it last.
 *
 * Keys whose value changed carry the new value; keys that disappeared carry
 * null (updateProfile's deletion intent). Untouched keys are absent.
 */
export function fieldPatchBetween(
  before: Record<string, any> | null | undefined,
  after: Record<string, any> | null | undefined,
): Record<string, any> {
  const a = before && typeof before === "object" ? before : {};
  const b = after && typeof after === "object" ? after : {};
  const patch: Record<string, any> = {};
  for (const k of Object.keys(b)) {
    if (!(k in a) || !sameValue(a[k], b[k])) patch[k] = b[k];
  }
  for (const k of Object.keys(a)) {
    if (!(k in b)) patch[k] = null;
  }
  return patch;
}

function sameValue(x: unknown, y: unknown): boolean {
  if (x === y) return true;
  if (x === null || y === null || typeof x !== "object" || typeof y !== "object") return false;
  if (Array.isArray(x) !== Array.isArray(y)) return false;
  if (Array.isArray(x)) {
    return x.length === (y as unknown[]).length && x.every((v, i) => sameValue(v, (y as unknown[])[i]));
  }
  const kx = Object.keys(x as object), ky = Object.keys(y as object);
  if (kx.length !== ky.length) return false;
  return kx.every((k) => k in (y as object) && sameValue((x as any)[k], (y as any)[k]));
}
