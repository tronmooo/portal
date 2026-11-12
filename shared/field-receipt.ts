// ── Field receipt: what the chat may say it saved ───────────────────────────
//
// Rule (owner, 2026-11-12): every claim of success in AI Chat is backed by a
// database write AND a fresh read of the record afterwards. "My car is white,
// has 35,000 miles and is all-wheel drive" must come back as three lines —
// Color, Mileage, Drivetrain — each with a ✓ only if the row read back from
// the database holds that value, and a ✗ naming the field if it does not.
//
// This module is the pure half of that: given what a write ASKED for and the
// record as READ BACK, it says field by field what is verified. The server
// (update_profile / create_profile in server/ai-engine.ts) supplies the fresh
// read; the chat card (client/src/components/chat/FieldReceiptList.tsx) and
// the model's reply both render from the same receipt, so the two cannot
// disagree.
//
// Pinned by tests/field-receipt.test.ts.

import { fieldKeyLabel } from "./field-label";
import { readProfileFieldValue, isReservedFieldKey } from "./profile-field-identity";

export interface FieldReceiptLine {
  /** Storage key written (canonical spelling). */
  key: string;
  /** Human label: "Mileage", "Drivetrain". */
  label: string;
  /** The value as the user should read it: "35,000 miles". From the READ-BACK
   *  row when verified; the requested value otherwise. */
  display: string;
  /** The stored row holds exactly the requested value. */
  verified: boolean;
  /** "removed" lines verify that a field is GONE. */
  op?: "set" | "removed";
}

export interface FieldReceipt {
  profileId: string;
  name: string;
  type?: string;
  /** "Assets → Vehicles → Honda CR-V" — where the user finds it in the app. */
  savedTo: string;
  lines: FieldReceiptLine[];
  allVerified: boolean;
  verifiedCount: number;
  failedKeys: string[];
}

// ── Labels ───────────────────────────────────────────────────────────────────

const LABEL_OVERRIDES: Record<string, string> = {
  currentValue: "Current value",
  purchasePrice: "Purchase price",
  purchaseDate: "Purchase date",
  vin: "VIN",
  licensePlate: "License plate",
  mileage: "Mileage",
  drivetrain: "Drivetrain",
  driveType: "Drivetrain",
  color: "Color",
  exteriorColor: "Exterior color",
  interiorColor: "Interior color",
  bloodType: "Blood type",
};

export function receiptFieldLabel(key: string): string {
  return LABEL_OVERRIDES[key] ?? fieldKeyLabel(key);
}

// ── Display ──────────────────────────────────────────────────────────────────

const MONEY_KEYS = /^(currentvalue|purchaseprice|balance|remainingbalance|originalbalance|monthlypayment|price|cost|value|premium|amount)$/i;

const DRIVETRAIN_NAMES: Record<string, string> = {
  awd: "All-wheel drive (AWD)",
  "4wd": "Four-wheel drive (4WD)",
  "4x4": "Four-wheel drive (4WD)",
  fwd: "Front-wheel drive (FWD)",
  rwd: "Rear-wheel drive (RWD)",
  "allwheeldrive": "All-wheel drive (AWD)",
  "fourwheeldrive": "Four-wheel drive (4WD)",
  "frontwheeldrive": "Front-wheel drive (FWD)",
  "rearwheeldrive": "Rear-wheel drive (RWD)",
};

