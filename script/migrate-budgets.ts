import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://uvaniovwrezzzlzmizyg.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2YW5pb3Z3cmV6enpsem1penlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDA0MDkyOCwiZXhwIjoyMDg5NjE2OTI4fQ.WO2hjB0q18xHfZ4OYfxsPmN1V-K4526G7rBMCRVy8vI"
);

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
      const resp = await fetch(`https://uvaniovwrezzzlzmizyg.supabase.co/pg/query`, {
        method: "POST",
        headers: {
          "apikey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2YW5pb3Z3cmV6enpsem1penlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDA0MDkyOCwiZXhwIjoyMDg5NjE2OTI4fQ.WO2hjB0q18xHfZ4OYfxsPmN1V-K4526G7rBMCRVy8vI",
          "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2YW5pb3Z3cmV6enpsem1penlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDA0MDkyOCwiZXhwIjoyMDg5NjE2OTI4fQ.WO2hjB0q18xHfZ4OYfxsPmN1V-K4526G7rBMCRVy8vI",
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
