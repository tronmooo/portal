// shared/entity-nouns.ts — ONE noun per entity, for card and prose alike.
//
// Why this exists (user report, 2026-08-20): the chat answered
//   'Updated asset "John Hancock".'
// for a PERSON. The card above it said "Update Profile". Two different pieces
// of code were naming the same write, and neither of them looked at the row.
//
// `groundedSummary` (shared/ai-claim-check) took its noun from the intent
// table, where every profile tool maps to the entity `asset` — a deliberate
// choice there, because assets and profiles are one table and the intent gate
// treats them as interchangeable. That is right for GATING and wrong for
// SPEAKING: the user does not care which table John lives in.
//
// So the noun comes from the row's own `type`, from here, and both the client
// card (client/src/pages/chat.tsx actionLabel) and the server summary import
// it. Pure, dependency-free.

/**
 * The human noun for a profile row of this `type`, or null when the type is
 * unknown — callers fall back to their own generic wording rather than
 * guessing "asset", which is how the reported bug read.
 *
 * Assets/vehicles/properties/investments are profile rows too, so a truck is
 * an "Asset" and never a "Profile"; a person is a "Person" and never an
 * "asset".
 */
export function profileNoun(type: unknown): string | null {
  const kind = String(type ?? "").trim().toLowerCase();
  if (!kind) return null;
  switch (kind) {
    case "person": return "Person";
    case "self": return "Person";
    case "pet": return "Pet";
    case "subscription": return "Subscription";
    case "vehicle":
    case "property":
    case "asset":
    case "investment":
      return "Asset";
    case "liability":
    case "loan":
      return "Liability";
    case "account": return "Account";
    case "medical": return "Medical record";
    default: return null;
  }
}

/** Lowercase form for mid-sentence prose ("Updated the person …"). */
export function profileNounLower(type: unknown): string | null {
  const n = profileNoun(type);
  return n ? n.toLowerCase() : null;
}