function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** "35000" under mileage → "35,000 miles"; "awd" under drivetrain → "All-wheel drive (AWD)". */
export function receiptDisplayValue(key: string, value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (Array.isArray(value)) return value.map((v) => receiptDisplayValue(key, v)).join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  const lk = key.toLowerCase();
  const num = asNumber(value);
  if (lk === "mileage" && num !== null) return `${num.toLocaleString("en-US")} miles`;
  if (MONEY_KEYS.test(key) && num !== null) {
    return `$${num.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(num) ? 0 : 2, maximumFractionDigits: 2 })}`;
  }
  if (lk === "drivetrain" || lk === "drivetype") {
    const known = DRIVETRAIN_NAMES[String(value).toLowerCase().replace(/[^a-z0-9]/g, "")];
    if (known) return known;
  }
  // Plain words read better capitalized ("white" → "White"); anything with
  // digits or mixed case (a VIN, a plate, "iPhone") is shown exactly.
  const s = String(value);
  if (/^[a-z][a-z\s'-]*$/.test(s)) return s.charAt(0).toUpperCase() + s.slice(1);
  return s;
}

// ── Comparison ───────────────────────────────────────────────────────────────

/** Does the stored value hold what was asked for? Exact, modulo number vs
 *  numeric-string ("35000" vs 35000 vs "35,000") and surrounding whitespace. */
export function receiptValuesMatch(requested: unknown, stored: unknown): boolean {
  if (stored === undefined) return false;
  if (requested === stored) return true;
  const rn = asNumber(requested);
  const sn = asNumber(stored);
  if (rn !== null && sn !== null) return rn === sn;
  if (typeof requested === "string" && typeof stored === "string") {
    return requested.trim() === stored.trim();
  }
  if (typeof requested === "boolean" || typeof stored === "boolean") {
    return String(requested).toLowerCase() === String(stored).toLowerCase();
  }
  try { return JSON.stringify(requested) === JSON.stringify(stored); } catch { return false; }
}

// ── Where the user finds it ──────────────────────────────────────────────────

const SECTION_BY_TYPE: Record<string, string> = {
  vehicle: "Assets → Vehicles",
  property: "Assets → Property",
  asset: "Assets",
  investment: "Assets → Investments",
  account: "Assets → Accounts",
  loan: "Liabilities",
  liability: "Liabilities",
  subscription: "Subscriptions",
  pet: "Profiles → Pets",
  person: "Profiles → People",
  self: "Profiles → You",
  medical: "Profiles → Services",
};

export function receiptSavedTo(type: string | undefined, name: string): string {
  const section = SECTION_BY_TYPE[String(type || "")] || "Profiles";
  return `${section} → ${name}`;
}

// ── Build ────────────────────────────────────────────────────────────────────

export interface BuildFieldReceiptInput {
  /** The profile as READ BACK from the database after the write. Undefined
   *  when the read-back found nothing — every line is then unverified. */
  stored: { id: string; name: string; type?: string; fields?: Record<string, any> | null; notes?: string | null } | null | undefined;
  /** Fallbacks for the header when the read-back failed. */
  profileId: string;
  profileName: string;
  profileType?: string;
  /** Field values the write asked to set (canonical keys). */
  requestedFields?: Record<string, any> | null;
  /** Field keys the write asked to remove. */
  removedFields?: readonly string[] | null;
  /** A rename the write asked for. */
  requestedName?: string;
  /** Notes the write asked to set. */
  requestedNotes?: string | null;
}

/** Keys the server derives itself, not values the user stated. */
const DERIVED_KEYS = new Set(["previousValue", "currentValueSource", "currentValueUpdatedAt", "valueUpdatedAt"]);

export function buildFieldReceipt(input: BuildFieldReceiptInput): FieldReceipt {
  const stored = input.stored || null;
  const storedFields = (stored?.fields && typeof stored.fields === "object") ? stored.fields : {};
  const lines: FieldReceiptLine[] = [];

  if (input.requestedName !== undefined && input.requestedName !== "") {
    const ok = !!stored && receiptValuesMatch(input.requestedName, stored.name);
    lines.push({ key: "name", label: "Name", display: String(ok ? stored!.name : input.requestedName), verified: ok, op: "set" });
  }

  for (const [key, requested] of Object.entries(input.requestedFields || {})) {
    if (isReservedFieldKey(key) || DERIVED_KEYS.has(key)) continue;
    if (requested === undefined) continue;
    const storedValue = stored ? readProfileFieldValue(storedFields, key) : undefined;
    const verified = !!stored && receiptValuesMatch(requested, storedValue);
    lines.push({
      key,
      label: receiptFieldLabel(key),
      display: receiptDisplayValue(key, verified ? storedValue : requested),
      verified,
      op: "set",
    });
  }

  if (input.requestedNotes !== undefined && input.requestedNotes !== null) {
    const ok = !!stored && receiptValuesMatch(input.requestedNotes, stored.notes ?? "");
    const text = String(input.requestedNotes);
    lines.push({ key: "notes", label: "Notes", display: text.length > 80 ? `${text.slice(0, 77)}…` : text || "—", verified: ok, op: "set" });
  }

  for (const key of input.removedFields || []) {
    const gone = !!stored && readProfileFieldValue(storedFields, key) === undefined;
    lines.push({ key, label: receiptFieldLabel(key), display: "removed", verified: gone, op: "removed" });
  }

  const name = stored?.name || input.profileName;
  const type = stored?.type || input.profileType;
  const failedKeys = lines.filter((l) => !l.verified).map((l) => l.key);
  return {
    profileId: stored?.id || input.profileId,
    name,
    ...(type ? { type } : {}),
    savedTo: receiptSavedTo(type, name),
    lines,
    allVerified: lines.length > 0 && failedKeys.length === 0,
    verifiedCount: lines.length - failedKeys.length,
    failedKeys,
  };
}

/** The chat text for a receipt — what the model is told to say, and what the
 *  card shows. ✓ only on verified lines. */
export function formatFieldReceiptText(r: FieldReceipt): string {
  const out: string[] = [];
  for (const l of r.lines) {
    if (l.op === "removed") out.push(`• ${l.label}: removed ${l.verified ? "✓" : "✗ (still on the record)"}`);
    else out.push(`• ${l.label}: ${l.display} ${l.verified ? "✓" : "✗ (not saved)"}`);
  }
  out.push(`Saved to: ${r.savedTo}`);
  return out.join("\n");
}
