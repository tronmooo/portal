// Where a profile is LISTED — the screen its page's Back button returns to,
// and the screen the app returns to after the profile is deleted.
//
// One rule for both. Deleting an asset used to drop the user on `/profiles`
// (the Info tab, which never listed it) while the same page's Back button
// went to Assets (owner report 2026-11-21: "when I deleted an asset profile it
// just went to the profiles … whenever I delete something I want it to go
// back to where it was"). Liabilities have their own page and return to
// `/linked?tab=liabilities` (rule L7).
// *Guard:* tests/delete-returns-to-listing.test.ts.

const ASSET_TYPES = ["vehicle", "asset", "investment", "property"];
const LINKED_TYPES = ["subscription", "loan", "insurance"];

export interface ProfileListing {
  /** Hash route; may carry a query — navigate with hashNavigate. */
  href: string;
  /** "Back to Assets". */
  label: string;
}

export function profileListing(type: string | null | undefined): ProfileListing {
  const t = String(type || "");
  if (ASSET_TYPES.includes(t)) return { href: "/linked?tab=assets", label: "Back to Assets" };
  if (LINKED_TYPES.includes(t)) return { href: "/linked", label: "Back to Linked" };
  return { href: "/profiles", label: "Back to Profiles" };
}
