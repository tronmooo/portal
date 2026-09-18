import { createClient } from "@supabase/supabase-js";

// Credentials come from the environment only. Never commit the service-role key:
// it bypasses row-level security for every user in the project.
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || "https://uvaniovwrezzzlzmizyg.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!SUPABASE_SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is not set. Export the Supabase service-role key in the environment before running this script.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function migrate() {
  // Try to select from budgets — if it works, table exists
  const { data, error } = await supabase.from("budgets").select("id").limit(1);
  if (!error) {
    console.log("✓ budgets table already exists");
    return;
  }
  
  if (error.code === "PGRST205" || error.message.includes("budgets")) {
    console.log("Table doesn't exist. Creating via insert approach...");
    
    // We need to create the table. Since we can't run DDL through PostgREST,
    // let's use the Supabase database URL endpoint
    const { data: rpc, error: rpcErr } = await supabase.rpc("create_budgets_table");
    if (rpcErr) {
      console.log("RPC doesn't exist either. Creating via management API...");
      
      // Use the Supabase SQL query API
      const resp = await fetch(`${SUPABASE_URL}/pg/query`, {
        method: "POST",
        headers: {
          "apikey": SUPABASE_SERVICE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: `CREATE TABLE IF NOT EXISTS public.budgets (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL, category TEXT NOT NULL, amount NUMERIC NOT NULL DEFAULT 0, month TEXT NOT NULL, notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(user_id, category, month)); ALTER TABLE public.budgets ENABLE ROW LEVEL SECURITY; CREATE POLICY "budgets_all" ON public.budgets FOR ALL USING (true) WITH CHECK (true);`
        }),
      });
      console.log("Pg response:", resp.status, await resp.text());
    }
  } else {
    console.log("Unexpected error:", error);
  }
}
migrate();
