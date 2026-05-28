/**
 * Shared smoke-account constants.
 *
 * ⚠️  This account is dedicated to the regression test suite. It is reset and
 * reseeded by `tests/smoke/fixture/reset.ts` and `seed.ts`. Never store real
 * user data here.
 *
 * Account provisioned 2026-05-28 via /api/auth/signup.
 */
export const SMOKE_EMAIL = "portol-smoke@aol.com";
export const SMOKE_PASSWORD = "Smoke-Test-2026!";
export const SMOKE_USER_ID = "229685c4-8dcb-4349-8448-57fc38e6e3d2";

// API base — overridable so the same suite can hit local dev or production.
export const API_BASE = process.env.SMOKE_API_BASE || "https://portol.me/api";

// UI base — used by Playwright specs.
export const UI_BASE = process.env.SMOKE_UI_BASE || "https://portol.me";

// Supabase project — needed for direct auth.
export const SB_URL = "https://uvaniovwrezzzlzmizyg.supabase.co";
export const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2YW5pb3Z3cmV6enpsem1penlnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDA5MjgsImV4cCI6MjA4OTYxNjkyOH0.0tn5gFfpWN-k5jRUiFehB1cD0BO-DAWP7LQO_IGI1AQ";
