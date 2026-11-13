// ── Save → read back → re-save → read back ──────────────────────────────────
//
// Owner rule (2026-11-12): everything the user tells the chat is saved, and
// nothing is called saved unless a FRESH read of the record holds it. This is
// the one place a chat profile write is checked:
//
//   1. read the profile back from the database;
//   2. any requested field the read-back does not hold is written AGAIN —
//      just that field, as a patch — up to MAX_RESAVES times, re-reading
//      after each attempt;
//   3. the receipt (shared/field-receipt) is built from the LAST read.
//
// A transient write loss (a concurrent form save, a dropped request) is
// repaired before the user hears about it; the chat never shows a field as
// saved that the database does not hold.
//
// Pinned by tests/chat-save-verify-confirm.test.ts.
import { buildFieldReceipt, type BuildFieldReceiptInput, type FieldReceipt } from "@shared/field-receipt";

const MAX_RESAVES = 2;

type ProfileStore = {
  getProfile(id: string): Promise<any | undefined>;
  updateProfile(id: string, changes: any): Promise<any | undefined>;
};

export async function verifyProfileWrite(
  storage: ProfileStore,
  input: Omit<BuildFieldReceiptInput, "stored">,
): Promise<{ receipt: FieldReceipt; readBack: any | null }> {
  const read = async () => { try { return (await storage.getProfile(input.profileId)) ?? null; } catch { return null; } };
  let readBack = await read();
  let receipt = buildFieldReceipt({ ...input, stored: readBack });
  let retried = false;

  for (let attempt = 0; attempt < MAX_RESAVES && receipt.failedKeys.length > 0; attempt++) {
    const failed = new Set(receipt.failedKeys);
    const patch: any = {};
    const fields: Record<string, any> = {};
    for (const [k, v] of Object.entries(input.requestedFields || {})) if (failed.has(k)) fields[k] = v;
    if (Object.keys(fields).length > 0) patch.fields = fields;
    const removes = (input.removedFields || []).filter((k) => failed.has(k));
    if (removes.length > 0) patch.fieldsToDelete = removes;
    if (failed.has("name") && input.requestedName) patch.name = input.requestedName;
    if (failed.has("notes") && input.requestedNotes != null) patch.notes = input.requestedNotes;
    if (Object.keys(patch).length === 0) break;
    retried = true;
    try { await storage.updateProfile(input.profileId, patch); } catch { /* the read below decides */ }
    readBack = await read();
    receipt = buildFieldReceipt({ ...input, stored: readBack });
  }
  if (retried) receipt.retried = true;
  return { receipt, readBack };
}
