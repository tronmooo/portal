/**
 * Migrate existing documents from base64-in-DB to Supabase Storage
 * Run with: npx tsx scripts/migrate-docs-to-storage.ts
 */

import { createClient } from "@supabase/supabase-js";

const SB_URL = "https://uvaniovwrezzzlzmizyg.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2YW5pb3Z3cmV6enpsem1penlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDA0MDkyOCwiZXhwIjoyMDg5NjE2OTI4fQ.WO2hjB0q18xHfZ4OYfxsPmN1V-K4526G7rBMCRVy8vI";

const sb = createClient(SB_URL, SB_KEY);

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif",
  "image/webp": "webp", "application/pdf": "pdf", "text/plain": "txt",
};

async function migrate() {
  // Get all documents that have file_data but no storage_path
  const { data: docs, error } = await sb
    .from("documents")
    .select("id, user_id, mime_type, file_data, storage_path, name")
    .is("storage_path", null)
    .not("file_data", "eq", "")
    .not("file_data", "is", null);

  if (error) { console.error("Query failed:", error.message); return; }
  
  const toMigrate = (docs || []).filter(d => d.file_data && d.file_data.length > 10);
  console.log(`Found ${toMigrate.length} documents to migrate.\n`);

  let migrated = 0, failed = 0;

  for (const doc of toMigrate) {
    const ext = MIME_EXT[doc.mime_type] || "bin";
    const storagePath = `${doc.user_id}/${doc.id}.${ext}`;
    
    try {
      const buffer = Buffer.from(doc.file_data, "base64");
      
      const { error: uploadError } = await sb.storage
        .from("documents")
        .upload(storagePath, buffer, {
          contentType: doc.mime_type || "application/octet-stream",
          upsert: true,
        });
      
      if (uploadError) {
        console.log(`  ❌ ${doc.name}: upload failed — ${uploadError.message}`);
        failed++;
        continue;
      }

      // Update the row: set storage_path and clear file_data
      const { error: updateError } = await sb
        .from("documents")
        .update({ storage_path: storagePath, file_data: "" })
        .eq("id", doc.id);
      
      if (updateError) {
        console.log(`  ⚠️ ${doc.name}: uploaded but DB update failed — ${updateError.message}`);
        failed++;
        continue;
      }

      const sizeMB = (buffer.length / 1024 / 1024).toFixed(2);
      console.log(`  ✅ ${doc.name} (${sizeMB} MB) → ${storagePath}`);
      migrated++;
    } catch (e: any) {
      console.log(`  ❌ ${doc.name}: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n─────────────────────────────────────`);
  console.log(`  Migrated: ${migrated}`);
  console.log(`  Failed:   ${failed}`);
  console.log(`  Total:    ${toMigrate.length}`);
  console.log(`─────────────────────────────────────\n`);
}

migrate().catch(console.error);
