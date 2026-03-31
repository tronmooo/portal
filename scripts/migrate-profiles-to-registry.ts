#!/usr/bin/env npx tsx
/**
 * migrate-profiles-to-registry.ts
 *
 * Migrates existing profiles to use type_key from the Profile Type Registry.
 * Fetches all profiles for a given user and sets the type_key field based on
 * the legacy `type` field and name keywords.
 *
 * Run with: npx tsx scripts/migrate-profiles-to-registry.ts
 */

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || "https://uvaniovwrezzzlzmizyg.supabase.co";
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2YW5pb3Z3cmV6enpsem1penlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDA0MDkyOCwiZXhwIjoyMDg5NjE2OTI4fQ.WO2hjB0q18xHfZ4OYfxsPmN1V-K4526G7rBMCRVy8vI";

const TARGET_USER_ID = "6f63cf74-ad8b-42f4-a8de-850f42219c06";

interface Profile {
  id: string;
  name: string;
  type: string;
  type_key?: string | null;
  fields?: Record<string, any>;
}

// ─── Mapping logic ───────────────────────────────────────────────────────────

function mapToTypeKey(profile: Profile): string {
  const type = profile.type?.toLowerCase() ?? "";
  const name = profile.name?.toLowerCase() ?? "";
  const fields = profile.fields ?? {};

  switch (type) {
    case "self":
      return "self";

    case "person":
      return "person";

    case "pet":
      return "pet";

    case "vehicle": {
      // Try to infer vehicle subtype from name/fields
      const make = (fields.make || "").toLowerCase();
      const model = (fields.model || "").toLowerCase();
      const combined = `${name} ${make} ${model}`;
      if (/motorcycle|bike|harley|kawasaki|yamaha|honda cbr/.test(combined)) return "motorcycle";
      if (/rv|camper|motorhome/.test(combined)) return "rv";
      if (/boat|yacht|vessel/.test(combined)) return "boat";
      return "vehicle";
    }

    case "asset": {
      const combined = `${name} ${JSON.stringify(fields)}`.toLowerCase();
      // Phone / laptop / computer / electronics
      if (/iphone|android|phone|smartphone|pixel/.test(combined)) return "smartphone";
      if (/laptop|macbook|thinkpad|chromebook/.test(combined)) return "laptop";
      if (/mac|imac|desktop|computer|pc/.test(combined)) return "desktop_computer";
      if (/tv|television|monitor|display/.test(combined)) return "television";
      if (/headphone|airpod|earbud/.test(combined)) return "headphones";
      if (/camera|dslr/.test(combined)) return "camera";
      if (/watch|smartwatch|apple watch|fitbit|garmin/.test(combined)) return "smartwatch";
      if (/tablet|ipad/.test(combined)) return "tablet";
      if (/tesla|honda|toyota|ford|chevrolet|bmw|audi|car|truck|suv/.test(combined)) return "vehicle";
      if (/guitar|piano|keyboard|violin|instrument/.test(combined)) return "instrument";
      if (/jewelry|ring|necklace|bracelet|gold|diamond/.test(combined)) return "jewelry";
      if (/art|painting|sculpture|collectible/.test(combined)) return "art";
      if (/furniture|sofa|table|chair|desk/.test(combined)) return "furniture";
      // Default for unrecognized assets
      return "electronics";
    }

    case "loan": {
      const combined = `${name} ${JSON.stringify(fields)}`.toLowerCase();
      if (/mortgage|home loan|housing/.test(combined)) return "mortgage";
      if (/auto|car loan|vehicle loan/.test(combined)) return "auto_loan";
      if (/student|education/.test(combined)) return "student_loan";
      if (/business/.test(combined)) return "business_loan";
      if (/credit card/.test(combined)) return "credit_card_debt";
      if (/medical/.test(combined)) return "medical_debt";
      return "personal_loan";
    }

    case "subscription": {
      const combined = `${name} ${JSON.stringify(fields)}`.toLowerCase();
      if (/netflix|hulu|disney|hbo|max|peacock|paramount|apple tv|prime video/.test(combined)) return "streaming_video";
      if (/spotify|apple music|tidal|pandora|deezer/.test(combined)) return "streaming_music";
      if (/gym|planet fitness|crossfit|equinox|gold's|la fitness/.test(combined)) return "gym_membership";
      if (/adobe|microsoft|google workspace|slack|zoom|figma|github|notion|jira/.test(combined)) return "software_saas";
      if (/amazon prime|prime/.test(combined)) return "ecommerce_membership";
      if (/box|subscription box|hello fresh|door dash|meal kit/.test(combined)) return "subscription_box";
      if (/vpn|security|antivirus/.test(combined)) return "security_software";
      if (/cloud|dropbox|icloud|onedrive|google drive/.test(combined)) return "cloud_storage";
      return "streaming_video"; // Generic default for entertainment subs
    }

    case "investment": {
      const combined = `${name} ${JSON.stringify(fields)}`.toLowerCase();
      if (/bitcoin|btc|ethereum|eth|crypto|defi/.test(combined)) return "cryptocurrency";
      if (/401k|403b|ira|roth|pension|retirement/.test(combined)) return "retirement_account";
      if (/stock|share|equity/.test(combined)) return "individual_stock";
      if (/etf|index fund|mutual fund/.test(combined)) return "index_fund";
      if (/bond|treasury|fixed income/.test(combined)) return "bond";
      if (/real estate|reit/.test(combined)) return "real_estate_investment";
      return "brokerage_account";
    }

    case "property": {
      const combined = `${name} ${JSON.stringify(fields)}`.toLowerCase();
      if (/condo|condominium|apartment/.test(combined)) return "condo";
      if (/commercial|office|retail|warehouse/.test(combined)) return "commercial_property";
      if (/land|lot|plot/.test(combined)) return "land";
      if (/vacation|cabin|beach house|airbnb/.test(combined)) return "vacation_property";
      return "primary_residence";
    }

    case "account": {
      const combined = `${name} ${JSON.stringify(fields)}`.toLowerCase();
      if (/checking/.test(combined)) return "checking_account";
      if (/savings/.test(combined)) return "savings_account";
      if (/credit card/.test(combined)) return "credit_card";
      if (/money market/.test(combined)) return "money_market";
      if (/hsa/.test(combined)) return "hsa";
      return "checking_account";
    }

    case "medical":
      return "health_insurance"; // Generic medical profile maps to health insurance or just person

    default:
      return "person"; // Fallback
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function fetchProfiles(): Promise<Profile[]> {
  const url = `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${TARGET_USER_ID}&select=id,name,type,type_key,fields`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch profiles: ${res.status} ${text}`);
  }
  return res.json();
}

async function updateProfile(id: string, type_key: string): Promise<void> {
  const url = `${SUPABASE_URL}/rest/v1/profiles?id=eq.${id}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ type_key }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to update profile ${id}: ${res.status} ${text}`);
  }
}

async function main() {
  console.log(`\n🔄 Migrating profiles for user ${TARGET_USER_ID} to registry type_key...\n`);

  const profiles = await fetchProfiles();
  console.log(`Found ${profiles.length} profiles.\n`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const profile of profiles) {
    // Skip profiles that already have a type_key set
    if (profile.type_key) {
      console.log(`  ⏩ SKIP  [${profile.id}] "${profile.name}" (${profile.type}) → already has type_key: ${profile.type_key}`);
      skipped++;
      continue;
    }

    const type_key = mapToTypeKey(profile);
    try {
      await updateProfile(profile.id, type_key);
      console.log(`  ✅ SET   [${profile.id}] "${profile.name}" (${profile.type}) → ${type_key}`);
      updated++;
    } catch (err: any) {
      console.error(`  ❌ ERROR [${profile.id}] "${profile.name}": ${err.message}`);
      errors++;
    }
  }

  console.log(`\n─────────────────────────────────────────`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Errors:  ${errors}`);
  console.log(`─────────────────────────────────────────\n`);

  if (errors > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
