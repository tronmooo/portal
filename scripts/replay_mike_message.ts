// Replay the EXACT user message through processMessage() to see whether
// Sonnet emits tool_use blocks or just chats. This calls the same code path
// that runs in production /api/chat.
import "dotenv/config";
import { SupabaseStorage } from "../server/supabase-storage.js";
import { requestStorageContext } from "../server/storage.js";
import { processMessage } from "../server/ai-engine.js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL!;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const USER_ID      = process.env.QA_USER_ID || "05df1674-ed60-4aad-80c6-e63eb7225a45";

const storage = new SupabaseStorage(SUPABASE_URL, SERVICE_KEY, USER_ID);

async function run() {
  const msg = "Mike ate a chicken sandwich. He ran 5 miles. He played guitar for 30 minutes. I play video games for 45 minutes.";
  console.log("============================================================");
  console.log("MESSAGE:", msg);
  console.log("============================================================");
  const result = await requestStorageContext.run(
    storage as any,
    async () => await processMessage(msg, [], USER_ID)
  );
  console.log("\n--- RESULT SUMMARY ---");
  console.log("reply:", result.reply);
  console.log("actions count:", (result as any).actions?.length || 0);
  console.log("actions:", JSON.stringify((result as any).actions || [], null, 2).slice(0, 4000));
  console.log("model used:", (result as any).model || "n/a");
}

run().catch(e => { console.error("ERROR:", e); process.exit(1); });
