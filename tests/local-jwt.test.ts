// Local JWT verification (server/auth.ts verifyTokenLocally) replaces a
// network round trip to GoTrue when SUPABASE_JWT_SECRET is configured. These
// tests pin the two things that matter:
//  1. a genuine user access token verifies locally (perf path works), and
//  2. everything else — anon/service-role API keys (signed with the SAME
//     secret!), expired tokens, wrong-secret tokens, garbage — returns null
//     so it falls through to GoTrue instead of being trusted.
import { describe, it, expect, beforeAll } from "vitest";
import { SignJWT } from "jose";

const SECRET = "test-jwt-secret-that-is-at-least-32-chars-long";
const USER_ID = "3f2b8c9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

process.env.SUPABASE_JWT_SECRET = SECRET;
// Import AFTER the env var is set — the module derives the key lazily but we
// keep ordering explicit so a refactor to eager derivation can't break tests.
const { verifyTokenLocally } = await import("../server/auth");

async function sign(claims: Record<string, unknown>, opts?: { secret?: string; expired?: boolean }) {
  const key = new TextEncoder().encode(opts?.secret ?? SECRET);
  let jwt = new SignJWT(claims as any).setProtectedHeader({ alg: "HS256" });
  jwt = opts?.expired
    ? jwt.setIssuedAt(Math.floor(Date.now() / 1000) - 7200).setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
    : jwt.setIssuedAt().setExpirationTime("1h");
  return jwt.sign(key);
}

describe("verifyTokenLocally", () => {
  it("verifies a genuine user access token", async () => {
    const token = await sign({ sub: USER_ID, role: "authenticated", email: "user@example.com" });
    const res = await verifyTokenLocally(token);
    expect(res).toEqual({ userId: USER_ID, email: "user@example.com" });
  });

  it("rejects the anon API key shape (same secret, role=anon, no sub)", async () => {
    const token = await sign({ role: "anon", iss: "supabase" });
    expect(await verifyTokenLocally(token)).toBeNull();
  });

  it("rejects the service-role API key shape (same secret, role=service_role)", async () => {
    const token = await sign({ role: "service_role", iss: "supabase" });
    expect(await verifyTokenLocally(token)).toBeNull();
  });

  it("rejects an authenticated-role token whose sub is not a UUID", async () => {
    const token = await sign({ sub: "admin", role: "authenticated" });
    expect(await verifyTokenLocally(token)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await sign({ sub: USER_ID, role: "authenticated" }, { expired: true });
    expect(await verifyTokenLocally(token)).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await sign(
      { sub: USER_ID, role: "authenticated" },
      { secret: "some-other-secret-also-32-characters!!" },
    );
    expect(await verifyTokenLocally(token)).toBeNull();
  });

  it("rejects garbage", async () => {
    expect(await verifyTokenLocally("not-a-jwt")).toBeNull();
    expect(await verifyTokenLocally("")).toBeNull();
  });
});
