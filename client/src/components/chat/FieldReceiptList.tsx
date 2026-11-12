// Field-by-field save receipt under a chat action card.
//
// Built server-side from a FRESH database read after the write
// (shared/field-receipt.ts). A green check appears ONLY on a line the
// read-back confirmed; a line that did not land is red and says so. The card
// never shows a check the database didn't back.
import { Check, X } from "lucide-react";
import type { FieldReceipt } from "@shared/field-receipt";

export function isFieldReceipt(v: unknown): v is FieldReceipt {
  return !!v && typeof v === "object" && Array.isArray((v as any).lines) && typeof (v as any).savedTo === "string";
}

export function FieldReceiptList({ receipt, onOpen }: { receipt: FieldReceipt; onOpen?: () => void }) {
  if (receipt.lines.length === 0) return null;
  const failed = receipt.lines.length - receipt.verifiedCount;
  return (
    <div
      className={`mt-1 rounded-xl border px-3 py-2 ${failed > 0 ? "border-amber-500/30 bg-amber-500/5" : "border-green-500/20 bg-green-500/[0.03]"}`}
      data-testid="field-receipt"
    >
      <p className="text-[11px] font-semibold text-muted-foreground mb-1" data-testid="field-receipt-summary">
        {failed === 0
          ? `Saved and verified · ${receipt.verifiedCount} field${receipt.verifiedCount === 1 ? "" : "s"}`
          : `${receipt.verifiedCount} of ${receipt.lines.length} saved · ${failed} did not save`}
      </p>
      <ul className="space-y-0.5">
        {receipt.lines.map((l) => (
          <li
            key={`${l.op || "set"}:${l.key}`}
            className="flex items-start gap-1.5 text-xs"
            data-testid={`field-receipt-line-${l.key}`}
            data-verified={l.verified ? "true" : "false"}
          >
            {l.verified
              ? <Check className="h-3.5 w-3.5 mt-px shrink-0 text-green-600" aria-label="verified" />
              : <X className="h-3.5 w-3.5 mt-px shrink-0 text-red-500" aria-label="not saved" />}
            <span className="min-w-0">
              <span className="text-muted-foreground">{l.label}:</span>{" "}
              <span className={l.verified ? "text-foreground font-medium" : "text-red-600 font-medium"}>
                {l.op === "removed" ? (l.verified ? "removed" : "still on the record") : l.display}
              </span>
              {!l.verified && l.op !== "removed" && <span className="text-red-600"> — not saved</span>}
            </span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="mt-1.5 text-[11px] text-primary hover:underline text-left"
        onClick={onOpen}
        disabled={!onOpen}
        data-testid="field-receipt-saved-to"
      >
        Saved to: {receipt.savedTo}
      </button>
    </div>
  );
}
