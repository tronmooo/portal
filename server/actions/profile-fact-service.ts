// ─── Canonical profile facts ────────────────────────────────────────────────
//
// "My birthday is July 10, 1994" · "John's email is jsmith@…" · "my license
// expires July 18 2034" — these are FACTS ABOUT A RECORD, not notes, events,
// or free text. This service is the single writer for them, whatever door the
// fact arrived through (chat, document extraction, REST profile PATCH).
//
// The core invariant it enforces — THE SOURCE ENTITY OWNS ITS OWN DATES:
// a birthday is written to the profile's dateOfBirth field, an expiration to
// the record that expires. Nothing else is written. The calendar visibility
// is DERIVED: shared/temporal-rules + calendar-adapters turn the canonical
// field into a Date Rule with a deterministic identity (dateRuleKey), so
// telling the app the same fact twice — or through two different doors —
// lands on ONE field and ONE derived rule, never a duplicate. Fix a behavior
// here and every door is fixed at once.
//
// What stays at the doors: deciding that a sentence IS a fact (the chat
// engine's bare-expiry / birthday-label heuristics, extraction's classifier).
// Interpretation is the door's job; consequences are this service's.
import type { IStorage } from "../storage";
import { canonicalizeProfileFields } from "@shared/profile-field-canon";
import { classifyDateField } from "@shared/date-rules";
import { normalizeDateString } from "@shared/extraction-normalize";
import { deriveDateRulesForRecord, type DateRule } from "@shared/temporal-rules";
import { resolveProfileByName } from "../entity-resolver";

export type ProfileFactKind =
  | "birthday"
  | "anniversary"
  | "expiration"
  | "email"
  | "phone"
  | "address"
  /** An explicit field the caller already named (args.field). */
  | "field";

export interface SetProfileFactArgs {
  /** Explicit profile id — extraction/REST doors that already resolved one. */
  profileId?: string;
  /** A profile NAME to resolve (chat's forProfile). Never self-falls-back:
   *  guessing the owner of a fact writes it onto the wrong person. */
  profileRef?: string;
  kind: ProfileFactKind;
  /** The fact's value; date kinds accept anything normalizeDateString reads. */
  value: string;
  /** For "expiration": WHAT expires ("driver's license", "passport") — names
   *  the field so the rule engine classifies it ("driversLicenseExpiration"). */
  subject?: string;
  /** For kind "field": the exact field to write. */
  field?: string;
  /** Rule derivation identity; the door's authenticated user. */
  userId: string;
}

export type SetProfileFactResult = Record<string, any> & {
  error?: string;
  /** Candidate names when the profileRef was ambiguous. */
  candidates?: string[];
};

const DATE_KINDS = new Set<ProfileFactKind>(["birthday", "anniversary", "expiration"]);

/** The canonical field a fact kind writes. */
export function fieldForFact(kind: ProfileFactKind, subject?: string, explicit?: string): string {
  switch (kind) {
    case "birthday": return "dateOfBirth";
    case "anniversary": return "anniversary";
    case "expiration": {
      // Name the field for what it holds so the rule engine can classify it
      // and the profile reads sensibly: "driversLicenseExpiration".
      const cls = classifyDateField("expiration_date", String(subject || ""));
      const prefix = cls.ruleSubtype
        ? cls.ruleSubtype.replace(/_(\w)/g, (_m: string, c: string) => c.toUpperCase())
        : "";
      return prefix ? `${prefix}Expiration` : "expirationDate";
    }
    case "email": return "email";
    case "phone": return "phone";
    case "address": return "address";
    case "field": return String(explicit || "").trim();
  }
}

export async function setProfileFact(
  storage: IStorage,
  args: SetProfileFactArgs,
): Promise<SetProfileFactResult> {
  // 1. Resolve the owning record. Explicit id wins; a name goes through THE
  //    resolver and never guesses on ambiguity.
  let profile: any | null = null;
  if (args.profileId) {
    profile = (await storage.getProfile(args.profileId)) || null;
    if (!profile) return { error: `No profile with id ${args.profileId}.` };
  } else if (args.profileRef) {
    const resolved = resolveProfileByName(await storage.getProfiles(), args.profileRef);
    if (resolved.kind === "found") profile = resolved.profile;
    else if (resolved.kind === "ambiguous") {
      return {
        error: `Several profiles match "${args.profileRef}" — which one did you mean?`,
        candidates: resolved.matches.map((m: any) => m.name),
      };
    } else {
      return { error: `I couldn't find a profile named "${args.profileRef}".` };
    }
  } else {
    return { error: "A profile (id or name) is required — facts are never written to a guessed owner." };
  }

  // 2. The canonical field and value.
  const field = fieldForFact(args.kind, args.subject, args.field);
  if (!field) return { error: "Could not determine which field this fact belongs to." };
  let value: string = String(args.value ?? "").trim();
  if (!value) return { error: "The fact has no value." };
  if (DATE_KINDS.has(args.kind)) {
    const iso = normalizeDateString(value) || (/^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null);
    if (!iso) return { error: `"${args.value}" is not a date I can read (try YYYY-MM-DD).` };
    value = iso;
  }

  // 3. ONE write, onto the record that owns the fact. Merged over the
  //    existing fields through the field canon, exactly as every other
  //    profile-field writer does — the field IS the identity, so restating
  //    the fact updates rather than duplicating.
  const existing: Record<string, any> = profile.fields || {};
  await storage.updateProfile(profile.id, {
    fields: { ...existing, ...canonicalizeProfileFields({ [field]: value }, existing).fields },
  } as any);
  const updated = await storage.getProfile(profile.id);

  // 4. The implied consequence is DERIVED, not written: re-run the rule
  //    engine over the updated record and report what the calendar now
  //    shows. dateRuleKey is a pure function of (user, record, field, type),
  //    so this can never mint a second rule for the same fact.
  let rules: DateRule[] = [];
  try {
    rules = deriveDateRulesForRecord(args.userId, "profile", updated).filter(
      (r) => r.source.field.toLowerCase() === field.toLowerCase() || !DATE_KINDS.has(args.kind),
    );
  } catch { /* rule reporting is best-effort; the field write is the fact */ }

  return {
    savedTo: "profile",
    id: profile.id,
    profileId: profile.id,
    profileName: updated?.name || profile.name,
    field,
    value,
    dateRules: rules,
    note: DATE_KINDS.has(args.kind)
      ? "Saved to the record that owns this date; the calendar and Important Dates derive it."
      : "Saved to the profile.",
  };
}
