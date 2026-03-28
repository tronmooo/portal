const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://uvaniovwrezzzlzmizyg.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2YW5pb3Z3cmV6enpsem1penlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDA0MDkyOCwiZXhwIjoyMDg5NjE2OTI4fQ.WO2hjB0q18xHfZ4OYfxsPmN1V-K4526G7rBMCRVy8vI'
);

async function main() {
  console.log("=== Checking current schema state ===");
  
  const checks = [
    { table: 'profiles', col: 'parent_profile_id' },
    { table: 'obligations', col: 'status' },
    { table: 'trackers', col: 'updated_at' },
    { table: 'documents', col: 'updated_at' },
    { table: 'obligation_payments', col: 'created_at' },
  ];
  
  for (const { table, col } of checks) {
    const { error } = await supabase.from(table).select(col).limit(1);
    console.log(`${table}.${col}: ${error ? 'MISSING' : 'EXISTS'}`);
  }
}

main().catch(console.error);
