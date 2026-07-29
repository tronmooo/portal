// ── Self-profile auto-creation race (server/auth.ts) ─────────────────────────
//
// Production audit 2026-07-29 (High): "Auto-profile creation raced three times
// against the unique self-profile constraint."
//
// The auth middleware auto-creates a "Me" profile on a user's first request,
// guarded by a check-then-act (list profiles → none is type 'self' → create)
// and an in-process `autoProfileCreated` map. On serverless, concurrent lambda
// instances each start with an empty map, so a burst of parallel first
// requests all observe "no self profile" and all attempt the insert. The
// `profiles_one_self_per_user` unique index correctly rejected the losers —
// and those rejections were logged as errors.
//
// Losing that race is the index working as designed: the self profile exists,
// which is the desired end state. It must be recognised and swallowed quietly
// rather than reported as a failure.
import { describe, it, expect } from "vitest";
import { isUniqueViolation } from "../server/auth";

describe("isUniqueViolation", () => {
  it("recognises the PostgREST/supabase-js error shape", () => {
    expect(isUniqueViolation({
      code: "23505",
      message: 'duplicate key value violates unique constraint "profiles_one_self_per_user"',
    })).toBe(true);
  });

  it("recognises a bare SQLSTATE on the error object", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  it("recognises the code on a wrapped driver error", () => {
    expect(isUniqueViolation({ originalError: { code: "23505" } })).toBe(true);
    expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
  });

  it("falls back to the message when no code survives the wrapper", () => {
    expect(isUniqueViolation(
      new Error('duplicate key value violates unique constraint "profiles_one_self_per_user"'),
    )).toBe(true);
  });

  it("does NOT swallow unrelated failures", () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation(new Error("network timeout"))).toBe(false);
    expect(isUniqueViolation({ code: "42501", message: "permission denied" })).toBe(false);
    // A foreign-key violation is a real bug and must stay loud.
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    // The cross-user linked_profiles trigger raises this — never swallow it.
    expect(isUniqueViolation({
      code: "42501",
      message: "cross-user profile association rejected on public.habits",
    })).toBe(false);
  });
});
