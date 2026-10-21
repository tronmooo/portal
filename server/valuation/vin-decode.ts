// ─── VIN decoding (NHTSA vPIC) ──────────────────────────────────────────────
// A VIN states the exact vehicle: year, make, model, and usually the trim,
// body, drivetrain and engine. Those are the facts that move a vehicle's
// price most after mileage, and the user rarely types them. The decode is
// free, key-less and public (https://vpic.nhtsa.dot.gov/api/), so research
// prices the right car instead of "a CR-V".

/** Fields we take from the decode, mapped to the profile's canonical keys. */
const VPIC_FIELDS: Array<[string, string]> = [
  ["ModelYear", "year"],
  ["Make", "make"],
  ["Model", "model"],
  ["Trim", "trim"],
  ["Series", "series"],
  ["BodyClass", "bodyStyle"],
  ["DriveType", "drivetrain"],
  ["FuelTypePrimary", "fuelType"],
  ["TransmissionStyle", "transmission"],
  ["EngineCylinders", "engineCylinders"],
  ["DisplacementL", "engineLiters"],
];

const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/;
const TRANSLIT: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5,
  P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** North-American VIN check digit (position 9). */
export function isValidVin(vin: string): boolean {
  const v = vin.toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const c = v[i];
    const n = /\d/.test(c) ? Number(c) : TRANSLIT[c];
    if (n == null) return false;
    sum += n * WEIGHTS[i];
  }
  const check = sum % 11;
  return v[8] === (check === 10 ? "X" : String(check));
}

/** A valid 17-character VIN found in free text (notes, a summary), or null. */
export function findVin(text: string | null | undefined): string | null {
  if (!text) return null;
  const re = new RegExp(VIN_RE.source, "g");
  for (const m of text.toUpperCase().matchAll(re)) if (isValidVin(m[0])) return m[0];
  return null;
}

/** Test seam: replace the network call. */
let fetchOverride: ((vin: string, signal: AbortSignal) => Promise<Record<string, unknown> | null>) | null = null;
export function setVinDecoderForTest(fn: typeof fetchOverride): void { fetchOverride = fn; }

async function fetchVpic(vin: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  if (fetchOverride) return fetchOverride(vin, signal);
  const base = process.env.VIN_DECODE_BASE_URL || "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/";
  const res = await fetch(`${base}${encodeURIComponent(vin)}?format=json`, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const json: any = await res.json().catch(() => null);
  return json?.Results?.[0] ?? null;
}

/**
 * Decode a VIN to canonical spec keys. Returns {} when the VIN is invalid,
 * the service is down, or it knows nothing — a decode is an enrichment, never
 * a requirement.
 */
export async function decodeVin(vin: string, signal: AbortSignal): Promise<Record<string, string | number>> {
  if (!isValidVin(vin)) return {};
  let row: Record<string, unknown> | null = null;
  try { row = await fetchVpic(vin.toUpperCase(), signal); } catch { return {}; }
  if (!row) return {};
  const out: Record<string, string | number> = {};
  for (const [src, key] of VPIC_FIELDS) {
    const raw = row[src];
    if (raw == null) continue;
    const s = String(raw).trim();
    if (!s || /^(not applicable|null|0)$/i.test(s)) continue;
    if (key === "year") { const y = Number(s); if (y > 1950 && y < 2100) out.year = y; continue; }
    if (key === "engineLiters") { const l = Number(s); if (l > 0) out.engineLiters = Math.round(l * 10) / 10; continue; }
    out[key] = s.slice(0, 60);
  }
  // Many makes put the trim in Series instead of Trim.
  if (!out.trim && out.series) out.trim = out.series;
  delete out.series;
  return out;
}
