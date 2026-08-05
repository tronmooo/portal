/**
 * Stripe Financial Connections — server wiring.
 *
 * Covers the pieces that sit between Stripe and Supabase:
 *   - environment validation and secret redaction
 *   - Stripe → Portol normalization (balance signs, amount signs, merchants)
 *   - webhook signature verification and idempotency
 *   - user-isolation invariants in the query layer
 *   - the Claude tool surface (no user id in any schema; disclosure attached)
 *
 * Key-free. Stripe's webhook signing is exercised with the SDK's own
 * `generateTestHeaderString`, so verification is tested for real without a
 * network call.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import Stripe from "stripe";

const ROOT = path.resolve(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

// ────────────────────────────────────────────────────────────────────────────
// Environment configuration
// ────────────────────────────────────────────────────────────────────────────

describe("stripe configuration", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    for (const k of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PUBLISHABLE_KEY",
      "VITE_STRIPE_PUBLISHABLE_KEY", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"]) {
      delete process.env[k];
    }
  });
  afterEach(() => { process.env = { ...saved }; vi.resetModules(); });

  it("reports exactly which variables are missing, by name only", async () => {
    const { stripeConfigStatus } = await import("../server/stripe-config");
    const status = stripeConfigStatus();
    expect(status.configured).toBe(false);
    expect(status.missing).toContain("STRIPE_SECRET_KEY");
    expect(status.missing).toContain("STRIPE_PUBLISHABLE_KEY");
    expect(status.missing).toContain("STRIPE_WEBHOOK_SECRET");
    // Names, never values.
    expect(JSON.stringify(status)).not.toMatch(/sk_|whsec_/);
  });

  it("throws a clear, typed configuration error instead of a 500", async () => {
    const { assertStripeConfigured, FinanceConfigError } = await import("../server/stripe-config");
    expect(() => assertStripeConfigured()).toThrow(FinanceConfigError);
    try {
      assertStripeConfigured();
    } catch (e: any) {
      expect(e.code).toBe("not_configured");
      expect(e.statusCode).toBe(503);
      expect(e.message).toMatch(/STRIPE_SECRET_KEY/);
      expect(e.message).toMatch(/not configured/i);
    }
  });

  it("refuses to hand a non-publishable key to the browser", async () => {
    // The failure mode this guards: someone pastes the SECRET key into the
    // publishable slot. Returning null is safe; returning the key is a breach.
    process.env.STRIPE_PUBLISHABLE_KEY = "sk_test_this_is_a_secret_key";
    const { publishableKeyForClient } = await import("../server/stripe-config");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(publishableKeyForClient()).toBeNull();
    spy.mockRestore();
  });

  it("accepts a real publishable key and the VITE_/NEXT_PUBLIC_ aliases", async () => {
    process.env.VITE_STRIPE_PUBLISHABLE_KEY = "pk_test_abc123";
    const mod = await import("../server/stripe-config");
    expect(mod.publishableKeyForClient()).toBe("pk_test_abc123");
  });

  it("treats a missing webhook secret as degraded, not broken", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_x";
    process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    const { stripeConfigStatus } = await import("../server/stripe-config");
    const status = stripeConfigStatus();
    // Connect still works; only webhook-driven refresh is unavailable.
    expect(status.configured).toBe(true);
    expect(status.webhooksConfigured).toBe(false);
  });

  it("detects live mode from the secret key prefix", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_x";
    process.env.STRIPE_PUBLISHABLE_KEY = "pk_live_x";
    const { stripeConfigStatus } = await import("../server/stripe-config");
    expect(stripeConfigStatus().livemode).toBe(true);
  });
});

describe("error classification and logging", () => {
  it("maps Stripe error types onto stable Portol codes", async () => {
    const { classifyStripeError } = await import("../server/stripe-config");
    expect(classifyStripeError({ type: "StripeRateLimitError" })).toEqual({ code: "rate_limited", retryable: true });
    expect(classifyStripeError({ statusCode: 503 })).toEqual({ code: "stripe_unavailable", retryable: true });
    expect(classifyStripeError({ type: "StripeConnectionError" })).toEqual({ code: "stripe_unavailable", retryable: true });
    expect(classifyStripeError({ type: "StripeAuthenticationError" })).toEqual({ code: "not_configured", retryable: false });
    // A PostgREST SQLSTATE is a storage problem, not a Stripe one.
    expect(classifyStripeError({ code: "23505" })).toEqual({ code: "storage_unavailable", retryable: true });
    expect(classifyStripeError(new Error("boom"))).toEqual({ code: "unknown", retryable: false });
  });

  it("logs the request id but never the secret or a full stack", async () => {
    const { logFinanceError } = await import("../server/stripe-config");
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      lines.push(args.map(String).join(" "));
    });
    logFinanceError("test", {
      type: "StripeAPIError", requestId: "req_123", statusCode: 500,
      message: "Something failed",
      stack: "Error: Something failed\n    at secret.ts:1:1",
    });
    spy.mockRestore();
    const output = lines.join("\n");
    expect(output).toContain("req_123");
    expect(output).not.toContain("secret.ts:1:1");
    expect(output).not.toMatch(/sk_|whsec_/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Normalization
// ────────────────────────────────────────────────────────────────────────────

describe("Stripe → Portol normalization", () => {
  function stripeAccount(over: any = {}): any {
    return {
      id: "fca_1", object: "financial_connections.account",
      account_holder: { type: "customer", customer: "cus_1" },
      category: "cash", subcategory: "checking",
      institution_name: "Bank of America", display_name: "Adv Plus Banking",
      last4: "6789", status: "active", permissions: ["balances", "transactions"],
      subscriptions: [], livemode: false, created: 1,
      balance: {
        as_of: 1_756_000_000,
        type: "cash",
        current: { usd: 500_000 },
        cash: { available: { usd: 480_000 } },
      },
      ...over,
    };
  }

  it("keeps a cash balance positive and exposes the available figure", async () => {
    const { normalizeBalance } = await import("../server/finance-sync");
    const b = normalizeBalance(stripeAccount());
    expect(b).toMatchObject({ currency: "usd", current: 500_000, available: 480_000 });
    expect(b.asOf).toBe(new Date(1_756_000_000 * 1000).toISOString());
  });

  it("forces a credit balance NEGATIVE so a card can never inflate assets", async () => {
    const { normalizeBalance } = await import("../server/finance-sync");
    // Some institutions report the owed amount as a POSITIVE `current`.
    const b = normalizeBalance(stripeAccount({
      category: "credit", subcategory: "credit_card",
      balance: { as_of: 1, type: "credit", current: { usd: 230_000 }, credit: { used: { usd: 230_000 } } },
    }));
    expect(b.current).toBe(-230_000);
  });

  it("falls back to credit.used when `current` is absent", async () => {
    const { normalizeBalance } = await import("../server/finance-sync");
    const b = normalizeBalance(stripeAccount({
      category: "credit", subcategory: "credit_card",
      balance: { as_of: 1, type: "credit", current: {}, credit: { used: { usd: 99_900 } } },
    }));
    expect(b.current).toBe(-99_900);
  });

  it("returns nulls rather than zeros when no balance was reported", async () => {
    const { normalizeBalance } = await import("../server/finance-sync");
    // A failed refresh must not overwrite the last known balance with 0.
    const b = normalizeBalance(stripeAccount({ balance: null }));
    expect(b.current).toBeNull();
    expect(b.available).toBeNull();
  });

  it("flips transaction signs on credit accounts so 'negative = spent' holds everywhere", async () => {
    const { normalizeAmount } = await import("../server/finance-sync");
    // Cash: Stripe already means what we mean.
    expect(normalizeAmount(-4_500, "depository")).toBe(-4_500);
    expect(normalizeAmount(250_000, "depository")).toBe(250_000);
    // Credit: a card purchase INCREASES what you owe, so Stripe's sign is
    // inverted relative to ours. Without this flip every card purchase would
    // read as income.
    expect(normalizeAmount(4_500, "credit")).toBe(-4_500);
    expect(normalizeAmount(-120_000, "credit")).toBe(120_000);
  });

  it("cleans bank descriptors into a readable merchant", async () => {
    const { extractMerchant } = await import("../server/finance-sync");
    expect(extractMerchant("SQ *BLUE BOTTLE 0123 CA")).toBe("Blue Bottle");
    expect(extractMerchant("SAFEWAY #1234 SAN FRANCISCO CA")).toMatch(/Safeway/i);
    expect(extractMerchant(null)).toBeNull();
    expect(extractMerchant("   ")).toBeNull();
  });

  it("guesses a category only when a rule matches, otherwise says nothing", async () => {
    const { guessCategory } = await import("../server/finance-sync");
    expect(guessCategory("SAFEWAY #1234")).toBe("food");
    expect(guessCategory("SHELL OIL 570")).toBe("transport");
    expect(guessCategory("PG&E BILL PAY")).toBe("utilities");
    // Guessing wrong is worse than saying nothing.
    expect(guessCategory("XJ4 TRANSACTION 88213")).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Webhook
// ────────────────────────────────────────────────────────────────────────────

describe("webhook signature verification", () => {
  const SECRET = "whsec_test_secret_for_unit_tests";
  const stripe = new Stripe("sk_test_dummy", { apiVersion: "2026-07-29.dahlia" });

  function signedEvent(payload: object, opts: { secret?: string; timestamp?: number } = {}) {
    const body = JSON.stringify(payload);
    const header = stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: opts.secret ?? SECRET,
      timestamp: opts.timestamp,
    });
    return { body, header };
  }

  it("accepts a correctly signed payload", () => {
    const { body, header } = signedEvent({ id: "evt_1", type: "financial_connections.account.created" });
    const event = stripe.webhooks.constructEvent(body, header, SECRET);
    expect(event.id).toBe("evt_1");
  });

  it("rejects a payload signed with the wrong secret", () => {
    const { body, header } = signedEvent({ id: "evt_2" }, { secret: "whsec_attacker" });
    expect(() => stripe.webhooks.constructEvent(body, header, SECRET)).toThrow();
  });

  it("rejects a tampered body under a valid signature", () => {
    const { header } = signedEvent({ id: "evt_3", type: "financial_connections.account.created" });
    const tampered = JSON.stringify({ id: "evt_3", type: "financial_connections.account.disconnected" });
    expect(() => stripe.webhooks.constructEvent(tampered, header, SECRET)).toThrow();
  });

  it("rejects a replayed old timestamp", () => {
    const old = Math.floor(Date.now() / 1000) - 60 * 60;
    const { body, header } = signedEvent({ id: "evt_4" }, { timestamp: old });
    expect(() => stripe.webhooks.constructEvent(body, header, SECRET, 300)).toThrow();
  });

  it("rejects a missing signature outright", () => {
    expect(() => stripe.webhooks.constructEvent("{}", "", SECRET)).toThrow();
  });
});

describe("webhook handler contract", () => {
  const SRC = read("server/finance-routes.ts");

  it("verifies the signature before doing anything with the payload", () => {
    const verifyAt = SRC.indexOf("constructEvent");
    const processAt = SRC.indexOf("processWebhookEvent(event)");
    expect(verifyAt).toBeGreaterThan(-1);
    expect(processAt).toBeGreaterThan(verifyAt);
  });

  it("reads the RAW body, never the parsed JSON, for verification", () => {
    expect(SRC).toMatch(/express\.raw\(/);
    expect(SRC).toMatch(/rawBody/);
  });

  it("mounts the raw parser BEFORE express.json() in BOTH server entries", () => {
    // Production runs through vercel-entry.ts and local dev through index.ts.
    // If express.json() ran first on this path the handler would depend
    // entirely on the verify() hook to recover the bytes — one refactor away
    // from every webhook silently failing signature verification.
    for (const entry of ["server/index.ts", "server/vercel-entry.ts"]) {
      const src = read(entry);
      const rawAt = src.indexOf('app.use("/api/finance/webhook", express.raw(');
      const jsonAt = src.indexOf("express.json({");
      expect(rawAt, `${entry} does not mount the webhook raw parser`).toBeGreaterThan(-1);
      expect(rawAt, `${entry} mounts express.json() before the webhook raw parser`).toBeLessThan(jsonAt);
    }
  });

  it("claims the event id BEFORE processing so a duplicate delivery is a no-op", () => {
    const claimAt = SRC.indexOf('from("finance_webhook_events")');
    const processAt = SRC.indexOf("processWebhookEvent(event)");
    expect(claimAt).toBeGreaterThan(-1);
    expect(claimAt).toBeLessThan(processAt);
    expect(SRC).toMatch(/duplicate: true/);
  });

  it("treats ONLY a unique violation as a duplicate, never a ledger outage", async () => {
    // Regression: the first version ACKed with duplicate:true on ANY ledger
    // insert error. Because Stripe does not retry a 200, an unreachable ledger
    // would have silently dropped every event for the whole outage.
    const { isDuplicateEventError } = await import("../server/finance-routes");
    // Real duplicate — Postgres primary-key clash.
    expect(isDuplicateEventError({ code: "23505" })).toBe(true);
    expect(isDuplicateEventError({
      message: 'duplicate key value violates unique constraint "finance_webhook_events_pkey"',
    })).toBe(true);
    // Not duplicates — the event still has to be processed.
    expect(isDuplicateEventError({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isDuplicateEventError({ message: "fetch failed" })).toBe(false);
    expect(isDuplicateEventError(new Error("connect ETIMEDOUT"))).toBe(false);
    expect(isDuplicateEventError(null)).toBe(false);
  });

  it("does not write back to a ledger row it failed to create", () => {
    expect(SRC).toMatch(/if \(ledgerClaimed\)/);
  });

  it("only handles event names that exist in the installed Stripe API version", async () => {
    // The guard against inventing event names from memory: every name we
    // handle must be one stripe-node declares for the pinned API version.
    const eventsDts = read("node_modules/stripe/esm/resources/Events.d.ts");
    const declared = new Set(
      Array.from(eventsDts.matchAll(/'(financial_connections\.[a-z_.]+)'/g)).map((m) => m[1]),
    );
    expect(declared.size).toBeGreaterThan(0);

    const handled = Array.from(
      SRC.matchAll(/"(financial_connections\.[a-z_.]+)"/g),
    ).map((m) => m[1]);
    expect(handled.length).toBeGreaterThan(5);
    for (const name of handled) {
      expect(declared.has(name), `${name} is not a real Stripe event for this API version`).toBe(true);
    }
  });

  it("resolves the owning user from our own tables, not from event metadata", () => {
    expect(SRC).toMatch(/userIdForStripeAccount\(/);
    expect(SRC).toMatch(/userIdForCustomer\(/);
    // An event we cannot attribute must be ignored, never guessed at.
    expect(SRC).toMatch(/unattributable account event/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// User isolation (structural)
// ────────────────────────────────────────────────────────────────────────────

describe("user isolation", () => {
  const dataSrc = read("server/finance-data.ts");
  const routesSrc = read("server/finance-routes.ts");
  const syncSrc = read("server/finance-sync.ts");
  const toolsSrc = read("server/finance-ai-tools.ts");

  it("scopes every financial_* read to a user id", () => {
    // Each `.from("financial_...")` / finance_sync_runs read in the data layer
    // must be followed by an explicit user filter. RLS is the second line of
    // defence; this is the first.
    const reads = Array.from(
      dataSrc.matchAll(/\.from\("(financial_[a-z_]+|finance_sync_runs)"\)([\s\S]{0,400})/g),
    );
    expect(reads.length).toBeGreaterThan(3);
    for (const [, table, following] of reads) {
      expect(
        following.includes('.eq("user_id", userId)') || following.includes('eq("user_id", userId)'),
        `read from ${table} is missing an explicit user_id filter`,
      ).toBe(true);
    }
  });

  it("never lets a handler take the user id from client input", () => {
    // No route may read a user id out of the body, query or headers.
    expect(routesSrc).not.toMatch(/req\.body(?:\?)?\.user_?[Ii]d/);
    expect(routesSrc).not.toMatch(/req\.query(?:\?)?\.user_?[Ii]d/);
    expect(routesSrc).not.toMatch(/headers\[["']x-user-id["']\]/);
    // The only source is the middleware-set req.userId.
    expect(routesSrc).toMatch(/\(req as any\)\.userId/);
  });

  it("gives Claude no way to name a user", async () => {
    const { FINANCE_TOOL_DEFINITIONS } = await import("../server/finance-ai-tools");
    for (const tool of FINANCE_TOOL_DEFINITIONS) {
      const props = Object.keys(tool.input_schema.properties ?? {});
      for (const prop of props) {
        expect(prop, `${tool.name} exposes a user-selecting parameter`).not.toMatch(/^user/);
      }
    }
    // And the executor takes userId as its own argument, from the request.
    expect(toolsSrc).toMatch(/userId: string \| undefined/);
  });

  it("checks connection ownership before disconnecting or deleting", () => {
    const disconnectBlock = routesSrc.slice(
      routesSrc.indexOf("/disconnect"),
      routesSrc.indexOf("/disconnect") + 1400,
    );
    expect(disconnectBlock).toMatch(/\.eq\("user_id", userId\)/);
    expect(disconnectBlock).toMatch(/Connection not found/);
  });

  it("scopes destructive sync operations to the user", () => {
    const deleteBlock = syncSrc.slice(syncSrc.indexOf("if (opts.deleteData)"));
    expect(deleteBlock).toMatch(/\.eq\("user_id", userId\)/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Secret containment
// ────────────────────────────────────────────────────────────────────────────

describe("secret containment", () => {
  it("keeps server-only secrets out of every client file", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const src = fs.readFileSync(full, "utf8");
        for (const secret of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "SUPABASE_SERVICE_ROLE_KEY"]) {
          if (src.includes(secret)) offenders.push(`${path.relative(ROOT, full)} → ${secret}`);
        }
      }
    };
    walk(path.join(ROOT, "client/src"));
    expect(offenders, `client code must never reference a server secret:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("never imports the server Stripe module from the client bundle", () => {
    const clientFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (/\.(ts|tsx)$/.test(entry.name)) clientFiles.push(full);
      }
    };
    walk(path.join(ROOT, "client/src"));
    for (const file of clientFiles) {
      const src = fs.readFileSync(file, "utf8");
      expect(src, `${path.relative(ROOT, file)} imports server-only Stripe code`)
        .not.toMatch(/from\s+["'].*server\/(stripe-config|finance-sync|finance-routes|finance-data)["']/);
      // The server SDK must never be pulled into the browser bundle.
      expect(src, `${path.relative(ROOT, file)} imports the server-side stripe SDK`)
        .not.toMatch(/from\s+["']stripe["']/);
    }
  });

  it("never sends bank credentials anywhere — Portol has no field for them", () => {
    for (const file of ["server/finance-sync.ts", "server/finance-routes.ts", "server/finance-data.ts", "client/src/lib/stripe-connect.ts"]) {
      const src = read(file);
      expect(src, `${file} must not handle bank credentials`)
        .not.toMatch(/bank_?(username|password)|institution_?password|\blogin_?password\b/i);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Database contract
// ────────────────────────────────────────────────────────────────────────────

describe("migration contract", () => {
  const sql = read("migrations/20260805_stripe_financial_connections.sql");

  it("creates every required table", () => {
    for (const table of [
      "financial_connections", "financial_accounts", "financial_transactions",
      "finance_sync_runs", "financial_transaction_overrides",
      "financial_transfer_links", "finance_webhook_events", "stripe_account_holders",
    ]) {
      expect(sql, `missing table ${table}`).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
    }
  });

  it("declares every field the spec requires on the core tables", () => {
    const required: Record<string, string[]> = {
      financial_connections: [
        "user_id", "stripe_account_holder_id", "stripe_session_id", "institution_name",
        "connection_status", "last_successful_sync_at", "last_attempted_sync_at",
        "last_sync_status", "last_sync_error", "created_at", "updated_at", "disconnected_at",
      ],
      financial_accounts: [
        "user_id", "financial_connection_id", "stripe_financial_connections_account_id",
        "institution_name", "account_name", "account_display_name", "account_category",
        "account_subcategory", "account_type", "last_four", "currency", "current_balance",
        "available_balance", "balance_as_of", "status", "is_hidden", "include_in_net_worth",
        "created_at", "updated_at",
      ],
      financial_transactions: [
        "user_id", "financial_account_id", "stripe_transaction_id", "transaction_date",
        "posted_at", "description", "merchant_name", "amount", "currency", "transaction_type",
        "status", "category", "subcategory", "is_income", "is_expense", "is_transfer",
        "is_refund", "is_duplicate", "excluded_from_totals", "source", "raw_metadata",
        "created_at", "updated_at",
      ],
      finance_sync_runs: [
        "user_id", "financial_connection_id", "sync_type", "started_at", "completed_at",
        "status", "accounts_processed", "transactions_inserted", "transactions_updated",
        "error_code", "error_message",
      ],
    };
    for (const [table, columns] of Object.entries(required)) {
      const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`);
      const body = sql.slice(start, sql.indexOf(");", start));
      for (const column of columns) {
        expect(body, `${table} is missing ${column}`).toMatch(new RegExp(`\\b${column}\\b`));
      }
    }
  });

  it("prevents duplicate accounts and transactions with unique constraints", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX[^;]*financial_accounts\(user_id, stripe_financial_connections_account_id\)/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX[^;]*financial_transactions\(user_id, stripe_transaction_id\)/);
  });

  it("stores money as bigint minor units, never float", () => {
    for (const column of ["current_balance", "available_balance", "amount"]) {
      expect(sql).toMatch(new RegExp(`${column} bigint`));
    }
    expect(sql).not.toMatch(/\b(current_balance|available_balance|amount)\s+(real|double precision|float)/);
  });

  it("enables RLS on every financial table", () => {
    for (const table of [
      "stripe_account_holders", "financial_connections", "financial_accounts",
      "financial_transactions", "financial_transaction_overrides",
      "financial_transfer_links", "finance_sync_runs", "finance_webhook_events",
    ]) {
      expect(sql, `RLS not enabled on ${table}`)
        .toMatch(new RegExp(`ALTER TABLE ${table}\\s+ENABLE ROW LEVEL SECURITY`));
    }
  });

  it("creates SELECT/INSERT/UPDATE/DELETE policies keyed on auth.uid()", () => {
    for (const verb of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      expect(sql).toMatch(new RegExp(`FOR ${verb} TO authenticated`));
    }
    // INSERT/UPDATE must WITH CHECK so a client cannot stamp another user's id.
    expect(sql).toMatch(/FOR INSERT TO authenticated WITH CHECK \(user_id = auth\.uid\(\)\)/);
    expect(sql).toMatch(/FOR UPDATE TO authenticated USING \(user_id = auth\.uid\(\)\) WITH CHECK \(user_id = auth\.uid\(\)\)/);
  });

  it("keeps the webhook ledger unreachable from the browser", () => {
    // RLS on with zero policies = deny all. Service role only.
    expect(sql).toMatch(/finance_webhook_events deliberately has NO policy/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Sync behaviour contract
// ────────────────────────────────────────────────────────────────────────────

describe("sync behaviour", () => {
  const src = read("server/finance-sync.ts");

  it("upserts rather than blind-inserting transactions", () => {
    expect(src).toMatch(/\.upsert\(rows, \{ onConflict: "user_id,stripe_transaction_id"/);
    expect(src).toMatch(/ignoreDuplicates: false/);
  });

  it("never deletes transactions merely because a refresh omitted them", () => {
    // The only delete in the file is the explicit "disconnect and delete data"
    // path, which is gated on opts.deleteData.
    const deletes = Array.from(src.matchAll(/\.delete\(/g));
    const deleteDataAt = src.indexOf("if (opts.deleteData)");
    for (const match of deletes) {
      expect(match.index!, "a delete exists outside the explicit delete-data path")
        .toBeGreaterThan(deleteDataAt);
    }
  });

  it("preserves user-editable columns across a re-sync", () => {
    // account_display_name / is_hidden / include_in_net_worth are set on INSERT
    // only. The `shared` patch object applied on UPDATE must not contain them.
    const sharedStart = src.indexOf("const shared = {");
    const sharedEnd = src.indexOf("};", sharedStart);
    const shared = src.slice(sharedStart, sharedEnd);
    for (const column of ["account_display_name", "is_hidden", "include_in_net_worth", "matched_profile_id"]) {
      expect(shared, `sync overwrites user-controlled column ${column}`).not.toMatch(new RegExp(`\\b${column}\\b`));
    }
  });

  it("does not blank a stored balance when a refresh returns nothing", () => {
    expect(src).toMatch(/balance\.current !== null \? \{ current_balance/);
    expect(src).toMatch(/balance\.available !== null \? \{ available_balance/);
  });

  it("paginates transactions and bounds the work per run", () => {
    expect(src).toMatch(/starting_after/);
    expect(src).toMatch(/has_more/);
    expect(src).toMatch(/MAX_PAGES_PER_ACCOUNT/);
  });

  it("asks for maximum history on the first import and incremental after", () => {
    expect(src).toMatch(/INITIAL_HISTORY_DAYS\s*=\s*730/);
    expect(src).toMatch(/baseParams\.transaction_refresh = \{ after: opts\.sinceRefreshId \}/);
  });

  it("survives a single account failing and records a partial run", () => {
    expect(src).toMatch(/accountErrors\.push/);
    expect(src).toMatch(/status = result\.errorCode \? "failed"[\s\S]*?"partial"/);
  });

  it("uses an idempotency key when creating the Stripe customer", () => {
    expect(src).toMatch(/idempotencyKey: `portol-holder-\$\{userId\}`/);
  });

  it("verifies session ownership before importing accounts", () => {
    const completeBlock = src.slice(src.indexOf("export async function completeConnectionSession"));
    expect(completeBlock).toMatch(/AUTHORIZATION CHECK/);
    expect(completeBlock).toMatch(/ownerUserId !== userId/);
  });

  it("writes no secrets into the sync history", () => {
    const runBlock = src.slice(src.indexOf("async function finishRun"), src.indexOf("async function finishRun") + 1200);
    // Note the escaped dots: an unescaped `error.message` also matches the
    // legitimate `error_message` COLUMN name.
    expect(runBlock).not.toMatch(/\berr\.message\b|\berror\.message\b|\.stack\b/);
  });

  it("only auto-applies a transfer above the confidence bar", () => {
    expect(src).toMatch(/c\.confidence >= AUTO_CONFIRM_CONFIDENCE \? "confirmed" : "detected"/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Claude tool surface
// ────────────────────────────────────────────────────────────────────────────

describe("Claude finance tools", () => {
  it("exposes exactly the five specified tools", async () => {
    const { FINANCE_TOOL_DEFINITIONS, FINANCE_TOOL_NAMES } = await import("../server/finance-ai-tools");
    expect(FINANCE_TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual([
      "get_account_balances", "get_financial_summary", "get_spending_breakdown",
      "refresh_financial_data", "search_financial_transactions",
    ]);
    expect(FINANCE_TOOL_NAMES).toHaveLength(5);
  });

  it("registers each one in the AI engine's tool registry", async () => {
    const { TOOL_DEFINITIONS, READ_ONLY_TOOLS, TOOL_ACTION_MAP } = await import("../server/ai-engine");
    const names = TOOL_DEFINITIONS.map((t: any) => t.name);
    for (const tool of ["get_financial_summary", "search_financial_transactions",
      "get_spending_breakdown", "get_account_balances", "refresh_financial_data"]) {
      expect(names, `${tool} is not registered`).toContain(tool);
    }
    // The four reads are read-only; the refresh is a real action.
    expect(READ_ONLY_TOOLS.has("get_financial_summary")).toBe(true);
    expect(READ_ONLY_TOOLS.has("refresh_financial_data")).toBe(false);
    expect(TOOL_ACTION_MAP.refresh_financial_data).toBeTruthy();
  });

  it("requires explicit confirmation before refreshing", async () => {
    const { executeFinanceTool } = await import("../server/finance-ai-tools");
    const result: any = await executeFinanceTool("refresh_financial_data", { confirm: false }, "user-1");
    expect(result.refreshed).toBe(false);
    expect(result.reason).toBe("not_confirmed");
  });

  it("refuses every tool without an authenticated user", async () => {
    const { executeFinanceTool, FINANCE_TOOL_NAMES } = await import("../server/finance-ai-tools");
    for (const name of FINANCE_TOOL_NAMES) {
      const result: any = await executeFinanceTool(name, {}, undefined);
      expect(result.error, `${name} answered without a user`).toMatch(/not signed in/i);
    }
  });

  it("instructs the model to use tool results and qualify every answer", async () => {
    const { FINANCE_TOOL_SYSTEM_GUIDANCE } = await import("../server/finance-ai-tools");
    expect(FINANCE_TOOL_SYSTEM_GUIDANCE).toMatch(/NEVER estimate/i);
    expect(FINANCE_TOOL_SYSTEM_GUIDANCE).toMatch(/date range/i);
    expect(FINANCE_TOOL_SYSTEM_GUIDANCE).toMatch(/last refreshed/i);
    expect(FINANCE_TOOL_SYSTEM_GUIDANCE).toMatch(/connected net worth/i);
    expect(FINANCE_TOOL_SYSTEM_GUIDANCE).toMatch(/currenc/i);
  });

  it("is wired into the system prompt", () => {
    expect(read("server/ai-engine.ts")).toMatch(/\$\{FINANCE_TOOL_SYSTEM_GUIDANCE\}/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Client flow
// ────────────────────────────────────────────────────────────────────────────

describe("browser connect flow", () => {
  const src = read("client/src/lib/stripe-connect.ts");
  const card = read("client/src/components/finance/FinanceConnectionCard.tsx");

  it("treats closing the Stripe modal as a cancellation, not an error", () => {
    expect(src).toMatch(/accounts\.length === 0/);
    expect(src).toMatch(/kind: "cancelled"/);
  });

  it("always clears the connecting state", () => {
    // A `finally` around the whole flow is what stops a permanent spinner when
    // the user closes the modal or the request throws.
    expect(card).toMatch(/finally \{[\s\S]*?setConnecting\(false\)/);
  });

  it("renders every required connection state", () => {
    for (const marker of [
      "finance-not-connected", "finance-connecting-hint", "finance-connected",
      "finance-badge-action", "finance-badge-failed", "finance-not-configured",
    ]) {
      expect(card, `missing state marker ${marker}`).toContain(marker);
    }
  });

  it("offers Reconnect rather than a generic error when authorization expires", () => {
    expect(card).toMatch(/Reconnect/);
    expect(card).toMatch(/needsAction \?/);
  });

  it("separates 'disconnect' from 'disconnect and delete data', and confirms the destructive one", () => {
    expect(card).toMatch(/btn-disconnect-\$\{conn\.id\}/);
    expect(card).toMatch(/btn-disconnect-delete-\$\{conn\.id\}/);
    expect(card).toMatch(/Disconnect and delete imported data\?/);
    expect(card).toMatch(/cannot be undone/i);
    // And it must promise (truthfully) that manual records survive.
    expect(card).toMatch(/entered yourself are kept|manually entered records were kept/i);
  });

  it("tells the user their credentials go to the bank, not to Portol", () => {
    expect(card).toMatch(/directly with your bank/i);
    expect(card).toMatch(/never sees or stores your banking username or password/i);
  });

  it("lists the three permissions being requested", () => {
    expect(card).toMatch(/Account details/i);
    expect(card).toMatch(/Balances/i);
    expect(card).toMatch(/Transactions/i);
  });
});

describe("Finance tab", () => {
  const src = read("client/src/components/finance/ConnectedFinance.tsx");

  it("renders NOTHING until the user opts in — it is an option, not a promo", () => {
    // Bank connection is opt-in from Settings. A user who never turns it on
    // must see the Finance tab exactly as it was before this feature existed:
    // no placeholder card, no skeleton flash, no "connect your bank" nudge.
    expect(src).toMatch(/if \(connectionsQ\.isLoading \|\| !configured \|\| !hasConnections\) \{\s*return null;/);
    // The old prompt card and its CTA must not come back.
    expect(src).not.toContain("connected-finance-empty");
    expect(src).not.toContain("btn-goto-settings-connect");
    expect(src).not.toMatch(/Connect a bank account/);
  });

  it("does no server work for users who have not connected anything", () => {
    // The summary endpoint recomputes totals; it must not run on every Finance
    // page load for the majority who never connect a bank.
    expect(src).toMatch(/enabled: hasConnections/);
  });

  it("labels the total 'Connected net worth' and says it is not the whole picture", () => {
    expect(src).toMatch(/Connected net worth/);
    expect(src).toMatch(/Not your complete financial picture/i);
  });

  it("renders every required section", () => {
    for (const marker of [
      "connected-accounts-section", "connected-transactions-section",
      "connected-cashflow-section", "connected-spending-section",
      "connected-income-section", "connected-liabilities-section",
    ]) {
      expect(src, `missing section ${marker}`).toContain(marker);
    }
  });

  it("offers all the required transaction filters plus search", () => {
    for (const marker of [
      "input-txn-search", "select-txn-institution", "select-txn-category",
      "select-txn-type", "select-txn-status",
    ]) {
      expect(src, `missing filter ${marker}`).toContain(marker);
    }
  });

  it("lets the user correct a transaction without touching imported data", () => {
    for (const marker of ["toggle-transfer", "toggle-income", "toggle-refund", "toggle-excluded", "input-txn-note", "select-txn-link-profile"]) {
      expect(src, `missing override control ${marker}`).toContain(marker);
    }
    expect(src).toMatch(/stored separately from the bank's data/i);
  });

  it("says 'Not provided by institution' instead of inventing liability fields", () => {
    const block = src.slice(src.indexOf("function LiabilitiesSection"));
    expect(block).toMatch(/Minimum payment/);
    expect(block).toMatch(/Interest rate/);
    expect((block.match(/Not provided by institution/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("discloses what cash flow excluded and what is still uncertain", () => {
    expect(src).toContain("cashflow-disclosure");
    expect(src).toMatch(/were excluded from these totals/i);
    expect(src).toMatch(/still need your review/i);
  });

  it("asks for confirmation before creating a subscription from a detected pattern", () => {
    expect(src).toMatch(/Save as subscription/);
    expect(src).toMatch(/Probable recurring charges/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Security headers
// ────────────────────────────────────────────────────────────────────────────

describe("content security policy", () => {
  it("allows Stripe.js and the Stripe API, and nothing broader", async () => {
    const { CONTENT_SECURITY_POLICY } = await import("../server/security-headers");
    expect(CONTENT_SECURITY_POLICY).toContain("https://js.stripe.com");
    expect(CONTENT_SECURITY_POLICY).toMatch(/connect-src[^;]*https:\/\/api\.stripe\.com/);
    expect(CONTENT_SECURITY_POLICY).toMatch(/frame-src[^;]*https:\/\/js\.stripe\.com/);
    // Still no inline scripts.
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("stays byte-identical to the copy in vercel.json", async () => {
    const { CONTENT_SECURITY_POLICY } = await import("../server/security-headers");
    const vercel = JSON.parse(read("vercel.json"));
    const headerValues = vercel.headers
      .flatMap((h: any) => h.headers)
      .filter((kv: any) => kv.key === "Content-Security-Policy")
      .map((kv: any) => kv.value);
    expect(headerValues.length).toBeGreaterThan(0);
    for (const value of headerValues) expect(value).toBe(CONTENT_SECURITY_POLICY);
  });
});

describe("auth middleware", () => {
  it("exempts the webhook — and only the webhook — from bearer auth", () => {
    const src = read("server/auth.ts");
    expect(src).toMatch(/req\.path === "\/finance\/webhook"/);
    // Nothing else under /finance/ may skip auth.
    expect(src).not.toMatch(/req\.path\.startsWith\("\/finance\//);
  });
});
