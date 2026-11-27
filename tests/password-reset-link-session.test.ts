// Password reset by e-mail must accept the session a real reset link yields.
//
// Found 2026-11-27 by the first end-to-end run of the flow (isolated stack,
// accounts.password-change-and-reset): the link in the e-mail goes through
// /auth/v1/verify?type=recovery and the session issued there is marked
// `amr: [{ method: "otp" }]`. The route accepted only "recovery", so every
// real link was answered "Invalid or expired reset token".
import { describe, it, expect } from "vitest";
import { isRecoverySession, RESET_SESSION_MAX_AGE_S } from "../server/auth";

const NOW = 1_795_800_000_000;
const sec = Math.floor(NOW / 1000);
const token = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

describe("which session may set a new password without the old one", () => {
  it("the session an e-mailed reset link yields (method otp) is accepted", () => {
    expect(isRecoverySession(token({ amr: [{ method: "otp", timestamp: sec - 30 }] }), NOW)).toBe(true);
  });
  it("so are the PKCE form of the same link (recovery) and a magic link", () => {
    expect(isRecoverySession(token({ amr: [{ method: "recovery", timestamp: sec - 30 }] }), NOW)).toBe(true);
    expect(isRecoverySession(token({ amr: [{ method: "magiclink", timestamp: sec - 30 }] }), NOW)).toBe(true);
    expect(isRecoverySession(token({ amr: ["recovery"], iat: sec - 30 }), NOW)).toBe(true);
  });
  it("an ordinary password or OAuth session is refused — that is what the check is for", () => {
    expect(isRecoverySession(token({ amr: [{ method: "password", timestamp: sec - 30 }] }), NOW)).toBe(false);
    expect(isRecoverySession(token({ amr: [{ method: "oauth", timestamp: sec - 30 }] }), NOW)).toBe(false);
    // a session that ALSO involved a password is not a reset-link session
    expect(isRecoverySession(token({ amr: [{ method: "otp", timestamp: sec - 30 }, { method: "password", timestamp: sec - 900 }] }), NOW)).toBe(false);
  });
  it("a link followed more than an hour ago is refused", () => {
    expect(isRecoverySession(token({ amr: [{ method: "otp", timestamp: sec - RESET_SESSION_MAX_AGE_S - 5 }] }), NOW)).toBe(false);
    expect(isRecoverySession(token({ amr: [{ method: "otp", timestamp: sec - RESET_SESSION_MAX_AGE_S + 5 }] }), NOW)).toBe(true);
  });
  it("no claim, an empty claim or a token that is not one is refused", () => {
    expect(isRecoverySession(token({}), NOW)).toBe(false);
    expect(isRecoverySession(token({ amr: [] }), NOW)).toBe(false);
    expect(isRecoverySession("not-a-token", NOW)).toBe(false);
    expect(isRecoverySession(token({ amr: [{ method: "otp" }] }), NOW)).toBe(false); // no time to judge freshness by
  });
});

// Found the same day, in the isolated stack's server log: "shared rate limit
// unavailable … new row violates row-level security policy for table
// auth_rate_limits". The server signed users in on its own privileged client,
// which then carried the last user's session into its database calls.
describe("a user sign-in never runs on the server's privileged client", () => {
  const src = require("node:fs").readFileSync(`${process.cwd()}/server/auth.ts`, "utf8") as string;
  it("every password sign-in and token refresh uses a throwaway client", () => {
    expect(src).not.toMatch(/await supabase\.auth\.signInWithPassword\(/);
    expect(src).not.toMatch(/await supabase\.auth\.refreshSession\(/);
    expect((src.match(/\(userSessionClient\(\) \?\? supabase\)\.auth\.signInWithPassword\(/g) || []).length).toBeGreaterThanOrEqual(3);
    expect(src).toMatch(/\(userSessionClient\(\) \?\? supabase\)\.auth\.refreshSession\(/);
  });
  it("that client keeps no session", () => {
    const at = src.indexOf("function userSessionClient()");
    expect(src.slice(at, at + 420)).toContain("persistSession: false");
  });
});
