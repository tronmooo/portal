// Credentials for the one-off maintenance scripts.
//
// These read from the environment ONLY — never inline a key here. The
// service-role key bypasses every RLS policy on every table, so a literal in
// this repo is a full database compromise: `tronmooo/portal` is a PUBLIC
// GitHub repository, and the key that used to sit in these scripts was
// world-readable for as long as it was committed.
//
// Run the scripts with the values exported, e.g.
//
//   export VITE_SUPABASE_URL=https://<project-ref>.supabase.co
//   export SUPABASE_SERVICE_ROLE_KEY=<secret>   # Dashboard → Settings → API
//   npx tsx scripts/<name>.ts

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. These scripts no longer carry a hardcoded key — ` +
        `export ${name} before running (see scripts/supabase-credentials.ts).`,
    );
  }
  return value;
}

export const SUPABASE_URL = requireEnv("VITE_SUPABASE_URL");
export const SUPABASE_SERVICE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
