// ── Field receipt: what the chat may say it saved ───────────────────────────
//
// Rule (owner, 2026-11-12): every claim of success in AI Chat is backed by a
// database write AND a fresh read of the record afterwards. "My car is white,
// has 35,000 miles and is all-wheel drive" must come back as three lines —
// Color, Mileage, Drivetrain — each with a ✓ only if the row read back from
// the database holds that value. A field that does not read back is re-saved
// and read again (server/profile-write-verify.ts) before anything is said.
//
// This module is the pure half of that: given what a write ASKED for and the
// record as READ BACK, it says field by field what is verified. The server
// (update_profile / create_profile in server/ai-engine.ts) supplies the fresh
// read; the chat message (composeReceiptReply) and the action card
// (receiptCardSummary) both render from the same receipt, so the two cannot
// disagree.
//
// Pinned by tests/chat-save-verify-confirm.test.ts.

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
  /** A new record ("Created a new asset profile…") or an existing one. */
  action?: "created" | "updated";
  /** Whose record, when it isn't the user's own ("Jim's Honda"). */
  ownerName?: string;
  /** Some field needed a second write before it read back. */
  retried?: boolean;
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
    // "black" stored as "Black" is the user's value, saved.
    return requested.trim().toLowerCase() === stored.trim().toLowerCase();
  }
  if (Array.isArray(requested) || Array.isArray(stored)) {
    const norm = (v: unknown) => (Array.isArray(v) ? v : String(v ?? "").split(","))
      .map((x) => String(x).trim().toLowerCase()).filter(Boolean).sort().join("|");
    return norm(requested) === norm(stored);
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
  action?: "created" | "updated";
  /** A new record: a field is saved when the record holds a value for it
   *  (the create may normalize the value). Updates must hold the new value. */
  presenceOnly?: boolean;
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
    const present = storedValue !== undefined && storedValue !== null && storedValue !== "";
    const verified = !!stored && (input.presenceOnly ? present : receiptValuesMatch(requested, storedValue));
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
    action: input.action || "updated",
  };
}

/** The chat text for a receipt — what the model is told to say, and what the
 *  card shows. ✓ only on verified lines. */
export function formatFieldReceiptText(r: FieldReceipt): string {
  const out: string[] = [];
  for (const l of r.lines) {
    if (l.op === "removed") out.push(`• ${l.label}: removed ${l.verified ? "✓" : "(NOT confirmed — still on the record)"}`);
    else out.push(`• ${l.label}: ${l.display} ${l.verified ? "✓" : "(NOT confirmed on the record)"}`);
  }
  out.push(`Saved to: ${r.savedTo}`);
  return out.join("\n");
}

// ── The chat reply ───────────────────────────────────────────────────────────
//
// The confirmation is BUILT from the receipt, not written by the model: the
// model's wording varies turn to turn and once (2026-11-12) the reply that
// reached the user was a bare "Updated asset "Smoke Car"." Whatever the model
// said about these fields is replaced by this block; anything else it said
// (an answer, a follow-up question, another write) is kept beneath it.

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const countWord = (n: number) => NUMBER_WORDS[n] ?? String(n);
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** "asset profile", "pet profile" — what the user calls the record. */
export function receiptProfileKind(type: string | undefined): string {
  switch (String(type || "")) {
    case "vehicle": case "property": case "asset": case "investment": case "account": return "asset profile";
    case "loan": case "liability": return "liability profile";
    case "subscription": return "subscription profile";
    case "pet": return "pet profile";
    default: return "profile";
  }
}

/** "the asset profile for your **Honda CR-V**" / "your profile". */
function receiptSubject(r: FieldReceipt): string {
  if (r.type === "self") return "your profile";
  const whose = r.ownerName ? `${r.ownerName}'s` : "your";
  return `the ${receiptProfileKind(r.type)} for ${whose} **${r.name}**`;
}

/** A label inside a sentence: "the **color**", "the **VIN**". */
const inlineLabel = (label: string) => (label === label.toUpperCase() ? label : label.charAt(0).toLowerCase() + label.slice(1));

/**
 * The chat message for one receipt. Always says WHAT was saved, WHERE (which
 * record, and where it lives in the app), and that it was read back:
 *
 *   ✅ Saved **Black** as the **color** in the asset profile for your **Honda CR-V**.
 *   📍 Find it in **Assets → Vehicles → Honda CR-V**
 *   Verified — I read it back from your saved record and it matches.
 *
 * Only verified lines are listed as saved. A line that still did not read
 * back after the automatic re-save is named in a plain sentence asking the
 * user to send it again — never shown as saved.
 */
