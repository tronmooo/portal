// Which expenses a profile's Money tab lists — the ONE rule, shared by the
// tab, the hero "Expenses" count and the server's owned sum/count.
//
// A PERSON's page is strict: only expenses that person owns (the first entry
// of `linkedProfiles`). Someone merely co-linked to a purchase must not see it
// as theirs (2026-06-11: "Jane Doe's House purchase $650,000" on Test's page).
//
// A THING's page (asset, vehicle, property, pet, …) lists every expense linked
// to it. An expense is linked to a thing because the money was spent ON it;
// who owns the expense row does not change that. The strict rule applied to
// things hid every expense added from the asset's own page: the row was
// created under the account holder and then linked, giving
// `[self, asset]`, so `[0]` was never the asset (2026-11-19: the expense
// showed in Cash Flow, the dashboard and the asset's Activity tab, but its
// Money tab said "No expenses logged").

const PERSON_TYPES = new Set(["self", "person"]);

export function isPersonProfileType(type: unknown): boolean {
  return PERSON_TYPES.has(String(type ?? "").toLowerCase());
}

export function expenseShownOnProfile(
  expense: { linkedProfiles?: unknown } | null | undefined,
  profileId: string,
  profileType: unknown,
): boolean {
  const linked = Array.isArray(expense?.linkedProfiles) ? (expense!.linkedProfiles as unknown[]) : [];
  if (linked.length === 0 || !profileId) return false;
  if (linked[0] === profileId) return true;
  return !isPersonProfileType(profileType) && linked.includes(profileId);
}
