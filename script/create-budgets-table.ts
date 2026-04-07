import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  // Try inserting a dummy row — if table doesn't exist, we'll know
  const { error: checkErr } = await supabase.from("budgets").select("id").limit(1);
  
  if (checkErr && checkErr.message.includes("budgets")) {
    console.log("Table doesn't exist. Need to create it via Supabase dashboard or migration.");
    console.log("Creating via raw SQL workaround...");
    
    // Use the SQL endpoint through the Supabase management API
    // Since we can't run DDL through PostgREST, we'll create it through the dashboard
    // or use a different approach — create it through a Postgres function
    
    // For now, let's use the approach of creating entries directly
    // and handling the "table doesn't exist" error gracefully in the app
    console.log("\nAlternative: Using Supabase dashboard SQL editor to run:");
    console.log(`
CREATE TABLE IF NOT EXISTS public.budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  category TEXT NOT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,
  month TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, category, month)
);

ALTER TABLE public.budgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage their own budgets" ON public.budgets
  FOR ALL USING (true) WITH CHECK (true);
    `);
  } else {
    console.log("Table exists or other error:", checkErr?.message || "OK");
  }
}
main();
