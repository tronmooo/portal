import { formatMoneyCents } from "@/lib/format";

// ── Displaying a profile field ───────────────────────────────────────────────
// A profile's `fields` is free-form JSONB. Values arrive as primitives, but
// also as nested objects (an address written by document extraction, a legacy
// AI blob) and as arrays. `String(value)` on any of those renders the literal
// text "[object Object]" — which is what the Info tab was showing for ADDRESS.
//
// This lives here rather than in one page because profile-detail and
// profile-info both render the same values and were drifting: detail had the
// safe stringifier, info did not.

export function formatFieldKey(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim();
}

/**
 * A short, readable preview of a value `stringifyField` cannot render — an
 * empty object, an array of objects, a blob whose leaves are all nested.
 *
 * This exists so such a field stays VISIBLE. Hiding it looks tidier and is
 * worse: the row is also where the delete button lives, so a hidden field is
 * one the user can neither read nor remove, and it sits in the database
 * forever. Showing "{ geo: … }" is honest and keeps the X reachable.
 */
export function previewUnrenderable(value: any): string {
  try {
    const json = JSON.stringify(value);
    if (!json || json === "{}" || json === "[]") return "(empty)";
    return json.length > 44 ? json.slice(0, 43) + "…" : json;
  } catch {
    return "(unreadable)";
  }
}

/** Render any profile field value as text. Never returns "[object Object]". */
export function stringifyField(value: any): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    // Receipt/invoice rows keep their quantity and price; unwrapping them to
    // just the name would silently drop the numbers the user came to read.
    if (isLineItemArray(value)) return formatLineItems(value);
    return value.map((v) => stringifyField(v)).filter(Boolean).join(", ");
  }
  if (typeof value === "object") {
    // A single line item ({ name, quantity, price }) reads better whole than
    // unwrapped to its name — check before the wrapper unwrap below.
    if (isLineItemArray([value])) {
      const line = formatLineItem(value);
      if (line) return line;
    }
    // A wrapper like { value: "M" } or { name: "Progressive" } — unwrap it.
    for (const k of ["value", "name", "label", "display", "text", "title"]) {
      if (value[k] !== undefined && (typeof value[k] === "string" || typeof value[k] === "number")) {
        return String(value[k]);
      }
    }
    // A real composite (an address). Prefer the pieces that read as one line,
    // in postal order, before falling back to labelling whatever is there.
    const ADDRESS_ORDER = ["street", "street1", "line1", "address1", "address", "unit", "apt", "city", "state", "region", "zip", "postalCode", "zipCode", "country"];
    const addressParts = ADDRESS_ORDER
      .map((k) => value[k])
      .filter((v) => typeof v === "string" || typeof v === "number")
      .map((v) => String(v).trim())
      .filter(Boolean);
    if (addressParts.length >= 2) return addressParts.join(", ");

    const entries = Object.entries(value)
      .filter(([, v]) => v !== null && v !== undefined && v !== "" && (typeof v === "string" || typeof v === "number" || typeof v === "boolean"))
      .slice(0, 3)
      .map(([k, v]) => `${formatFieldKey(k)}: ${v}`);
    if (entries.length) return entries.join(", ");
    return "";
  }
  try { return String(value); } catch { return ""; }
}

// ── Line items (receipts, invoices, orders) ──────────────────────────────────
// Extraction writes a receipt's line items as an array of objects, e.g.
//   items: [{ name: "Flat White", quantity: 2, price: 4.5 }, …]
// Every renderer that reached for `String(value)` printed
// "[object Object],[object Object]" for that (user report 2026-09-04). These
// helpers give the array a readable form — and `isLineItemArray` lets a
// renderer with room lay the items out one per row instead of on one line.

const NAME_KEYS = ["name", "description", "item", "title", "label", "product"];
const QTY_KEYS = ["quantity", "qty", "count", "units"];
const PRICE_KEYS = ["price", "amount", "total", "cost", "subtotal", "unitPrice"];

function pick(obj: Record<string, any>, keys: string[]): any {
  for (const k of keys) {
    if (obj[k] !== null && obj[k] !== undefined && obj[k] !== "") return obj[k];
  }
  return undefined;
}

function formatPrice(v: any): string {
  // Keep an already-formatted string ("$4.50", "€3") as the author wrote it —
  // re-parsing it would silently relabel another currency as dollars.
  if (typeof v === "string" && /[^\d.,\s-]/.test(v)) return v.trim();
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(n)) return String(v);
  return formatMoneyCents(n);
}

/** True when `value` is an array whose entries look like receipt/invoice rows. */
export function isLineItemArray(value: any): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (v) => v && typeof v === "object" && !Array.isArray(v) && pick(v, NAME_KEYS) !== undefined,
    )
  );
}

/** One line item as "2 × Flat White — $9.00". Never "[object Object]". */
export function formatLineItem(item: any): string {
  if (!item || typeof item !== "object" || Array.isArray(item)) return stringifyField(item);
  const name = pick(item, NAME_KEYS);
  if (name === undefined) return stringifyField(item);
  const qty = pick(item, QTY_KEYS);
  const price = pick(item, PRICE_KEYS);
  const qtyPart = qty !== undefined && Number(qty) !== 1 ? `${qty} × ` : "";
  const pricePart = price !== undefined ? ` — ${formatPrice(price)}` : "";
  return `${qtyPart}${String(name).trim()}${pricePart}`;
}

/** The whole array on one line, for previews and dense rows. */
export function formatLineItems(value: any[]): string {
  return value.map(formatLineItem).filter(Boolean).join(" · ");
}

// ── Money-typed extracted fields ─────────────────────────────────────────────
// QA 2026-09-18: a receipt's line items read "Iced Latte — $4.75" while the
// totals beside them read "TAX 1.66" and "SUBTOTAL 17.5" — bare numbers,
// because `stringifyField` has no idea what a key means. The key tells us: a
// field named tax / subtotal / total / amount / price / fee … holding a
// number is money, and prints with the same two-decimal formatter the line
// items use. Anything else is untouched.
const MONEY_KEY_RE =
  /(^|[_\s-])(total|subtotal|sub_total|tax|taxes|tip|gratuity|amount|amount_due|amount_paid|price|cost|fee|fees|balance|premium|deductible|copay|co_pay|payment|charge|charges|discount|due|paid|refund|credit|debit|shipping|surcharge|change)([_\s-]|$)/i;
// "taxId", "payment_method", "due_date", "credit_score": the money word names
// something ABOUT the money, not an amount.
const NOT_AMOUNT_RE = /[_\s-](id|number|no|num|code|rate|pct|percent|year|date|day|status|type|method|name|term|terms|score|limit|account|label)([_\s-]|$)/i;

export function isMoneyFieldKey(key: string): boolean {
  if (!key) return false;
  const k = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return MONEY_KEY_RE.test(k) && !NOT_AMOUNT_RE.test(k);
}

/** A number, or a numeric string with money punctuation ("$1,234.50"), as a number; else null. */
function moneyNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const t = value.trim();
    if (!/^-?\$?\s?-?[\d,]*\.?\d+$/.test(t)) return null;
    const n = Number(t.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * `stringifyField`, but a money-keyed numeric value prints as money
 * ("SUBTOTAL 17.5" → "$17.50"). Use wherever a key is known.
 */
export function stringifyFieldFor(key: string, value: any): string {
  if (isMoneyFieldKey(key)) {
    const unwrapped = value && typeof value === "object" && !Array.isArray(value) && "value" in value ? (value as any).value : value;
    const n = moneyNumber(unwrapped);
    if (n !== null) return formatMoneyCents(n);
  }
  return stringifyField(value);
}
