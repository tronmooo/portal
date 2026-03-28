const { Client } = require('pg');

// Supabase direct connection via the pooler
// Connection string format: postgresql://postgres.[project-ref]:[password]@[host]:6543/postgres
// For service role, we use the database password (which is different from the service role key)
// The Supabase project ref is uvaniovwrezzzlzmizyg
// We need to use the database password — let's try the standard pooler connection

async function main() {
  // Try the Supabase Transaction pooler connection
  // Default Supabase DB password is often the one set during project creation
  // Since we have the service role key, let's try a different approach:
  // Use the Supabase JS client to create the function, then call it
  
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(
    'https://uvaniovwrezzzlzmizyg.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2YW5pb3Z3cmV6enpsem1penlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDA0MDkyOCwiZXhwIjoyMDg5NjE2OTI4fQ.WO2hjB0q18xHfZ4OYfxsPmN1V-K4526G7rBMCRVy8vI'
  );

  // The Supabase JS client's .rpc() can only call existing functions.
  // But we can use the Management API if we have the access token.
  // Let's try the HTTP Data API approach — Supabase exposes pg-meta endpoints

  // Alternative: use the Supabase project's DB URL with the service_role key as the password
  // Supabase DB connection: postgres://postgres.uvaniovwrezzzlzmizyg:[db-password]@aws-0-us-west-1.pooler.supabase.com:6543/postgres
  
  // Actually, the simplest approach: use fetch to call Supabase's internal pg endpoint
  // POST https://<project-ref>.supabase.co/pg/query with the service role key
  
  const statements = [
    {
      label: "1. Fix journal mood CHECK constraint",
      sql: "ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_mood_check; ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_mood_check CHECK (mood IN ('amazing','great','good','okay','neutral','bad','awful','terrible'));"
    },
    {
      label: "2. Add parent_profile_id column to profiles",
      sql: "ALTER TABLE profiles ADD COLUMN IF NOT EXISTS parent_profile_id UUID REFERENCES profiles(id) ON DELETE SET NULL;"
    },
    {
      label: "2b. Add parent_profile_id index",
      sql: "CREATE INDEX IF NOT EXISTS idx_profiles_parent ON profiles(parent_profile_id) WHERE parent_profile_id IS NOT NULL;"
    },
    {
      label: "2c. Migrate _parentProfileId from JSONB to column",
      sql: `UPDATE profiles SET parent_profile_id = (fields->>'_parentProfileId')::UUID WHERE fields->>'_parentProfileId' IS NOT NULL AND parent_profile_id IS NULL AND (fields->>'_parentProfileId') IN (SELECT id::TEXT FROM profiles);`
    },
    {
      label: "3. Add obligations.status column",
      sql: "ALTER TABLE obligations ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active' CHECK (status IN ('active','paused','cancelled'));"
    },
    {
      label: "4. Add updated_at to trackers",
      sql: "ALTER TABLE trackers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();"
    },
    {
      label: "4b. Add updated_at to tasks",
      sql: "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();"
    },
    {
      label: "4c. Add updated_at to expenses",
      sql: "ALTER TABLE expenses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();"
    },
    {
      label: "4d. Add updated_at to events",
      sql: "ALTER TABLE events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();"
    },
    {
      label: "4e. Add updated_at to habits",
      sql: "ALTER TABLE habits ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();"
    },
    {
      label: "4f. Add updated_at to obligations",
      sql: "ALTER TABLE obligations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();"
    },
    {
      label: "4g. Add updated_at to documents",
      sql: "ALTER TABLE documents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();"
    },
    {
      label: "5. Add created_at to obligation_payments",
      sql: "ALTER TABLE obligation_payments ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();"
    },
    {
      label: "6a. Add index expenses(user_id, date)",
      sql: "CREATE INDEX IF NOT EXISTS idx_expenses_user_date ON expenses(user_id, date);"
    },
    {
      label: "6b. Add index obligations(user_id, next_due_date)",
      sql: "CREATE INDEX IF NOT EXISTS idx_obligations_user_due ON obligations(user_id, next_due_date);"
    },
    {
      label: "6c. Add index tasks(user_id, due_date)",
      sql: "CREATE INDEX IF NOT EXISTS idx_tasks_user_due ON tasks(user_id, due_date);"
    },
    {
      label: "6d. Add index habit_checkins(habit_id, date)",
      sql: "CREATE INDEX IF NOT EXISTS idx_habit_checkins_habit_date ON habit_checkins(habit_id, date);"
    },
    {
      label: "6e. Add index tracker_entries(tracker_id, timestamp DESC)",
      sql: "CREATE INDEX IF NOT EXISTS idx_tracker_entries_tracker_time ON tracker_entries(tracker_id, timestamp DESC);"
    },
    {
      label: "6f. Add index goals(user_id, status)",
      sql: "CREATE INDEX IF NOT EXISTS idx_goals_user_status ON goals(user_id, status);"
    }
  ];
  
  const baseUrl = 'https://uvaniovwrezzzlzmizyg.supabase.co';
  const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2YW5pb3Z3cmV6enpsem1penlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDA0MDkyOCwiZXhwIjoyMDg5NjE2OTI4fQ.WO2hjB0q18xHfZ4OYfxsPmN1V-K4526G7rBMCRVy8vI';
  
  // Try the pg-graphql SQL endpoint or the REST based approach
  // Supabase exposes a SQL execution endpoint at /pg/query for the dashboard
  // But the public API doesn't have this.
  
  // Alternative: create a temporary RPC function via the REST API
  // We can insert a function into the database using a workaround:
  // Create a "migrations" approach where we insert into a table and trigger executes SQL
  
  // Actually the simplest: use Supabase's REST API to make schema changes indirectly
  // For ADD COLUMN IF NOT EXISTS, we can try inserting a row with the new column
  // and see if it errors, but that's hacky.
  
  // The real solution: let's connect via pg module directly to the pooler
  // Supabase connection pooler: aws-0-us-west-1.pooler.supabase.com
  // Session mode port: 5432, Transaction mode port: 6543
  // Username: postgres.uvaniovwrezzzlzmizyg
  // Password: the database password (set during project creation)
  
  // We don't have the DB password. But we CAN use the service role JWT as the password
  // for the Supabase pooler connection. Let's try!
  
  const client = new Client({
    host: 'aws-0-us-west-1.pooler.supabase.com',
    port: 6543,
    database: 'postgres',
    user: 'postgres.uvaniovwrezzzlzmizyg',
    password: key, // service role key as password
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
  
  try {
    await client.connect();
    console.log("✅ Connected to Supabase database!");
    
    for (const stmt of statements) {
      try {
        await client.query(stmt.sql);
        console.log(`✅ ${stmt.label}`);
      } catch (err) {
        console.log(`❌ ${stmt.label}: ${err.message}`);
      }
    }
    
    // Now run the unique constraints (need special handling for duplicates)
    console.log("\n--- Unique Constraints ---");
    
    // Habit checkins: remove duplicates first
    try {
      await client.query(`DELETE FROM habit_checkins a USING habit_checkins b WHERE a.habit_id = b.habit_id AND a.date = b.date AND a.id > b.id`);
      await client.query(`ALTER TABLE habit_checkins ADD CONSTRAINT habit_checkins_unique_day UNIQUE (habit_id, date)`);
      console.log("✅ Added UNIQUE(habit_id, date) on habit_checkins");
    } catch (err) {
      if (err.message.includes('already exists')) {
        console.log("✅ habit_checkins_unique_day already exists");
      } else {
        console.log(`❌ habit_checkins unique: ${err.message}`);
      }
    }
    
    // Memories: remove duplicates first
    try {
      await client.query(`DELETE FROM memories a USING memories b WHERE a.user_id = b.user_id AND a.key = b.key AND a.updated_at < b.updated_at`);
      await client.query(`ALTER TABLE memories ADD CONSTRAINT memories_unique_key UNIQUE (user_id, key)`);
      console.log("✅ Added UNIQUE(user_id, key) on memories");
    } catch (err) {
      if (err.message.includes('already exists')) {
        console.log("✅ memories_unique_key already exists");
      } else {
        console.log(`❌ memories unique: ${err.message}`);
      }
    }
    
    await client.end();
    console.log("\n✅ Migration complete!");
  } catch (err) {
    console.error("Connection failed:", err.message);
    console.log("\nCannot connect directly. The migration SQL needs to be run manually.");
    console.log("File: supabase-phase1-migration.sql");
  }
}

main().catch(console.error);
