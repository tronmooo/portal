// ─── The currency this account's money is shown in ──────────────────────────
//
// Every amount in the app used to be printed with a literal "$" — in the four
// canonical formatters and in ~85 template strings besides — so an account kept
// in pounds or euros read as dollars everywhere, with no setting that could
// change it.
//
// This module is that setting. It decides the SYMBOL and the grouping the
// amounts are rendered with; it does not convert anything. Amounts are stored
// as the user entered them and are shown as the user entered them, which is
// the right behavior for an account kept in one currency and the wrong one for
// an account mixing several — per-account currencies and conversion are a
// larger feature, and this is deliberately not a down payment on pretending to
// have them.
//
// Dependency-free, like lib/timezone.ts, so anything can import it.

const STORAGE_KEY = "portol_currency";
const DEFAULT_CURRENCY = "USD";

/** ISO 4217 shape check — three letters. Rejects anything else at the boundary
 *  so a bad value can never poison every amount in the app. */
export function isValidCurrency(code: string): boolean {
  if (typeof code !== "string" || !/^[A-Za-z]{3}$/.test(code)) return false;
  try {
    new Intl.NumberFormat("en-US", { style: "currency", currency: code.toUpperCase() }).format(1);
    return true;
  } catch {
    return false;
  }
}

let active: string = readStored();

function readStored(): string {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw && isValidCurrency(raw) ? raw.toUpperCase() : DEFAULT_CURRENCY;
  } catch {
    return DEFAULT_CURRENCY;
  }
}

export function getActiveCurrency(): string {
  return active;
}

/**
 * Mirrored to localStorage so the first render after a reload already uses the
 * right symbol instead of flashing dollars while /api/preferences answers.
 */
export function setActiveCurrency(code: string | null): void {
  const next = code && isValidCurrency(code) ? code.toUpperCase() : DEFAULT_CURRENCY;
  if (next === active) return;
  active = next;
  try {
    if (next === DEFAULT_CURRENCY) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch { /* private browsing — the in-memory value still stands */ }
  symbolCache.clear();
  for (const fn of listeners) { try { fn(active); } catch { /* one bad listener must not stop the rest */ } }
}

/** Forget the stored currency — called on sign-out, like every user-scoped key. */
export function clearStoredCurrency(): void {
  active = DEFAULT_CURRENCY;
  symbolCache.clear();
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

const listeners = new Set<(code: string) => void>();
export function subscribeCurrency(fn: (code: string) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

const symbolCache = new Map<string, string>();

/**
 * The symbol to put in front of an amount: "$", "£", "€", "CA$"…
 *
 * Derived from Intl rather than from a hand-kept table, so a currency nobody
 * anticipated still renders as something meaningful. Cached because building a
 * formatter is the expensive part and this is called per row.
 */
export function currencySymbol(code: string = active): string {
  const cached = symbolCache.get(code);
  if (cached !== undefined) return cached;
  let symbol = "$";
  try {
    const parts = new Intl.NumberFormat("en-US", {
      style: "currency", currency: code, currencyDisplay: "narrowSymbol",
    }).formatToParts(0);
    symbol = parts.find((p) => p.type === "currency")?.value ?? code;
  } catch {
    symbol = code;
  }
  symbolCache.set(code, symbol);
  return symbol;
}

/** The currencies offered in Settings. Not a limit — any valid ISO code set
 *  through setActiveCurrency works; this is just the shortlist worth showing. */
export const COMMON_CURRENCIES: Array<{ code: string; label: string }> = [
  { code: "USD", label: "US dollar" },
  { code: "EUR", label: "Euro" },
  { code: "GBP", label: "British pound" },
  { code: "CAD", label: "Canadian dollar" },
  { code: "AUD", label: "Australian dollar" },
  { code: "NZD", label: "New Zealand dollar" },
  { code: "CHF", label: "Swiss franc" },
  { code: "JPY", label: "Japanese yen" },
  { code: "INR", label: "Indian rupee" },
  { code: "SGD", label: "Singapore dollar" },
  { code: "ZAR", label: "South African rand" },
  { code: "MXN", label: "Mexican peso" },
  { code: "BRL", label: "Brazilian real" },
  { code: "SEK", label: "Swedish krona" },
  { code: "NOK", label: "Norwegian krone" },
  { code: "DKK", label: "Danish krone" },
  { code: "PLN", label: "Polish złoty" },
  { code: "AED", label: "UAE dirham" },
];
