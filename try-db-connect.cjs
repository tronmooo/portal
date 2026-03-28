const { Client } = require('pg');

// Try multiple connection approaches
async function tryConnect(label, config) {
  const client = new Client({ ...config, connectionTimeoutMillis: 8000, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    console.log(`✅ ${label}: Connected!`);
    const res = await client.query('SELECT current_database(), current_user');
    console.log(`   DB: ${res.rows[0].current_database}, User: ${res.rows[0].current_user}`);
    await client.end();
    return true;
  } catch (err) {
    console.log(`❌ ${label}: ${err.message}`);
    return false;
  }
}

async function main() {
  const ref = 'uvaniovwrezzzlzmizyg';
  const svcKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2YW5pb3Z3cmV6enpsem1penlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDA0MDkyOCwiZXhwIjoyMDg5NjE2OTI4fQ.WO2hjB0q18xHfZ4OYfxsPmN1V-K4526G7rBMCRVy8vI';
  
  // Try direct DB host
  await tryConnect("Direct DB", {
    host: `db.${ref}.supabase.co`,
    port: 5432,
    database: 'postgres',
    user: 'postgres',
    password: svcKey,
  });
  
  // Try pooler transaction mode
  await tryConnect("Pooler (transaction)", {
    host: `aws-0-us-west-1.pooler.supabase.com`,
    port: 6543,
    database: 'postgres',
    user: `postgres.${ref}`,
    password: svcKey,
  });
  
  // Try pooler session mode
  await tryConnect("Pooler (session)", {
    host: `aws-0-us-west-1.pooler.supabase.com`,
    port: 5432,
    database: 'postgres',
    user: `postgres.${ref}`,
    password: svcKey,
  });
}

main();
