// Global test setup — runs before all vitest tests
import { vi } from "vitest";

// Suppress server logs during tests
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "info").mockImplementation(() => {});

// Ensure no Supabase env vars leak in during tests — tests use InMemoryStorage
process.env.VITE_SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.NODE_ENV = "test";
