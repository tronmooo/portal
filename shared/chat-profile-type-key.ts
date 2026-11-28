// The registry type a profile created from chat is filed under.
//
// The screen's create dialog always sends the registry `type_key` the person
// picked (a car is "vehicle"); chat's create_profile sent none, so the same
// car made in chat had type_key null and read differently wherever the type
// comes from type_key (L4; equivalence.asset-ownership, 2026-11-28). Chat
// names a legacy type, sometimes with a subtype; this picks the registry key
// only where the answer is unambiguous, and otherwise leaves it null (never a
// guess between, say, a primary residence and a rental).
const DIRECT: Record<string, string> = {
  vehicle: "vehicle",
  pet: "pet",
  person: "person",
};

/** Registry keys an owned thing can be filed under from a stated subtype. */
export const ASSET_TYPE_KEYS = new Set([
  "vehicle", "motorcycle", "boat", "rv", "aircraft", "electronics", "jewelry",
  "fine_art", "collectible", "musical_instrument", "sporting_equipment",
  "furniture", "appliance", "tool_equipment", "farm_equipment",
  "business_equipment", "intellectual_property", "domain_name", "digital_asset",
  "classic_car", "wine_collection", "firearm",
  "primary_residence", "vacation_home", "rental_property", "commercial_property",
  "raw_land", "timeshare", "storage_facility",
]);

const PROPERTY_KEYS = new Set(["primary_residence", "vacation_home", "rental_property", "commercial_property", "raw_land", "timeshare", "storage_facility"]);

export function chatProfileTypeKey(type: string, fields?: Record<string, unknown> | null): string | null {
  const t = String(type || "").toLowerCase();
  const stated = [fields?.subtype, fields?.assetType, fields?.type_key, fields?.typeKey]
    .map((v) => (typeof v === "string" ? v.trim().toLowerCase().replace(/[\s-]+/g, "_") : ""))
    .find((v) => v && ASSET_TYPE_KEYS.has(v));
  if (stated && (t === "asset" || t === "vehicle" || t === "property")) {
    // A stated subtype must agree with the type it is filed under.
    if (t === "property" && !PROPERTY_KEYS.has(stated)) return null;
    if (t !== "property" && PROPERTY_KEYS.has(stated)) return null;
    return stated;
  }
  return DIRECT[t] ?? null;
}
