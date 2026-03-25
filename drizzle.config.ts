import { defineConfig } from "drizzle-kit";

// Note: This config is only used for Supabase/PostgreSQL migrations.
// Local development uses SQLite via better-sqlite3 (see server/sqlite-storage.ts).
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for Drizzle migrations (Supabase mode only)");
}

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
