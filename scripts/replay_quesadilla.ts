import "dotenv/config";
import { SupabaseStorage } from "../server/supabase-storage.js";
import { requestStorageContext } from "../server/storage.js";
import { processMessage } from "../server/ai-engine.js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const USER_ID      = process.env.QA_USER_ID || "05df1674-ed60-4aad-80c6-e63eb7225a45";

const storage = new SupabaseStorage(SUPABASE_URL, SERVICE_KEY, USER_ID);

(async () => {
  const msg = "I ate a chicken quesadilla and so did Jim";
  console.log(`MSG: ${msg}`);
  const result = await requestStorageContext.run(storage as any, async () => {
    return processMessage(msg, [], USER_ID);
  });
  console.log("\n========== REPLY ==========");
  console.log((result as any).reply);
  console.log("\n========== /REPLY ==========");
  process.exit(0);
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
