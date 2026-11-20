// The chat's confirmation of a debt payment, built from what was STORED.
//
// The model used to write this sentence itself, doing its own arithmetic:
// "$100 on Discover → new balance $1,150" while the record held $1,173.85
// (part of the payment was interest), and "New balance: $2,671.64" for a
// payment that had not been recorded at all (2026-11-20). The line below is
// composed from the ledger row and a read-back of the balance, and the
// model's own balance / "recorded" sentences are dropped in its favour.
//
// Pure, no I/O. Pinned by tests/chat-payment-recorded.test.ts.

const usd = (n: number) =>
  `$${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface PaymentReceiptInput {
  liabilityName: string;
  amount: number;
  principal?: number | null;
  interest?: number | null;
  /** The balance read back from the record after the write; null for a bill with no balance. */
  balanceAfter?: number | null;
}

/** "Recorded $100.00 on Discover It — $76.15 to principal, $23.85 interest. Balance is now $1,173.85." */
export function paymentReceiptLine(p: PaymentReceiptInput): string {
  let line = `Recorded ${usd(p.amount)} on ${p.liabilityName}`;
  const principal = Number(p.principal) || 0;
  const interest = Number(p.interest) || 0;
  if (interest > 0.004) line += ` — ${usd(principal)} to principal, ${usd(interest)} interest`;
  line += ".";
  if (p.balanceAfter != null && Number.isFinite(Number(p.balanceAfter))) line += ` Balance is now ${usd(Number(p.balanceAfter))}.`;
  return line;
}

/** The line for a payment that was NOT written because it repeats one recorded moments ago. */
export function paymentNotRecordedLine(liabilityName: string, amount: number, balance: number | null | undefined): string {
  const bal = balance != null && Number.isFinite(Number(balance)) ? ` The balance is still ${usd(Number(balance))}.` : "";
  return `No new payment was recorded on ${liabilityName}: the same ${usd(amount)} payment was already recorded moments ago.${bal} If this is a second, separate payment, say so and I'll add it.`;
}

// A sentence of the model's that states a balance or announces the payment —
// exactly what the server's line replaces.
const RESTATES_PAYMENT = /\bbalance\b|\bnow owe\b|\bleft to pay\b|\b(recorded|logged|applied|posted)\b[^.!?\n]*\bpayment\b|\bpayment\b[^.!?\n]*\b(recorded|logged|applied|posted)\b|\bpaid \$[\d,.]+|\bcreated liability\b/i;

/** The reply with the server's payment lines first and the model's own balance / "recorded" sentences removed. */
export function composePaymentReply(lines: readonly string[], modelReply: string): string {
  const mine = lines.filter(Boolean);
  if (mine.length === 0) return modelReply;
  const kept = String(modelReply ?? "")
    .split("\n")
    .map((row) => row
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => !RESTATES_PAYMENT.test(sentence))
      .join(" "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const meaningful = kept && !/^[^.!?]*:\s*$/.test(kept) && /[\p{L}\p{N}]/u.test(kept) ? kept : "";
  return [mine.join("\n"), meaningful].filter(Boolean).join("\n\n");
}
