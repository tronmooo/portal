// Bank CSV parsing — pure, no I/O — for POST /api/import/bank-csv.
//
// Extracted so the sign convention, quoting and date handling are testable
// on their own. The route used to hand every amount straight to the expense
// validator: banks that export spending as NEGATIVE numbers (most of them)
// had every debit rejected with "amount must be a positive number" while the
// one positive row — the paycheck — was imported as an expense.

export interface BankCsvRow {
  /** 1-based data-row index (header excluded), for error messages. */
  row: number;
  date: string;          // YYYY-MM-DD
  description: string;
  amount: number;        // positive; the money that LEFT the account
  category?: string;
}

export interface BankCsvParse {
  rows: BankCsvRow[];
  /** Credits (money in) skipped because they are not expenses. */
  skippedCredits: number;
  /** Rows with no usable amount. */
  skippedEmpty: number;
  errors: string[];
  /** How the file expresses spending: negatives, a debit column, or positives. */
  signConvention: "negative-debits" | "debit-column" | "positive-debits";
}

/** Split one CSV line, honouring double-quoted fields (commas inside stay). */
export function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; continue; } // escaped quote
      inQuotes = !inQuotes; continue;
    }
    if (ch === "," && !inQuotes) { fields.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  fields.push(current.trim());
  return fields;
}

/** "09/01/2026", "2026-09-01", "1 Sep 2026" → YYYY-MM-DD (today if unparseable). */
export function normalizeCsvDate(raw: string, todayISO: string): string {
  const s = String(raw || "").trim();
  if (!s) return todayISO;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;               // already ISO — never re-parse through UTC
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);   // M/D/YYYY (US bank exports)
  if (us) {
    const y = us[3].length === 2 ? 2000 + Number(us[3]) : Number(us[3]);
    return `${y}-${String(us[1]).padStart(2, "0")}-${String(us[2]).padStart(2, "0")}`;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? todayISO : d.toLocaleDateString("en-CA");
}

function parseMoney(raw: string | undefined): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  // "(42.50)" is an accounting negative
  const paren = /^\((.*)\)$/.exec(s);
  const n = parseFloat((paren ? "-" + paren[1] : s).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function parseBankCsv(csv: string, todayISO: string): BankCsvParse | { error: string } {
  const lines = String(csv || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return { error: "CSV must have a header row and at least one data row" };

  const header = parseCsvRow(lines[0]).map(h => h.toLowerCase().replace(/['"]/g, ""));
  const col: { date?: number; amount?: number; debit?: number; credit?: number; description?: number; category?: number } = {};
  header.forEach((h, i) => {
    if (col.date === undefined && /date|posted|trans/.test(h)) col.date = i;
    if (col.debit === undefined && /debit|withdraw|outflow|money out/.test(h)) col.debit = i;
    if (col.credit === undefined && /credit|deposit|inflow|money in/.test(h)) col.credit = i;
    if (col.amount === undefined && /^amount$|amount|sum|total/.test(h) && !/debit|credit/.test(h)) col.amount = i;
    if (col.description === undefined && /desc|memo|narr|detail|merchant|payee|name/.test(h)) col.description = i;
    if (col.category === undefined && /^cat|category|type|class/.test(h)) col.category = i;
  });
  if (col.amount === undefined && col.debit === undefined) {
    return { error: "Could not detect an amount column in the CSV header" };
  }

  const data = lines.slice(1).map(parseCsvRow);
  // Sign convention: a separate debit column wins; otherwise, if ANY amount in
  // the file is negative, negatives are the debits (money out) and positives
  // are credits; a file with only positives lists spending as positive.
  const useDebitColumn = col.debit !== undefined && (col.amount === undefined || col.credit !== undefined);
  const anyNegative = !useDebitColumn && data.some(f => (parseMoney(f[col.amount!]) ?? 0) < 0);
  const signConvention: BankCsvParse["signConvention"] = useDebitColumn ? "debit-column" : anyNegative ? "negative-debits" : "positive-debits";

  const out: BankCsvParse = { rows: [], skippedCredits: 0, skippedEmpty: 0, errors: [], signConvention };
  data.forEach((fields, idx) => {
    const row = idx + 1;
    let amount: number | null;
    if (useDebitColumn) {
      const debit = parseMoney(fields[col.debit!]);
      const credit = col.credit !== undefined ? parseMoney(fields[col.credit]) : null;
      if ((debit == null || debit === 0) && credit) { out.skippedCredits++; return; }
      amount = debit == null ? null : Math.abs(debit);
    } else {
      const n = parseMoney(fields[col.amount!]);
      if (n == null || n === 0) { out.skippedEmpty++; return; }
      if (anyNegative) {
        if (n > 0) { out.skippedCredits++; return; }
        amount = -n;
      } else {
        amount = n;
      }
    }
    if (amount == null || !(amount > 0)) { out.skippedEmpty++; return; }
    const description = (col.description !== undefined ? fields[col.description] : "") || `Row ${row}`;
    out.rows.push({
      row,
      date: normalizeCsvDate(col.date !== undefined ? fields[col.date] : "", todayISO),
      description: description.slice(0, 200),
      amount,
      category: col.category !== undefined ? fields[col.category] || undefined : undefined,
    });
  });
  return out;
}

/** Key an expense for "already imported" detection: same day, cents and text. */
export function expenseDedupeKey(e: { date?: string | null; amount?: number | null; description?: string | null }): string {
  return `${String(e.date || "").slice(0, 10)}|${(Number(e.amount) || 0).toFixed(2)}|${String(e.description || "").trim().toLowerCase()}`;
}