export function receiptReplyBlock(r: FieldReceipt): string {
  const saved = r.lines.filter((l) => l.verified);
  const missing = r.lines.filter((l) => !l.verified);
  const subject = receiptSubject(r);
  const created = r.action === "created";
  const out: string[] = [];

  if (saved.length === 1 && !created) {
    const l = saved[0];
    out.push(l.op === "removed"
      ? `✅ Removed the **${inlineLabel(l.label)}** from ${subject}.`
      : `✅ Saved **${l.display}** as the **${inlineLabel(l.label)}** in ${subject}.`);
  } else {
    const head = created
      ? `✅ Created a new ${receiptProfileKind(r.type)} for ${r.ownerName ? `${r.ownerName}'s` : "your"} **${r.name}**`
      : `✅ Saved ${countWord(saved.length)} details in ${subject}`;
    out.push(saved.length > 0 ? `${head}${created ? ` and saved ${countWord(saved.length)} detail${saved.length === 1 ? "" : "s"}` : ""}:` : `${head}.`);
    if (saved.length > 0) {
      out.push("");
      for (const l of saved) out.push(l.op === "removed" ? `- **${l.label}:** removed ✓` : `- **${l.label}:** ${l.display} ✓`);
    }
  }
  out.push("");
  out.push(`📍 Find it in **${r.savedTo}**`);
  if (saved.length > 0) {
    out.push("");
    out.push(saved.length === 1
      ? "Verified — I read it back from your saved record and it matches."
      : `${saved.length === 2 ? "Both" : `All ${countWord(saved.length)}`} verified — I read them back from your saved record and they match.`);
  }
  if (missing.length > 0) {
    const names = missing.map((l) => `**${inlineLabel(l.label)}**${l.op === "removed" ? "" : ` (${l.display})`}`).join(", ");
    out.push("");
    out.push(`⚠️ I couldn't confirm the ${names} on the record even after saving it again — send ${missing.length === 1 ? "it" : "them"} once more and I'll redo it.`);
  }
  return out.join("\n");
}

/**
 * The model's lines that are ABOUT these receipts — its own field list, its
 * own "saved/updated/verified" sentence about the record, its own "Saved to" —
 * are dropped; everything else it wrote is kept.
 */
function isReceiptRestatement(line: string, receipts: FieldReceipt[]): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/[✓✔✅✗❌]/.test(t)) return true;
  if (/^(?:[-*•]\s*)?(?:📍\s*)?(?:saved\s+to|find\s+it\s+in)\b/i.test(t)) return true;
  if (/\bverif/i.test(t)) return true;
  const lower = t.toLowerCase().replace(/\*/g, "");
  const claimsWrite = /\b(?:updated|saved|changed|set|added|recorded|stored|created|now)\b/.test(lower);
  if (/^(?:i'?ve|i have)\s+(?:saved|updated|stored|added|set|recorded|created)\b/.test(lower)) return true;
  for (const r of receipts) {
    for (const l of r.lines) {
      if (lower.replace(/^[-*•]\s*/, "").startsWith(`${l.label.toLowerCase()}:`)) return true;
      const v = String(l.display || "").toLowerCase();
      if (claimsWrite && v.length >= 3 && lower.includes(v)) return true;
    }
    const name = r.name.toLowerCase();
    if (name && lower.includes(name) && claimsWrite) return true;
  }
  return false;
}

export function composeReceiptReply(receipts: FieldReceipt[], modelReply: string): string {
  const blocks = receipts.filter((r) => r.lines.length > 0 || r.action === "created").map(receiptReplyBlock);
  if (blocks.length === 0) return modelReply;
  const kept = String(modelReply ?? "")
    .split("\n")
    .filter((line) => !isReceiptRestatement(line, receipts))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // A leftover that is only a lead-in ("Here's what I saved:") says nothing.
  const meaningful = kept && !/^[^.!?]*:\s*$/.test(kept) ? kept : "";
  return [blocks.join("\n\n"), meaningful].filter(Boolean).join("\n\n");
}

/** One line for the chat action card: what was saved and where. */
export function receiptCardSummary(r: FieldReceipt): string {
  const saved = r.lines.filter((l) => l.verified);
  const section = r.savedTo.split(" → ").slice(0, -1).join(" → ");
  const where = section ? ` · ${section}` : "";
  let what: string;
  if (saved.length === 0) what = r.action === "created" ? "New profile created" : "Nothing confirmed yet";
  else if (saved.length === 1) {
    const l = saved[0];
    what = l.op === "removed" ? `${l.label} removed` : `${l.label}: ${l.display} saved`;
  } else what = `${saved.length} details saved & verified`;
  const missing = r.lines.length - saved.length;
  return `${what}${where}${missing > 0 ? ` · ${missing} to resend` : ""}`;
}

export function isFieldReceipt(v: unknown): v is FieldReceipt {
  return !!v && typeof v === "object" && Array.isArray((v as any).lines) && typeof (v as any).savedTo === "string" && Array.isArray((v as any).failedKeys);
}
