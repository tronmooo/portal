const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://uvaniovwrezzzlzmizyg.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2YW5pb3Z3cmV6enpsem1penlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDA0MDkyOCwiZXhwIjoyMDg5NjE2OTI4fQ.WO2hjB0q18xHfZ4OYfxsPmN1V-K4526G7rBMCRVy8vI',
  { db: { schema: 'public' } }
);

async function runSQL(sql, label) {
  try {
    const { data, error } = await supabase.rpc('exec_migration', { sql_text: sql });
    if (error) {
      console.log(`❌ ${label}: ${error.message}`);
      return false;
    }
    console.log(`✅ ${label}`);
    return true;
  } catch (e) {
    console.log(`❌ ${label}: ${e.message}`);
    return false;
  }
}

async function main() {
  // First create the exec helper function
  const createFunc = `
    CREATE OR REPLACE FUNCTION exec_migration(sql_text TEXT) RETURNS void AS $$
    BEGIN
      EXECUTE sql_text;
    END;
    $$ LANGUAGE plpgsql SECURITY DEFINER;
  `;
  
  // Try to create the function via a raw query approach
  // Since we can't do raw SQL, let's use a different approach:
  // Create it via the REST API raw endpoint
  
  const resp = await fetch('https://uvaniovwrezzzlzmizyg.supabase.co/rest/v1/rpc/exec_migration', {
    method: 'POST',
    headers: {
      'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2YW5pb3Z3cmV6enpsem1penlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDA0MDkyOCwiZXhwIjoyMDg5NjE2OTI4fQ.WO2hjB0q18xHfZ4OYfxsPmN1V-K4526G7rBMCRVy8vI',
      'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2YW5pb3Z3cmV6enpsem1penlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDA0MDkyOCwiZXhwIjoyMDg5NjE2OTI4fQ.WO2hjB0q18xHfZ4OYfxsPmN1V-K4526G7rBMCRVy8vI',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ sql_text: 'SELECT 1' })
  });
  const text = await resp.text();
  console.log("exec_migration function status:", resp.status, text.slice(0, 200));
  
  if (resp.status === 404 || resp.status === 400) {
    console.log("\nNeed to create exec_migration function first.");
    console.log("Please run this SQL in the Supabase SQL Editor:");
    console.log(createFunc);
  }
}

main().catch(console.error);
