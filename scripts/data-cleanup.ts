/**
 * Portol Data Cleanup Script
 * Fixes: test data, bad profile links, garbage values, duplicate profiles
 */

const SB_URL = "https://uvaniovwrezzzlzmizyg.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2YW5pb3Z3cmV6enpsem1penlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDA0MDkyOCwiZXhwIjoyMDg5NjE2OTI4fQ.WO2hjB0q18xHfZ4OYfxsPmN1V-K4526G7rBMCRVy8vI";
const USER_ID = "6f63cf74-ad8b-42f4-a8de-850f42219c06";

const headers = {
  "apikey": SB_KEY,
  "Authorization": `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
  "Prefer": "return=minimal",
};

async function sbGet(table: string, query = "") {
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${query}`, { headers });
  return res.json();
}

async function sbPatch(table: string, query: string, body: any) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${query}`, {
    method: "PATCH", headers, body: JSON.stringify(body),
  });
  if (!res.ok) console.error(`  PATCH ${table} failed:`, await res.text());
  return res.ok;
}

async function sbDelete(table: string, query: string) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${query}`, {
    method: "DELETE", headers,
  });
  if (!res.ok) console.error(`  DELETE ${table} failed:`, await res.text());
  return res.ok;
}

async function main() {
  const profiles: any[] = await sbGet("profiles", `user_id=eq.${USER_ID}&select=*`);
  const trackers: any[] = await sbGet("trackers", `user_id=eq.${USER_ID}&select=*`);
  const goals: any[] = await sbGet("goals", `user_id=eq.${USER_ID}&select=*`);
  
  const profileMap = Object.fromEntries(profiles.map(p => [p.id, p]));
  const selfProfile = profiles.find(p => p.type === "self");
  
  console.log(`\nLoaded: ${profiles.length} profiles, ${trackers.length} trackers, ${goals.length} goals\n`);
  
  // ============================================================
  // 1. DELETE TEST TRACKERS
  // ============================================================
  console.log("=== 1. DELETING TEST TRACKERS ===");
  const testTrackerNames = ["WeightTest", "HydroTest", ""];
  for (const t of trackers) {
    if (testTrackerNames.includes(t.name)) {
      console.log(`  Deleting tracker: "${t.name}" (${t.id})`);
      // Delete entries first
      await sbDelete("tracker_entries", `tracker_id=eq.${t.id}`);
      await sbDelete("trackers", `id=eq.${t.id}`);
    }
  }
  
  // ============================================================
  // 2. FIX TRACKER-PROFILE LINKS (remove wrong types)
  // ============================================================
  console.log("\n=== 2. FIXING TRACKER-PROFILE LINKS ===");
  
  // Trackers that should ONLY be linked to person/self profiles (health trackers)
  const healthTrackerNames = [
    "Blood Pressure", "Blood Pressure Systolic", "Blood Pressure Diastolic",
    "Weight", "Calories", "Medication", "Heart Rate", "Body Temperature",
    "Height", "Hydration", "Water Intake", "Sleep", "Running",
  ];
  
  for (const t of trackers) {
    if (!t.linked_profiles || t.linked_profiles.length === 0) continue;
    
    const isHealthTracker = healthTrackerNames.some(n => t.name.toLowerCase() === n.toLowerCase()) 
      || t.category === "health" || t.category === "fitness" || t.category === "nutrition" || t.category === "sleep";
    
    if (isHealthTracker) {
      // Remove links to vehicles, loans, subscriptions, assets
      const badTypes = ["vehicle", "loan", "subscription", "asset", "property", "investment"];
      const cleanedLinks = t.linked_profiles.filter((pid: string) => {
        const profile = profileMap[pid];
        if (!profile) return false;
        if (badTypes.includes(profile.type)) {
          console.log(`  Removing ${profile.name} (${profile.type}) from tracker "${t.name}"`);
          return false;
        }
        return true;
      });
      
      // For Weight/Calories — remove pet links (pets shouldn't have human trackers)
      if (["Weight", "Calories"].includes(t.name)) {
        const finalLinks = cleanedLinks.filter((pid: string) => {
          const profile = profileMap[pid];
          if (profile?.type === "pet") {
            console.log(`  Removing pet ${profile.name} from tracker "${t.name}"`);
            return false;
          }
          return true;
        });
        if (JSON.stringify(finalLinks) !== JSON.stringify(t.linked_profiles)) {
          // Keep at least self profile
          const result = finalLinks.length > 0 ? finalLinks : (selfProfile ? [selfProfile.id] : []);
          await sbPatch("trackers", `id=eq.${t.id}`, { linked_profiles: result });
          console.log(`  → Updated "${t.name}" links: ${result.length} profiles`);
        }
      } else if (JSON.stringify(cleanedLinks) !== JSON.stringify(t.linked_profiles)) {
        const result = cleanedLinks.length > 0 ? cleanedLinks : (selfProfile ? [selfProfile.id] : []);
        await sbPatch("trackers", `id=eq.${t.id}`, { linked_profiles: result });
        console.log(`  → Updated "${t.name}" links: ${result.length} profiles`);
      }
    }
    
    // Blood test trackers linked to Luna (pet) should go to Jane Doe or self
    if (["White Blood Cells", "Hemoglobin", "Platelets", "LDL Cholesterol", "Triglycerides", "Total Cholesterol"].includes(t.name)) {
      const lunaId = profiles.find(p => p.name === "Luna" && p.type === "pet")?.id;
      if (lunaId && t.linked_profiles.includes(lunaId)) {
        // These are human lab tests — link to Jane Doe (they came from her lab report)
        const janeDoe = profiles.find(p => p.name === "Jane Doe");
        const newLinks = janeDoe ? [janeDoe.id] : (selfProfile ? [selfProfile.id] : []);
        console.log(`  Moving lab tracker "${t.name}" from Luna (pet) to ${janeDoe?.name || 'Me'}`);
        await sbPatch("trackers", `id=eq.${t.id}`, { linked_profiles: newLinks });
      }
    }
  }
  
  // ============================================================
  // 3. CLEAN UP "Me" PROFILE FIELDS
  // ============================================================
  console.log("\n=== 3. CLEANING 'Me' PROFILE FIELDS ===");
  if (selfProfile) {
    const fields = selfProfile.fields || {};
    // Remove raw driver's license fields that shouldn't display
    const cleanFields: any = {};
    const removeKeys = ["class", "donor", "property", "provider", "patientId"];
    let changed = false;
    for (const [k, v] of Object.entries(fields)) {
      if (removeKeys.includes(k)) {
        console.log(`  Removing field "${k}: ${v}" from Me profile`);
        changed = true;
      } else {
        cleanFields[k] = v;
      }
    }
    if (changed) {
      await sbPatch("profiles", `id=eq.${selfProfile.id}`, { fields: cleanFields });
      console.log(`  → Updated Me profile fields`);
    }
  }
  
  // ============================================================
  // 4. DELETE DUPLICATE "Buddy" PETS (keep the one with most data)
  // ============================================================
  console.log("\n=== 4. DEDUPLICATING PROFILES ===");
  const buddies = profiles.filter(p => p.name === "Buddy" && p.type === "pet");
  if (buddies.length > 1) {
    // Keep the one with the most fields
    const sorted = buddies.sort((a, b) => Object.keys(b.fields || {}).length - Object.keys(a.fields || {}).length);
    const keep = sorted[0];
    console.log(`  Keeping Buddy (${keep.id.slice(0,8)}) with ${Object.keys(keep.fields || {}).length} fields`);
    for (const dup of sorted.slice(1)) {
      console.log(`  Deleting duplicate Buddy (${dup.id.slice(0,8)}) with ${Object.keys(dup.fields || {}).length} fields`);
      await sbDelete("profiles", `id=eq.${dup.id}`);
    }
  }
  
  // ============================================================
  // 5. DELETE TEST PROFILES
  // ============================================================
  console.log("\n=== 5. CLEANING TEST PROFILES ===");
  const testNames = ["Craig Isolation Test", "QA Test Person", "QA Test Car", "Honda Isolation Car", "Rex Isolation Dog", "Test Person", "Test Person 2"];
  for (const name of testNames) {
    const p = profiles.find(pr => pr.name === name);
    if (p) {
      console.log(`  Deleting test profile: "${name}" (${p.type})`);
      await sbDelete("profiles", `id=eq.${p.id}`);
    }
  }
  
  // ============================================================
  // 6. FIX GOALS — remove broken ones
  // ============================================================
  console.log("\n=== 6. FIXING GOALS ===");
  for (const g of goals) {
    const title = g.title || "";
    // Delete "Test Add Goal 2" — test data
    if (title.includes("Test Add Goal")) {
      console.log(`  Deleting test goal: "${title}"`);
      await sbDelete("goals", `id=eq.${g.id}`);
    }
  }
  
  // ============================================================
  // 7. FIX BAD TRACKER ENTRIES (400cm height, etc.)
  // ============================================================
  console.log("\n=== 7. FIXING BAD TRACKER ENTRIES ===");
  const heightTracker = trackers.find(t => t.name === "Height" && t.user_id === USER_ID);
  if (heightTracker) {
    const entries: any[] = await sbGet("tracker_entries", `tracker_id=eq.${heightTracker.id}&select=*`);
    for (const e of entries) {
      const vals = e.entry_values || {};
      for (const [k, v] of Object.entries(vals)) {
        if (typeof v === "number" && (v > 300 || v <= 0)) {
          console.log(`  Deleting unrealistic height entry: ${v} cm`);
          await sbDelete("tracker_entries", `id=eq.${e.id}`);
        }
      }
    }
  }
  
  console.log("\n=== CLEANUP COMPLETE ===\n");
}

main().catch(console.error);
