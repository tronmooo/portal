import express, { type Express, type Request } from "express";
import { createServer, type Server } from "http";
import { createClient } from "@supabase/supabase-js";
import { execFile } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);
import { getUserToday, getUserCurrentMonth, toLocalDateStr, parseLocalDate, DEFAULT_TIMEZONE } from "@shared/timezone";
import { passesProfileFilter } from "@shared/profile-filter";
import { buildOwnerIndex, itemVisibleForSelection, type OwnershipRecord } from "@shared/ownership-model";
import { ASSET_PROFILE_TYPES, LIABILITY_PROFILE_TYPES, resolveLiabilityBalance } from "@shared/asset-value";
import { allocatePayment, resolveAnnualRate } from "@shared/liability-calc";
import { selfIdsFrom } from "@shared/scope";
import { validateFinanceImport } from "@shared/finance-import-schema";
import { buildImportPrompt, planImport, applyImport, undoImport } from "./finance-import";
import { HIDDEN_TRACKER_CATEGORIES } from "@shared/hidden-tracker-categories";
import { normalizeDateString } from "@shared/extraction-normalize";

/** Extract user timezone from request header, with fallback */
function getTimezone(req: Request): string {
  return (req.headers['x-timezone'] as string) || DEFAULT_TIMEZONE;
}

// Augment Express Request with auth middleware userId
interface AuthenticatedRequest extends Request {
  userId?: string;
}
import { storage } from "./storage";
import { resolveAssetValue, resolveLiabilityValue, resolveMonthlyPayment } from "./supabase-storage";
import { computeAiSensitiveStripKeys, deepStripKeys } from "./ai-summary-sanitizer";

// ────────────────────────────────────────────────────────────────────
// syncLiabilityObligation
//
// Keep a liability profile (type=liability|loan) in sync with a backing
// `obligations` row so the monthly payment shows up on the bills feed,
// calendar, and dashboard "monthly debt service" rollups.
//
//   liability.fields.monthlyPayment > 0   → ensure an obligation exists,
//                                            update its amount, name,
//                                            and link via linked_obligation_id
//   liability.fields.monthlyPayment = 0   → leave existing obligation alone
//                                            (the user may have set it manually)
//
// Best-effort: errors are logged but never block the calling request.
// ────────────────────────────────────────────────────────────────────
async function syncLiabilityObligation(profileId: string): Promise<void> {
  try {
    const p: any = await storage.getProfile(profileId);
    if (!p) return;
    if (p.type !== "liability" && p.type !== "loan") return;

    const monthly = resolveMonthlyPayment(p.fields);
    if (!(monthly > 0)) return;

    const fields = p.fields || {};
    const finance = fields.finance || {};
    const loan = fields.loan || {};
    // Try common storage paths for a due date / first payment date.
    const nextDueRaw =
      fields.nextDueDate || fields.next_due_date ||
      finance.nextDueDate || finance.next_due_date ||
      finance.firstPaymentDate || finance.first_payment_date ||
      loan.firstPaymentDate || loan.first_payment_date ||
      fields.firstPaymentDate || fields.first_payment_date || null;
    let nextDueDate: string | undefined = undefined;
    if (nextDueRaw && /^\d{4}-\d{2}-\d{2}/.test(String(nextDueRaw))) {
      nextDueDate = String(nextDueRaw).slice(0, 10);
    }
    // Day-of-month ("the 15th of every month") overrides whatever next_due_date
    // was stored — recompute to the next future occurrence so the obligation
    // lands on the calendar at the right cadence.
    const dueDayRaw = fields.dueDay ?? fields.due_day ?? fields.paymentDueDay ?? fields.payment_due_day;
    const dueDayNum = Number(dueDayRaw);
    if (Number.isFinite(dueDayNum) && dueDayNum >= 1 && dueDayNum <= 31) {
      const today = new Date();
      // Clamp to last day of current month (e.g. Feb has 28/29, day 31 → 28/29).
      const clampDay = (year: number, monthZero: number, day: number) => {
        const lastDay = new Date(year, monthZero + 1, 0).getDate();
        return Math.min(day, lastDay);
      };
      let y = today.getFullYear();
      let m = today.getMonth();
      let d = clampDay(y, m, Math.floor(dueDayNum));
      let candidate = new Date(y, m, d);
      if (candidate < today) {
        m += 1;
        if (m > 11) { m = 0; y += 1; }
        d = clampDay(y, m, Math.floor(dueDayNum));
        candidate = new Date(y, m, d);
      }
      const yyyy = candidate.getFullYear().toString().padStart(4, "0");
      const mm = (candidate.getMonth() + 1).toString().padStart(2, "0");
      const dd = candidate.getDate().toString().padStart(2, "0");
      nextDueDate = `${yyyy}-${mm}-${dd}`;
    }

    const category = "loan_payment";
    const name = p.name || "Loan payment";

    if (p.linkedObligationId) {
      // Update existing obligation. Don't touch nextDueDate if not provided
      // — the user may have advanced it manually after a payment.
      const patch: any = { amount: monthly, name, category, frequency: "monthly" };
      if (nextDueDate) patch.nextDueDate = nextDueDate;
      await storage.updateObligation(p.linkedObligationId, patch).catch((e: any) => {
        console.warn("[syncLiabilityObligation] update failed:", e?.message || e);
      });
      return;
    }

    // No backing obligation yet — create one and link it.
    const obl = await storage.createObligation({
      name,
      amount: monthly,
      frequency: "monthly",
      category,
      nextDueDate: nextDueDate || new Date().toISOString().slice(0, 10),
      autopay: false,
      linkedProfiles: [profileId],
      notes: "Auto-created from liability monthly payment",
    } as any).catch((e: any) => {
      console.warn("[syncLiabilityObligation] create failed:", e?.message || e);
      return null;
    });
    if (obl?.id) {
      await storage.updateProfile(profileId, { linkedObligationId: obl.id } as any).catch((e: any) => {
        console.warn("[syncLiabilityObligation] link-back failed:", e?.message || e);
      });
    }
  } catch (err: any) {
    console.warn("[syncLiabilityObligation] hook error:", err?.message || err);
  }
}
import { processMessage, processFileUpload, getActionLog, transformText, type TextTransformCommand, extractReceipt, estimateAssetValue, classifyCapture, reextractDocument } from "./ai-engine";
import { analyzeSmartFill, renderFilledPdf, type SmartFillSource, type FillFieldInput } from "./smart-fill";
import { aiDecide, aiPickIndex } from "./ai-decide";

// ── Wave 2 #6: AI-suggested obligation auto-sync for subscriptions/insurance ──
// Mirrors syncLiabilityObligation but for non-liability recurring-bill profiles.
// Uses AI to decide if the profile's fields warrant a recurring obligation
// (e.g. monthly subscription with a price) so we don't create junk obligations
// for one-off purchases or already-paid items.
async function syncAiSuggestedObligation(profileId: string): Promise<void> {
  try {
    const p: any = await storage.getProfile(profileId);
    if (!p) return;
    // Only target recurring-bill candidate types. Liabilities use syncLiabilityObligation.
    const candidateTypes = new Set(["subscription", "insurance", "account", "utility"]);
    if (!candidateTypes.has(p.type)) return;
    if (p.linkedObligationId) return; // already has one
    const fields = p.fields || {};
    // Cheap pre-check: must mention some price-like number to be worth an AI call.
    const fieldsJson = JSON.stringify(fields).toLowerCase();
    const hasPriceCue = /price|cost|amount|monthly|annual|fee|premium|rate|payment|\$\d|\d+\.\d{2}/.test(fieldsJson);
    if (!hasPriceCue) return;

    const decision = await aiDecide<{
      shouldCreate: boolean;
      amount: number | null;
      frequency: "weekly" | "monthly" | "quarterly" | "yearly" | null;
      category: string | null;
      nextDueDate: string | null;
      reason: string;
    }>({
      task: "obligation-auto-suggest",
      system: `You decide if a newly created ${p.type} profile should have a recurring obligation (bill) automatically created.
Return ONLY JSON: {"shouldCreate": boolean, "amount": number|null, "frequency": "weekly"|"monthly"|"quarterly"|"yearly"|null, "category": string|null, "nextDueDate": "YYYY-MM-DD"|null, "reason": "<short>"}
Rules:
- Only shouldCreate:true if the fields clearly indicate a RECURRING price + cadence (e.g. "$9.99/mo", monthlyPayment:42).
- Skip one-off purchases, free trials with no price, or items already marked cancelled.
- Pick the most specific recurring amount; convert annual→monthly only if no monthly is given (then frequency:"yearly" with the annual amount).
- nextDueDate: today + 30 days if monthly and no explicit date; null otherwise.
- category: "subscription", "insurance", "utility", or another short label.`,
      user: `Profile name: ${p.name}\nType: ${p.type}\nFields: ${JSON.stringify(fields).slice(0, 2000)}\n\nReturn JSON only.`,
      timeoutMs: 3500,
      maxTokens: 250,
      fallback: () => ({ shouldCreate: false, amount: null, frequency: null, category: null, nextDueDate: null, reason: "AI unavailable" }),
      validate: (x: any) => x && typeof x === "object" && typeof x.shouldCreate === "boolean",
    });

    if (!decision.value.shouldCreate || !decision.value.amount || decision.value.amount <= 0 || !decision.value.frequency) {
      return;
    }

    const obl = await storage.createObligation({
      name: p.name || `${p.type} payment`,
      amount: decision.value.amount,
      frequency: decision.value.frequency,
      category: decision.value.category || p.type,
      nextDueDate: decision.value.nextDueDate || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
      autopay: false,
      linkedProfiles: [p.id],
      notes: `Auto-suggested by AI: ${decision.value.reason}`,
    } as any).catch((e: any) => { console.warn("[syncAiSuggestedObligation] create failed:", e?.message || e); return null; });

    if (obl?.id) {
      await storage.updateProfile(p.id, { linkedObligationId: obl.id } as any).catch((e: any) => {
        console.warn("[syncAiSuggestedObligation] link-back failed:", e?.message || e);
      });
      console.log(`[syncAiSuggestedObligation] created obligation ${obl.id} ($${decision.value.amount}/${decision.value.frequency}) for ${p.type} "${p.name}" via ${decision.source}`);
    }
  } catch (err: any) {
    console.warn("[syncAiSuggestedObligation] hook error:", err?.message || err);
  }
}
import { normalizeTrackerEntry } from "./tracker-normalize";
import { generateWeeklyReview, detectAnomalies } from "./weekly-review";
import Anthropic from "@anthropic-ai/sdk";
import {
  insertProfileSchema,
  insertTrackerSchema,
  insertTrackerEntrySchema,
  insertTaskSchema,
  insertExpenseSchema,
  insertEventSchema,
  insertHabitSchema,
  insertObligationSchema,
  insertArtifactSchema,
  insertJournalEntrySchema,
  insertMemorySchema,
  insertGoalSchema,
  insertEntityLinkSchema,
  insertLiabilityAssetLinkSchema,
  insertLiabilityProfileLinkSchema,
  insertLiabilityPaymentSchema,
  insertAssetPartyLinkSchema,
  insertDocumentSchema,
} from "@shared/schema";
import type { ParsedAction, Tracker, CalendarEvent } from "@shared/schema";
import { generateSmartInsights } from "./insights-engine";
import { requireAdmin } from "./auth";

const isProd = process.env.NODE_ENV === "production";
const log = {
  info: (...args: any[]) => { if (!isProd) console.log("[Portol]", ...args); },
  warn: (...args: any[]) => console.warn("[Portol]", ...args),
  error: (...args: any[]) => console.error("[Portol]", ...args),
};

// Simple rate limiter
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX_ENTRIES = 10000;
const RATE_LIMIT_TARGET_AFTER_EVICT = 8000;
function rateLimit(key: string, maxRequests: number = 60, windowMs: number = 60000): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    // Cap map size to prevent unbounded growth under high traffic.
    if (rateLimitMap.size >= RATE_LIMIT_MAX_ENTRIES) {
      // 1) Drop expired entries first.
      for (const [k, v] of rateLimitMap) {
        if (now > v.resetAt) rateLimitMap.delete(k);
        if (rateLimitMap.size <= RATE_LIMIT_TARGET_AFTER_EVICT) break;
      }
      // 2) If still over target (all entries are fresh), evict oldest by
      //    insertion order. Without this, a flood of unique IPs in a
      //    single window could push the map past the cap indefinitely.
      while (rateLimitMap.size >= RATE_LIMIT_MAX_ENTRIES) {
        const oldestKey = rateLimitMap.keys().next().value;
        if (oldestKey === undefined) break;
        rateLimitMap.delete(oldestKey);
      }
    }
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return false; // not rate limited
  }
  entry.count++;
  if (entry.count > maxRequests) return true; // rate limited
  return false;
}
// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitMap.entries()) {
    if (now > val.resetAt) rateLimitMap.delete(key);
  }
}, 300000);

// ── Server-side response cache ────────────────────────────────────────────────
// IMPORTANT: This is an in-memory Map. On serverless platforms (Vercel),
// each function instance has its own memory — a write that busts the cache
// on instance A does NOT bust it on instance B. The result is users see
// stale data after mutations (toast says "marked paid" but the bill is still
// listed). Workaround: disable the cache entirely on Vercel. Local dev keeps
// it on for perf since a single Node process handles everything.
const CACHE_ENABLED = !process.env.VERCEL && !process.env.VERCEL_ENV;
const responseCache = new Map<string, { data: any; expiresAt: number }>();
// Cache keys MUST be per-user. authMiddleware guarantees req.userId on every
// authenticated data route in Supabase mode (it 401s otherwise), so the
// fallback below is unreachable in practice — but if userId were ever missing
// we return a per-request-unique token instead of a shared "anon" string, so a
// cross-user cache bucket can NEVER form. (Hardening follow-up.)
// ── Cross-instance cache coherence (migration 010) ─────────────────────
// The response cache is per-serverless-instance, so a write busted here was
// still served stale by other warm instances (user report 2026-06-10:
// "deleted items still show up, I constantly have to refresh"). Fix: every
// per-user cache key embeds the user's DATA VERSION (a Postgres counter
// bumped by the write middleware). A write on ANY instance changes the key
// every OTHER instance computes within ~VERSION_MEMO_MS, so stale entries
// simply stop being addressable. Old entries age out via their TTL.
const VERSION_MEMO_MS = 2000;
const versionMemo = new Map<string, { v: number; at: number }>();
async function currentDataVersion(uid: string): Promise<number> {
  const hit = versionMemo.get(uid);
  if (hit && Date.now() - hit.at < VERSION_MEMO_MS) return hit.v;
  const v = await (storage as any).getDataVersion?.() ?? 0;
  if (versionMemo.size > 5000) versionMemo.clear();
  versionMemo.set(uid, { v: Number(v) || 0, at: Date.now() });
  return Number(v) || 0;
}
function cacheUserKey(req: { userId?: string }): string {
  if (!req.userId) return `nouser-${Math.random().toString(36).slice(2)}`;
  const v = (req as any).__dataVersion;
  // Version resolved by the GET middleware below. Fallback "x" (no version
  // known) still produces a stable key — same-instance busting covers it.
  return v !== undefined ? `${req.userId}@v${v}` : req.userId;
}
function getCached(key: string): any | null {
  if (!CACHE_ENABLED) return null;
  const entry = responseCache.get(key);
  if (entry && Date.now() < entry.expiresAt) return entry.data;
  responseCache.delete(key);
  return null;
}
function setCache(key: string, data: any, ttlMs: number = 10000): void {
  if (!CACHE_ENABLED) return;
  responseCache.set(key, { data, expiresAt: Date.now() + ttlMs });
}
// Clear ALL cached responses — call after any data mutation
function clearAllCache(): void {
  responseCache.clear();
}

// Verify a client-supplied entity id belongs to the current user.
// Returns true if owned, false if not owned or unknown entity type.
async function verifyEntityOwnership(entityType: string, entityId: string): Promise<boolean> {
  if (!entityId || typeof entityId !== "string") return false;
  switch (entityType) {
    case "expense":     return !!(await storage.getExpense(entityId));
    case "task":        return !!(await storage.getTask(entityId));
    case "document":    return !!(await storage.getDocument(entityId));
    case "event":       return !!(await storage.getEvent(entityId));
    case "tracker":     return !!(await storage.getTracker(entityId));
    case "habit":       return !!(await storage.getHabit(entityId));
    case "goal":        return !!(await storage.getGoal(entityId));
    case "obligation":  return !!(await storage.getObligation(entityId));
    case "artifact":    return !!(await storage.getArtifact(entityId));
    case "profile":     return !!(await storage.getProfile(entityId));
    case "journal": {
      const list = await storage.getJournalEntries();
      return list.some((j: any) => j.id === entityId);
    }
    case "domain": {
      const list = await storage.getDomains();
      return list.some((d: any) => d.id === entityId);
    }
    case "memory": {
      const list = await storage.getMemories();
      return list.some((m: any) => m.id === entityId);
    }
    default:
      return false;
  }
}
const KNOWN_ENTITY_TYPES = new Set([
  "expense","task","document","event","tracker","habit","goal","obligation","artifact","profile","journal","domain","memory"
]);

// Middleware: clear server cache on ANY mutation (POST/PATCH/PUT/DELETE)
// This ensures deleted documents, updated profiles, etc. are immediately reflected.
//
// Bug fix: previously this only fired on res.on('finish'), which races with the
// client's onSuccess invalidateAll() that fires GET /api/profiles immediately —
// the GET could return stale cache before 'finish' cleared it. Now we ALSO bust
// caches synchronously BEFORE handing control to the route for chat/upload paths
// that mutate data via internal AI tool calls (not just direct REST writes).
function cacheBustMiddleware(req: any, res: any, next: any) {
  const isMutation = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
  const isAiMutator = req.path === '/api/chat' || req.path.startsWith('/api/upload') || req.path === '/api/chat/confirm-extraction';
  if (isMutation || isAiMutator) {
    // Bug fix: bust BEFORE the handler runs as well as on finish.
    // Previously only the res.on('finish') bust existed, which races with the
    // client's invalidate-then-refetch: the GET /api/stats that fires immediately
    // after onSuccess() could still hit a warm cache entry because 'finish' fires
    // asynchronously AFTER the response has been sent.  Clearing synchronously here
    // ensures any in-flight read that arrives while the mutation handler is executing
    // will miss the cache and go to the DB instead.
    clearAllCache();
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 400) clearAllCache();
    });
  }
  next();
}

// ── In-flight deduplication: if two requests for the same key arrive simultaneously,
//    the second one piggybacks on the first DB query instead of firing its own.
//    This prevents N identical Supabase queries when N tabs/components all load at once.
const inFlight = new Map<string, Promise<any>>();
function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (inFlight.has(key)) return inFlight.get(key) as Promise<T>;
  const p = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}
function bustCache(prefix: string): void {
  for (const key of responseCache.keys()) {
    if (key.startsWith(prefix)) responseCache.delete(key);
  }
}
// Bust relevant caches after any write operation
function bustAllCaches(): void {
  responseCache.clear();
}

// Input sanitizer — strip dangerous content but preserve readable text.
// React handles HTML escaping at render time, so we store raw text in DB.
// Only strip actual injection vectors, not encode legitimate characters like & < >
function sanitize(input: string): string {
  return input
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[^>]*>[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[^>]*>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/data:text\/html/gi, '')
    .replace(/vbscript:/gi, '')
    .trim()
    .slice(0, 10000);
}

// Date validation helper
function isValidDateStr(d: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d).getTime());
}

// Pagination helper — applies ?limit= and ?offset= to any array and sets X-Total-Count header
function paginate<T>(items: T[], req: any, res: any): T[] {
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 100, 1), 500);
  const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
  res.set("X-Total-Count", String(items.length));
  return items.slice(offset, offset + limit);
}

// Full-by-default pagination for lists whose CLIENT computes an aggregate
// (sum/total) over the whole set. The generic paginate() above hard-caps at
// 100/page, which silently truncated the Finance page total for any user with
// more than 100 expenses — the page sums only the rows it received, so the
// oldest expenses were never counted ("all the expenses are not being
// calculated"). Like paginateProfiles, we return EVERY row by default and only
// slice when the caller explicitly opts into ?limit=/?offset=. X-Total-Count is
// still set so opt-in pagers know the full size.
function paginateFull<T>(items: T[], req: any, res: any): T[] {
  res.set("X-Total-Count", String(items.length));
  const hasPager = typeof req.query.limit === "string" || typeof req.query.offset === "string";
  if (!hasPager) return items;
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || items.length, 1), 10000);
  const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
  return items.slice(offset, offset + limit);
}

// Specialised pagination for /api/profiles.
//   - Profile lists are bounded (~thousands max), small per-row, and required
//     in FULL for the recursive net-worth rollup. The generic paginate() above
//     hard-caps at 500/page, which silently truncates the dashboard rollup
//     when a user crosses 500 profiles — we measured this against a 551-node
//     seed and the rollup was wrong by 50%.
//   - We still honour explicit ?limit= / ?offset= for UI pagers that opt in,
//     and still set X-Total-Count, but default to returning every profile so
//     downstream callers (rollup, AI engine snapshot) see the whole tree.
function paginateProfiles<T>(items: T[], req: any, res: any): T[] {
  const hasLimit = typeof req.query.limit === "string" || typeof req.query.offset === "string";
  if (!hasLimit) return items;
  const limit = Math.min(Math.max(parseInt(req.query.limit as string) || items.length, 1), 10000);
  const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
  return items.slice(offset, offset + limit);
}

// Wrap async route handlers to catch unhandled errors and send 500 instead of crashing
type AsyncHandler = (req: any, res: any, next?: any) => Promise<any>;
function asyncHandler(fn: AsyncHandler): AsyncHandler {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err: any) {
      log.error(`[API Error] ${req.method} ${req.path}:`, err?.message || err);
      if (!res.headersSent) {
        // Honor explicit client-error status codes thrown by lower layers
        // (e.g. the storage layer's optimistic-concurrency ConflictError sets
        // statusCode = 409). 5xx and unknown statuses stay a generic 500 so
        // internal details never leak to clients.
        const status = Number(err?.statusCode || err?.status);
        if (Number.isInteger(status) && status >= 400 && status < 500) {
          res.status(status).json({ error: err?.message || "Request failed" });
        } else {
          res.status(500).json({ error: "Internal server error" });
        }
      }
    }
  };
}

// ── [P2.4] Canonical profile-scope filter for list endpoints ────────────────
// ONE implementation of the shared orphan rule (shared/profile-filter):
// an item passes when any of its linkedProfiles is in the selection; orphan
// items (empty linkedProfiles) pass only when the selection includes a
// self-type profile. Previously trackers/expenses/events/habits/obligations
// each inlined a bare `.some()` that silently dropped orphans — and the
// single-profile (?profileId=) branches duplicated the rule separately.
// Routing every site through this helper keeps single vs multi param
// semantics identical and aligned with the tasks/journal reference endpoints.
async function filterByProfileScope<T>(
  items: T[],
  ids: string[],
  uid: string,
): Promise<T[]> {
  if (!ids || ids.length === 0) return items;
  const allProfiles: Array<{ id: string; type?: string }> =
    getCached(`profiles:${uid}`) || await storage.getProfiles();
  return items.filter((item: any) =>
    passesProfileFilter(item?.linkedProfiles, { selectedIds: ids, allProfiles })
  );
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // Clear server cache on any mutation so changes are reflected immediately
  app.use(cacheBustMiddleware);

  // CORS — allow requests from the app's own domain and Capacitor
  app.use((req, res, next) => {
    const allowedOrigins = [
      "https://portol.me",
      "capacitor://localhost",
      "ionic://localhost",
      "http://localhost",
      "http://localhost:5000",
    ];
    const origin = req.headers.origin;
    if (origin && allowedOrigins.some(o => origin.startsWith(o))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-User-Id");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // Prevent caching of ALL API responses — UI must always reflect current DB state
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    next();
  });

  // Pin the request-scoped storage to the USER'S timezone (X-Timezone header)
  // for EVERY /api route — not just /api/chat. Without this, "today" defaulted
  // to America/Los_Angeles everywhere, so habit check-ins and the
  // habits-completed-today count kept showing yesterday's completions past the
  // user's local midnight (until LA rolled over). Setting it globally makes
  // every date boundary (habit reset, "this month", streaks) align with the
  // user's actual day. Storage is request-scoped, so this is per-request safe.
  app.use("/api", (req, _res, next) => {
    try { (storage as any)._timezone = getTimezone(req); } catch { /* ignore */ }
    next();
  });

  // Version endpoint — frontend polls this to detect new deploys
  const BUILD_VERSION = Date.now().toString(36);
  app.get("/api/version", (req, res) => {
    res.json({ version: BUILD_VERSION });
  });

  // Client-side error beacon. Fired by ErrorBoundary when React catches a
  // render exception. We just log to stdout — Vercel function logs capture
  // it and we can pull stacks with `vercel logs`. No DB write, no auth
  // required (errors must be reportable even when the user is mid-crash).
  app.post("/api/client-errors", express.json({ limit: "64kb" }) as any, (req, res) => {
    try {
      const { section, message, stack, componentStack, url, userAgent, ts } = req.body || {};
      const uid = cacheUserKey(req as AuthenticatedRequest);
      // Keep this on a single console.error so Vercel groups it nicely.
      console.error("[client-error]", JSON.stringify({
        uid,
        section,
        message: (message || "").slice(0, 500),
        url,
        ts,
        userAgent: (userAgent || "").slice(0, 200),
        stack: (stack || "").slice(0, 4000),
        componentStack: (componentStack || "").slice(0, 2000),
      }));
    } catch { /* swallow */ }
    res.status(204).end();
  });

  // Keep-alive / pre-warm endpoint — called by client every 90s to prevent cold starts
  // Also fired immediately after login to pre-populate cache in the background
  app.get("/api/warmup", asyncHandler(async (req, res) => {
    res.json({ ok: true, ts: Date.now() });
    // Pre-populate expensive caches in background (after response sent)
    const uid = cacheUserKey(req as AuthenticatedRequest);
    if (uid !== "anon") {
      const ckStats = `stats:${uid}:all`;
      const ckEnh = `enhanced:${uid}:all`;
      const ckProf = `profiles:${uid}`;
      if (!getCached(ckStats)) storage.getStats().then(s => setCache(ckStats, s, 5*60*1000)).catch(()=>{}); // version-stamped key: fresh by construction
      if (!getCached(ckEnh)) storage.getDashboardEnhanced().then(d => setCache(ckEnh, d, 5*60*1000)).catch(()=>{}); // version-stamped key: fresh by construction
      if (!getCached(ckProf)) storage.getProfiles().then(p => setCache(ckProf, p, 5*60*1000)).catch(()=>{}); // version-stamped key: fresh by construction
    }
  }));

  // Resolve the per-user data version for GET requests (memoized 2s per
  // instance) so cacheUserKey() produces version-stamped keys. Fail open to
  // "no version" — same-instance busting still applies, and correctness is
  // restored on the next successful resolve.
  app.use("/api", (req, _res, next) => {
    if (req.method !== "GET") return next();
    const uid = (req as AuthenticatedRequest).userId;
    if (!uid) return next();
    currentDataVersion(uid)
      .then((v) => { (req as any).__dataVersion = v; next(); })
      .catch(() => next());
  });

  // Rate limit all write operations (POST/PATCH/DELETE) — 60 writes per minute per user
  app.use("/api", (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
      const uid = (req as AuthenticatedRequest).userId || req.ip || "anon";
      // Skip rate limit for chat and upload (they have their own stricter limits)
      if (!req.path.startsWith("/chat") && !req.path.startsWith("/upload")) {
        if (rateLimit(`write:${uid}`, 60)) {
          return res.status(429).json({ error: "Too many requests. Please slow down." });
        }
      }
      // Bust response cache on write — BEFORE the route handler runs so the
      // route's reads are guaranteed fresh. Covers every prefix any route uses.
      if (uid !== "anon") {
        bustCache(`stats:${uid}`);
        bustCache(`enhanced:${uid}`);
        bustCache(`enhanced:`); // legacy unscoped
        bustCache(`profile-detail:${uid}:`);
        bustCache(`profiles:${uid}`);
        bustCache(`trackers:${uid}`);
        bustCache(`trackers:`); // some routes use unscoped key
        bustCache(`tasks:${uid}`);
        bustCache(`expenses:${uid}`);
        bustCache(`events:${uid}`);
        bustCache(`habits:${uid}`);
        bustCache(`obligations:${uid}`);
        bustCache(`journal:${uid}`);
        bustCache(`documents:${uid}`);
        bustCache(`goals:${uid}`);
        bustCache(`insights:${uid}`);
        bustCache(`insights-data:${uid}`);
        bustCache(`activity:${uid}`);
        bustCache(`ai-digest:${uid}`);
        bustCache(`artifacts:${uid}`);
        bustCache(`notifications:${uid}`);
        bustCache(`cashflow:${uid}`);
        bustCache(`calendar:${uid}`);
        // Cross-instance: bump the DB data version so version-stamped cache
        // keys on every OTHER instance go stale within ~2s. Fire-and-forget —
        // the local bust above already guarantees same-instance freshness.
        const bumpVersion = () => {
          versionMemo.delete(uid);
          Promise.resolve((storage as any).bumpDataVersion?.())
            .then((v: number) => { if (v) versionMemo.set(uid, { v, at: Date.now() }); })
            .catch(() => { /* next GET resolves the version from the DB */ });
        };
        bumpVersion();
        // Long-running writes (AI chat can take 5-30s) do their DB writes
        // DURING the handler — a GET racing mid-handler can cache pre-write
        // data under the already-bumped version. Re-bust + re-bump when the
        // response finishes so anything cached mid-write goes stale too.
        res.once("finish", () => {
          try {
            for (const prefix of [
              "stats:", "enhanced:", "profile-detail:", "profiles:", "trackers:",
              "tasks:", "expenses:", "events:", "habits:", "obligations:",
              "journal:", "documents:", "goals:", "insights:", "insights-data:",
              "activity:", "ai-digest:", "artifacts:", "notifications:",
              "cashflow:", "calendar:",
            ]) bustCache(`${prefix}${uid}`);
          } catch { /* best-effort */ }
          bumpVersion();
        });
      } else {
        bustAllCaches();
      }
    }
    next();
  });

  // ---- Chat / AI ----
  /* A3: in-memory idempotency cache for AI chat. Keyed by (userId, key),
     with the key supplied by the client in an `Idempotency-Key` header.
     If two requests with the same key arrive within 5 minutes, the second
     returns the cached response from the first instead of re-running the
     tool chain. This eliminates the duplicate-write window when a client
     retries on a timed-out request whose server work actually succeeded.
     Entries auto-expire via a setTimeout cleanup. */
  type IdempotencyEntry = { status: "pending" | "done"; result?: any; expires: number };
  const idempotencyCache = new Map<string, IdempotencyEntry>();
  const IDEM_TTL_MS = 5 * 60_000;
  function idemKey(userId: string, key: string) { return `${userId}:${key}`; }
  function getIdem(userId: string, key: string): IdempotencyEntry | undefined {
    const e = idempotencyCache.get(idemKey(userId, key));
    if (!e) return undefined;
    if (Date.now() > e.expires) { idempotencyCache.delete(idemKey(userId, key)); return undefined; }
    return e;
  }
  function setIdem(userId: string, key: string, entry: IdempotencyEntry) {
    idempotencyCache.set(idemKey(userId, key), entry);
    setTimeout(() => idempotencyCache.delete(idemKey(userId, key)), IDEM_TTL_MS + 1000);
  }

  app.post("/api/chat", asyncHandler(async (req, res) => {
    const userId = (req as AuthenticatedRequest).userId || req.ip || 'anonymous';
    if (rateLimit(`chat:${userId}`, 20)) {
      return res.status(429).json({ error: "Too many requests. Please wait a moment." });
    }
    try {
      const { message, history } = req.body;
      if (!message || typeof message !== "string") {
        return res.status(400).json({ error: "Message required" });
      }
      // [P4.5] Optional active profile-filter selection from the client so the
      // AI engine can scope reads/snapshots to the same selection the UI shows.
      const profileFilterIds: string[] | undefined = Array.isArray(req.body?.profileFilterIds)
        ? (req.body.profileFilterIds as any[]).filter((x) => typeof x === "string" && x.length > 0)
        : undefined;
      if (message.length > 5000) {
        return res.status(400).json({ error: "Message too long (max 5000 characters)" });
      }

      /* A3: honor Idempotency-Key. Valid keys are 8-128 chars of
         [A-Za-z0-9._:-]. We don't validate semantics — the client (or a
         generated UUID) is responsible for uniqueness per logical action. */
      const rawIdem = (req.headers["idempotency-key"] || req.headers["x-idempotency-key"] || "") as string;
      const idem = typeof rawIdem === "string" && /^[A-Za-z0-9._:\-]{8,128}$/.test(rawIdem) ? rawIdem : "";
      if (idem) {
        const existing = getIdem(userId, idem);
        if (existing?.status === "done" && existing.result) {
          // Replay the prior successful response. Adding a header so the
          // client can observe that the body came from cache (useful for
          // debugging, opt-in metrics).
          res.setHeader("X-Idempotent-Replay", "1");
          return res.json(existing.result);
        }
        if (existing?.status === "pending") {
          // A concurrent retry hit while the first call is still running.
          // Tell the client to back off briefly so the original call can
          // finish and populate the cache.
          res.setHeader("Retry-After", "2");
          return res.status(409).json({ error: "In-flight request with the same Idempotency-Key. Retry in a moment." });
        }
        setIdem(userId, idem, { status: "pending", expires: Date.now() + IDEM_TTL_MS });
      }

      // Pass user's timezone to AI engine so all date operations use the correct local date
      const tz = getTimezone(req);
      (storage as any)._timezone = tz;
      // [P4.5] 4th arg is the engine options object; cast keeps this compiling
      // while ai-engine.ts gains `profileFilterIds` support (the engine ignores
      // unknown extra args until then, so this is forward/backward safe).
      //
      // PR Z: classifier runs in parallel with processMessage. Cheap Haiku call
      // adds ~200-400ms but parallelism hides it. Failures fall back to a
      // heuristic — chat never breaks because of a classifier error.
      const classifierContextPromise = (async () => {
        try {
          const profiles = await storage.getProfiles().catch(() => [] as any[]);
          const self = await (storage.getSelfProfile?.() ?? Promise.resolve(undefined));
          return {
            profiles: (profiles || []).map((p: any) => ({ id: p.id, name: p.name, type: p.type })),
            selfProfileId: (self as any)?.id || null,
          };
        } catch {
          return { profiles: [], selfProfileId: null };
        }
      })();
      const cleanMessage = sanitize(message);
      const [result, classification] = await Promise.all([
        (processMessage as any)(cleanMessage, Array.isArray(history) ? history : undefined, userId, { profileFilterIds }),
        classifierContextPromise.then(ctx => classifyCapture(cleanMessage, ctx).catch(err => {
          console.warn("[classifyCapture] swallowed error:", (err as Error).message);
          return null;
        })),
      ]);
      if (idem) setIdem(userId, idem, { status: "done", result, expires: Date.now() + IDEM_TTL_MS });

      // ─── Universal Capture (PR Y + Z) ──────────────────────────────
      // Record this message as a Capture so we never lose user input,
      // even when the AI doesn't route it anywhere or when confidence
      // was too low to act. Projections (actions the AI actually took)
      // are attached so each capture has an audit trail to the typed
      // rows it produced. Never throw — capture is best-effort.
      //
      // PR Z: uses real classifier output (type, owner, structuredData,
      // confidence) instead of the PR Y heuristic. When confidence < 0.7
      // and no projections, the clarifyingQuestion is appended to the
      // chat reply so the user can disambiguate in the next turn.
      try {
        if (storage.createCapture) {
          const actions: any[] = Array.isArray((result as any)?.actions) ? (result as any).actions : [];
          const projections = actions
            .filter(a => a && a.type)
            .map(a => ({
              kind: String(a.type),
              id: String(a?.data?.id || a?.id || a?.data?.trackerName || a?.data?.name || ""),
              at: new Date().toISOString(),
            }))
            .filter(p => p.id);

          // Prefer classifier output; fall back to action-derived heuristic.
          const typeMap: Record<string, string> = {
            log_entry: "tracker_entry",
            create_expense: "expense",
            log_income: "income",
            create_obligation: "obligation",
            create_task: "task",
            create_event: "event",
            create_habit: "habit",
            create_profile: "profile_create",
            create_tracker: "tracker_create",
            create_goal: "note",
          };
          const firstKind = (actions[0]?.type || "").toLowerCase();
          const heuristicType = typeMap[firstKind] || (projections.length > 0 ? "note" : "unknown");
          const self = await storage.getSelfProfile?.();
          const captureType = classification?.type || heuristicType;
          const captureOwner = classification?.ownerProfileId ?? (self?.id || null);
          const captureTitle = (classification?.title && classification.title.trim())
            ? classification.title.trim().slice(0, 120)
            : message.slice(0, 120);
          // Confidence: prefer classifier; bump to 0.9+ if projections
          // succeeded (we KNOW it routed somewhere). Never lower the
          // classifier's confidence below what it returned.
          const baseConf = typeof classification?.confidence === "number" ? classification.confidence : (projections.length > 0 ? 0.9 : 0.4);
          const captureConf = projections.length > 0 ? Math.max(baseConf, 0.9) : baseConf;

          await storage.createCapture({
            type: captureType,
            ownerProfileId: captureOwner,
            title: captureTitle,
            rawInput: message,
            structuredData: classification?.structuredData || {},
            metadata: {
              ...(classification?.metadata || {}),
              hasReply: !!(result as any)?.reply,
              actionCount: actions.length,
              ownerName: classification?.ownerName || null,
            },
            relationships: classification?.relationships || [],
            source: "chat",
            confidence: captureConf,
            status: projections.length > 0 ? "projected" : "pending",
            projections,
            clarifyingQuestion: classification?.clarifyingQuestion || null,
          });

          // Surface the clarifying question in the chat reply when the
          // classifier is unsure AND nothing was routed. We only append
          // (never replace) so the AI's own response stays intact.
          if (
            classification?.clarifyingQuestion &&
            captureConf < 0.7 &&
            projections.length === 0 &&
            (result as any) &&
            typeof (result as any).reply === "string"
          ) {
            const existing = (result as any).reply.trim();
            const q = classification.clarifyingQuestion.trim();
            // Avoid duplicating the question if the AI already asked it.
            if (!existing.toLowerCase().includes(q.toLowerCase().slice(0, 40))) {
              (result as any).reply = existing ? `${existing}\n\n${q}` : q;
            }
          }
        }
      } catch (err) {
        console.error("[capture] failed to record chat capture:", (err as Error).message);
      }
      // Bug fix: chat may have created/updated profiles, trackers, expenses etc. via
      // internal AI tool calls. Bust the response cache BEFORE sending the response so
      // the client's onSuccess invalidate-and-refetch sees fresh DB state, not stale cache.
      clearAllCache();
      res.json(result);
    } catch (err: any) {
      const msg = err?.message || "unknown error";
      log.error("[Chat]", msg);
      // Provide actionable error messages based on error type
      const status = err?.status || err?.error?.status || 500;
      if (status === 529 || status === 503 || msg.includes('overloaded')) {
        return res.status(503).json({ error: "The AI is temporarily busy. Please try again in a few seconds.", reply: "I'm a bit overloaded right now. Could you try again in a moment?" });
      }
      if (status === 429) {
        return res.status(429).json({ error: "Rate limit reached. Please wait a moment.", reply: "I need a short break. Please try again in about 30 seconds." });
      }
      if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) {
        return res.status(504).json({ error: "Request timed out.", reply: "That took too long. Could you try a simpler question, or try again?" });
      }
      // S3 fix: never leak internal error details to clients. Log to stderr instead.
      // Previously we surfaced `detail: <raw msg>` outside production, which exposed
      // SDK errors / stack traces / DB column names if NODE_ENV was misconfigured.
      res.status(500).json({ error: "Failed to process message", reply: "Something went wrong. Please try again." });
    }
  }));

  // ---- AI Text Transform (doc editor /ai commands) ----
  app.post("/api/ai-transform", asyncHandler(async (req, res) => {
    const userId = (req as AuthenticatedRequest).userId || req.ip || 'anonymous';
    if (rateLimit(`ai-transform:${userId}`, 30)) {
      return res.status(429).json({ error: "Too many requests. Please wait a moment." });
    }
    try {
      const { command, text } = req.body || {};
      const allowed: TextTransformCommand[] = ["improve", "summarize", "continue", "shorten", "expand", "grammar"];
      if (!command || !allowed.includes(command)) {
        return res.status(400).json({ error: `command must be one of: ${allowed.join(", ")}` });
      }
      if (typeof text !== "string" || !text.trim()) {
        return res.status(400).json({ error: "text required" });
      }
      if (text.length > 5000) {
        return res.status(400).json({ error: "text too long (max 5000 characters)" });
      }
      const result = await transformText(command, sanitize(text));
      res.json({ text: result });
    } catch (err: any) {
      const msg = err?.message || "unknown error";
      log.error("[AI Transform]", msg);
      res.status(500).json({ error: "Failed to transform text" });
    }
  }));

  // ---- Receipt OCR ---- (drag a receipt photo, get expense fields)
  app.post("/api/receipt-extract", asyncHandler(async (req, res) => {
    const userId = (req as AuthenticatedRequest).userId || req.ip || 'anonymous';
    if (rateLimit(`receipt:${userId}`, 15)) {
      return res.status(429).json({ error: "Too many receipt scans. Please wait." });
    }
    try {
      const { fileData, mimeType } = req.body || {};
      if (!fileData || typeof fileData !== "string") {
        return res.status(400).json({ error: "fileData (base64 image) required" });
      }
      const mime = typeof mimeType === "string" ? mimeType : "image/jpeg";
      if (!mime.startsWith("image/")) {
        return res.status(400).json({ error: "mimeType must be an image type" });
      }
      const result = await extractReceipt(fileData, mime);
      res.json(result);
    } catch (err: any) {
      const msg = err?.message || "unknown error";
      log.error("[Receipt Extract]", msg);
      res.status(500).json({ error: "Failed to extract receipt" });
    }
  }));

  // ---- Anomaly Detection ----
  app.get("/api/anomalies", asyncHandler(async (req, res) => {
    try {
      const idsParam = req.query.profileIds as string | undefined;
      const ids = idsParam ? idsParam.split(",").filter(Boolean) : [];
      const anomalies = await detectAnomalies(storage, ids);
      res.json({ anomalies });
    } catch (err: any) {
      log.error("[Anomalies]", err?.message || err);
      res.status(500).json({ error: "Failed to detect anomalies" });
    }
  }));

  // ---- Weekly Review (manual trigger) ----
  app.post("/api/weekly-review/generate", asyncHandler(async (req, res) => {
    const userId = (req as AuthenticatedRequest).userId || req.ip || 'anonymous';
    if (rateLimit(`weekly-review:${userId}`, 5)) {
      return res.status(429).json({ error: "Weekly review already being generated. Please wait." });
    }
    try {
      const idsParam = (req.body?.profileIds ?? req.query.profileIds) as string | string[] | undefined;
      const ids = Array.isArray(idsParam)
        ? idsParam.filter(Boolean)
        : (typeof idsParam === "string" ? idsParam.split(",").filter(Boolean) : []);
      const result = await generateWeeklyReview(storage, ids);
      res.json(result);
    } catch (err: any) {
      log.error("[Weekly Review]", err?.message || err);
      res.status(500).json({ error: "Failed to generate weekly review" });
    }
  }));

  // ---- Cron: Weekly Review for all users ----
  // Hit by Vercel cron every Sunday at 14:00 UTC (configured in vercel.json).
  // Vercel cron uses GET by default. Auth via CRON_SECRET bearer token.
  // Iterates all Supabase auth users and generates a review for each.
  // S8 fix: timing-safe comparison for cron secret. The previous `===` leaked
  // information through observable response time on partial-match attempts.
  const safeEqual = (a: string, b: string) => {
    if (a.length !== b.length) return false;
    try {
      const ba = Buffer.from(a);
      const bb = Buffer.from(b);
      // crypto.timingSafeEqual requires equal lengths — already enforced above.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require("crypto").timingSafeEqual(ba, bb);
    } catch { return false; }
  };
  const cronWeeklyReview: any = asyncHandler(async (req: any, res: any) => {
    const secret = process.env.CRON_SECRET;
    const provided = (req.headers.authorization || "").replace("Bearer ", "").trim();
    if (!secret || !provided || !safeEqual(provided, secret)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      // Use admin Supabase client to list users.
      const { createClient } = await import("@supabase/supabase-js");
      const url = process.env.VITE_SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) return res.status(500).json({ error: "Supabase admin env vars missing" });
      const admin = createClient(url, key);
      const { data: usersList, error: listErr } = await (admin as any).auth.admin.listUsers({ perPage: 1000 });
      if (listErr) throw listErr;
      const users = usersList?.users || [];
      const { createScopedStorage, requestStorageContext } = await import("./storage");

      const results: Array<{ userId: string; ok: boolean; artifactId?: string; error?: string }> = [];
      for (const u of users) {
        try {
          const scoped = createScopedStorage(u.id);
          const result = await new Promise<any>((resolve, reject) => {
            requestStorageContext.run(scoped, async () => {
              try { resolve(await generateWeeklyReview(scoped)); } catch (e) { reject(e); }
            });
          });
          results.push({ userId: u.id, ok: true, artifactId: result.artifactId });
        } catch (e: any) {
          results.push({ userId: u.id, ok: false, error: e?.message || String(e) });
        }
      }
      res.json({ generated: results.filter(r => r.ok).length, total: results.length, results });
    } catch (err: any) {
      log.error("[Cron Weekly Review]", err?.message || err);
      res.status(500).json({ error: "Cron failed" });
    }
  });
  app.get("/api/cron/weekly-review", cronWeeklyReview);
  app.post("/api/cron/weekly-review", cronWeeklyReview);

  // ---- Cron: fire due reminders (BUG 3) ----
  // Vercel serverless has no always-on background, so a scheduled GET drives
  // delivery. Gated by ?key= matching CRON_SECRET. For every user, find
  // reminders whose fire_at has passed and that haven't fired, drop an in-app
  // task marker, and stamp fired_at so they don't re-fire.
  const cronFireDueReminders: any = asyncHandler(async (req: any, res: any) => {
    const secret = process.env.CRON_SECRET;
    const provided = String(req.query.key || "").trim();
    if (!secret || !provided || !safeEqual(provided, secret)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const { createClient } = await import("@supabase/supabase-js");
      const url = process.env.VITE_SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) return res.status(500).json({ error: "Supabase admin env vars missing" });
      const admin = createClient(url, key);
      const { data: usersList, error: listErr } = await (admin as any).auth.admin.listUsers({ perPage: 1000 });
      if (listErr) throw listErr;
      const users = usersList?.users || [];
      const { createScopedStorage, requestStorageContext } = await import("./storage");

      const now = new Date();
      let fired = 0;
      for (const u of users) {
        try {
          const scoped = createScopedStorage(u.id);
          await new Promise<void>((resolve) => {
            requestStorageContext.run(scoped, async () => {
              try {
                const due = await scoped.listReminders({ dueBefore: now });
                for (const r of due) {
                  // In-app marker: no notifications table exists, so surface the
                  // fired reminder as a task the user will see on the dashboard.
                  try {
                    await scoped.createTask({
                      title: `Reminder: ${r.title}`,
                      priority: "high",
                      tags: ["reminder"],
                      linkedProfiles: r.profileId ? [r.profileId] : undefined,
                      source: "reminder",
                    } as any);
                  } catch { /* marker is best-effort */ }
                  await scoped.markReminderFired(r.id);
                  fired++;
                }
              } catch { /* per-user failure shouldn't abort the run */ }
              resolve();
            });
          });
        } catch { /* skip user */ }
      }
      res.json({ fired });
    } catch (err: any) {
      log.error("[Cron Fire Reminders]", err?.message || err);
      res.status(500).json({ error: "Cron failed" });
    }
  });
  app.get("/api/cron/fire-due-reminders", cronFireDueReminders);

  // ---- Cron: daily net-worth snapshot (W4-5) ----
  // Global cross-user job. Gated by ?key= matching CRON_SECRET, runs under the
  // service_role admin client, and writes one snapshot row per profile + an
  // aggregate row for each user. Returns { snapped: N } counting users snapped.
  const cronSnapshotNetWorth: any = asyncHandler(async (req: any, res: any) => {
    const secret = process.env.CRON_SECRET;
    const provided = String(req.query.key || "").trim();
    if (!secret || !provided || !safeEqual(provided, secret)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const { createClient } = await import("@supabase/supabase-js");
      const url = process.env.VITE_SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) return res.status(500).json({ error: "Supabase admin env vars missing" });
      const admin = createClient(url, key);
      const { data: usersList, error: listErr } = await (admin as any).auth.admin.listUsers({ perPage: 1000 });
      if (listErr) throw listErr;
      const users = usersList?.users || [];
      const { createScopedStorage, requestStorageContext } = await import("./storage");

      let snapped = 0;
      for (const u of users) {
        try {
          const scoped = createScopedStorage(u.id);
          await new Promise<void>((resolve) => {
            requestStorageContext.run(scoped, async () => {
              try {
                const profiles = await scoped.getProfiles();
                // Only profiles that can carry a balance are worth a per-profile row.
                const ownerTypes = new Set(["self", "person", "vehicle", "asset", "investment", "property", "loan", "liability", "account"]);
                const profileIds = profiles.filter(p => ownerTypes.has((p as any).type)).map(p => p.id);
                const rows = await scoped.takeNetWorthSnapshot(profileIds);
                if (rows.length > 0) snapped++;
              } catch { /* per-user failure shouldn't abort the run */ }
              resolve();
            });
          });
        } catch { /* skip user */ }
      }
      res.json({ snapped });
    } catch (err: any) {
      log.error("[Cron Snapshot Net Worth]", err?.message || err);
      res.status(500).json({ error: "Cron failed" });
    }
  });
  app.get("/api/cron/snapshot-net-worth", cronSnapshotNetWorth);
  app.post("/api/cron/snapshot-net-worth", cronSnapshotNetWorth);

  // ---- Activity Feed ----
  app.get("/api/activity", asyncHandler(async (req, res) => {
    const actUserId = (req as AuthenticatedRequest).userId || undefined;
    const count = 10;
    res.json(getActionLog(count, actUserId));
  }));

  // ---- File Upload + AI Extraction ----
  // ============================================================
  // Save-only upload — user just wants the file stored as a Document
  // linked to their profile(s). No AI extraction, no analysis, no
  // tracker proposals. This is the fast path most uploads should use.
  // ============================================================
  app.post("/api/upload/save-only", asyncHandler(async (req, res) => {
    const uploadUserId = (req as AuthenticatedRequest).userId || req.ip || "anonymous";
    if (rateLimit(`upload:${uploadUserId}`, 20)) {
      return res.status(429).json({ error: "Too many uploads. Please wait." });
    }
    try {
      const { fileName, mimeType, fileData, profileIds, note } = req.body as {
        fileName: string; mimeType: string; fileData: string;
        profileIds?: string[]; note?: string;
      };
      if (!fileData || !fileName) return res.status(400).json({ error: "fileName and fileData required" });

      const MAX_FILE_SIZE = 10 * 1024 * 1024;
      const sizeBytes = Math.ceil((fileData.length * 3) / 4);
      if (sizeBytes > MAX_FILE_SIZE) return res.status(413).json({ error: "File too large (max 10MB)." });

      const ALLOWED_MIMES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "application/pdf", "text/plain", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
      if (!ALLOWED_MIMES.includes(mimeType)) return res.status(415).json({ error: `Unsupported file type: ${mimeType}.` });

      let clean = fileData;
      if (clean.includes(",")) clean = clean.split(",").pop() || clean;
      clean = clean.replace(/\s/g, "");

      const safeProfileIds: string[] = Array.isArray(profileIds)
        ? profileIds.filter((p) => typeof p === "string" && p && p !== "none")
        : [];

      const baseName = String(fileName).replace(/\.[^.]+$/, "");
      const doc = await storage.createDocument({
        name: baseName,
        type: "saved",
        mimeType,
        fileData: clean,
        extractedData: note ? { note: String(note).slice(0, 2000) } : undefined,
        linkedProfiles: safeProfileIds,
        tags: ["saved-only"],
      } as any);

      // Resolve profile names for confirmation message
      let linkedProfilesResolved: Array<{ id: string; name: string }> = [];
      if (safeProfileIds.length > 0) {
        try {
          const allProfiles = await storage.getProfiles();
          const byId = new Map(allProfiles.map((p: any) => [p.id, p.name as string]));
          linkedProfilesResolved = safeProfileIds.map((id) => ({
            id,
            name: byId.get(id) || "profile",
          }));
        } catch {
          linkedProfilesResolved = safeProfileIds.map((id) => ({ id, name: "profile" }));
        }
      }

      res.json({
        documentId: doc.id,
        documentName: doc.name,
        linkedProfiles: linkedProfilesResolved,
        savedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      log.error("[Upload.saveOnly]", err?.message || "unknown error");
      res.status(500).json({ error: "Failed to save file" });
    }
  }));

  app.post("/api/upload", asyncHandler(async (req, res) => {
    const uploadUserId = (req as AuthenticatedRequest).userId || req.ip || 'anonymous';
    if (rateLimit(`upload:${uploadUserId}`, 10)) {
      return res.status(429).json({ error: "Too many uploads. Please wait." });
    }
    try {
      const { fileName, mimeType, fileData, message, profileId } = req.body;
      if (!fileData || !fileName) {
        return res.status(400).json({ error: "fileName and fileData (base64) required" });
      }
      // Debug: log what we received
      console.log(`[Upload] File: ${fileName}, MIME: ${mimeType}, base64 length: ${fileData?.length}, first 40 chars: ${fileData?.slice(0, 40)}`);
      // File size validation: 10MB max (base64 is ~33% larger than binary)
      const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB in bytes
      const fileSizeBytes = Math.ceil((fileData.length * 3) / 4);
      if (fileSizeBytes > MAX_FILE_SIZE) {
        return res.status(413).json({ error: `File too large (${(fileSizeBytes / 1024 / 1024).toFixed(1)}MB). Maximum is 10MB.` });
      }
      // S5 fix: reject unknown MIMEs with 415 instead of normalizing to octet-stream.
      // The previous fallback could trick downstream viewers/AI parsers that trust
      // the stored MIME type into mishandling files.
      const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'application/pdf', 'text/plain', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
      if (!ALLOWED_MIMES.includes(mimeType)) {
        return res.status(415).json({ error: `Unsupported file type: ${mimeType}. Allowed: images, PDF, plain text, Word.` });
      }
      const result = await processFileUpload(fileName, mimeType, fileData, message, profileId);
      res.json(result);
    } catch (err: any) {
      log.error("[Upload]", err?.message || "unknown error");
      res.status(500).json({ error: "Failed to process upload" });
    }
  }));

  // ---- Batch File Upload + AI Extraction ----
  app.post("/api/upload/batch", asyncHandler(async (req, res) => {
    const batchUserId = (req as AuthenticatedRequest).userId || req.ip || 'anonymous';
    if (rateLimit(`upload:${batchUserId}`, 10)) {
      return res.status(429).json({ error: "Too many uploads. Please wait." });
    }
    try {
      const { files, message } = req.body;
      if (!files || !Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ error: "files array required" });
      }
      if (files.length > 20) {
        return res.status(400).json({ error: "Maximum 20 files per batch" });
      }

      const allProfiles = await storage.getProfiles();
      const profileNameMap = new Map(allProfiles.map(p => [p.id, p.name]));

      const results: Array<{
        fileName: string;
        reply: string;
        actions: ParsedAction[];
        results: any[];
        documentId?: string;
        documentPreview?: { id: string; name: string; mimeType: string; data: string };
        suggestedProfile?: { id: string; name: string } | null;
        documentType?: string;
        pendingExtraction?: any;
      }> = [];

      const linkedCounts: Record<string, number> = {};
      let unlinkedCount = 0;

      // Process files sequentially to avoid overloading the AI API
      for (const file of files) {
        const { fileName, mimeType, fileData, profileId } = file;
        if (!fileName || !fileData) {
          results.push({ fileName: fileName || "unknown", reply: "Skipped — missing fileName or fileData", actions: [], results: [] });
          continue;
        }
        // File size validation per file: 10MB max
        const fileSizeBytes = Math.ceil((fileData.length * 3) / 4);
        if (fileSizeBytes > 10 * 1024 * 1024) {
          results.push({ fileName, reply: `Skipped — file too large (${(fileSizeBytes / 1024 / 1024).toFixed(1)}MB, max 10MB)`, actions: [], results: [] });
          continue;
        }

        try {
          const result = await processFileUpload(
            fileName,
            mimeType || "image/jpeg",
            fileData,
            message,
            profileId !== "none" ? profileId : undefined
          );

          // Determine which profile it was linked to
          let suggestedProfile: { id: string; name: string } | null = null;
          // Check the actions for create_profile or update_profile to find the linked profile
          for (const action of result.actions) {
            if (action.type === "update_profile" || action.type === "create_profile") {
              const profileName = action.data?.name;
              if (profileName) {
                // Find the profile by name
                const matchedProfile = allProfiles.find(
                  p => p.name.toLowerCase() === profileName.toLowerCase()
                );
                if (matchedProfile) {
                  suggestedProfile = { id: matchedProfile.id, name: matchedProfile.name };
                }
              }
            }
          }

          // Also check reply text for "Linked to profile: XYZ"
          if (!suggestedProfile) {
            const linkedMatch = result.reply.match(/Linked to profile:\s*(.+?)(?:\n|$)/);
            if (linkedMatch) {
              const pName = linkedMatch[1].trim();
              const matchedProfile = allProfiles.find(
                p => p.name.toLowerCase() === pName.toLowerCase()
              ) || (await storage.getProfiles()).find(
                p => p.name.toLowerCase() === pName.toLowerCase()
              );
              if (matchedProfile) {
                suggestedProfile = { id: matchedProfile.id, name: matchedProfile.name };
              }
            }
          }

          // Also check explicit profileId
          if (!suggestedProfile && profileId && profileId !== "none") {
            const pName = profileNameMap.get(profileId);
            if (pName) {
              suggestedProfile = { id: profileId, name: pName };
            }
          }

          if (suggestedProfile) {
            linkedCounts[suggestedProfile.name] = (linkedCounts[suggestedProfile.name] || 0) + 1;
          } else {
            unlinkedCount++;
          }

          results.push({
            fileName,
            reply: result.reply,
            actions: result.actions,
            results: result.results,
            documentId: result.documentId,
            documentPreview: result.documentPreview,
            suggestedProfile,
            documentType: undefined, // populated from reply context
            pendingExtraction: result.pendingExtraction,
          });
        } catch (fileErr: any) {
          console.error(`Batch upload error for ${fileName}:`, fileErr.message);
          results.push({
            fileName,
            reply: `Failed to process "${fileName}": ${fileErr.message}`,
            actions: [],
            results: [],
          });
          unlinkedCount++;
        }
      }

      // Build summary
      const linkedParts = Object.entries(linkedCounts).map(
        ([name, count]) => `${count} linked to ${name}`
      );
      const parts = [...linkedParts];
      if (unlinkedCount > 0) parts.push(`${unlinkedCount} unlinked`);
      const summary = `Processed ${results.length} document${results.length !== 1 ? "s" : ""}: ${parts.length > 0 ? parts.join(", ") : "all processed"}`;

      res.json({ results, summary });
    } catch (err: any) {
      log.error("[BatchUpload]", err?.message || "unknown error");
      res.status(500).json({ error: "Failed to process batch upload" });
    }
  }));

  // ============================================================
  // SMART FILL PDF — read a PDF, match fields to user's data,
  // render a filled overlay. Safety: never overwrites original,
  // never auto-submits, never fills signature fields.
  // ============================================================
  // ============================================================
  // AI Dashboard Summary — scoped to the current profile filter so
  // "Everyone" gives a household briefing and "Selected: Sarah" gives
  // a Sarah-only briefing. Calls Anthropic directly with prebuilt
  // structured context (no tools, no side-effects).
  // ============================================================
  app.post("/api/ai/summary", asyncHandler(async (req, res) => {
    const userId = (req as AuthenticatedRequest).userId || req.ip || "anonymous";
    if (rateLimit(`aisummary:${userId}`, 30)) {
      return res.status(429).json({ error: "Too many summary requests. Please wait." });
    }
    try {
      const { filterMode, filterIds, scopeLabel } = req.body as {
        filterMode?: "all" | "selected" | "everyone";
        filterIds?: string[];
        scopeLabel?: string;
      };
      const ids = Array.isArray(filterIds) ? filterIds.filter((s) => typeof s === "string") : [];
      const useFilter = filterMode === "selected" && ids.length > 0;
      const enhanced: any = await storage.getDashboardEnhanced(undefined, useFilter ? ids : undefined);

      // Today bounds in user's TZ
      const tz = getTimezone(req);
      const todayISO = new Date().toLocaleDateString("en-CA", { timeZone: tz });
      const inNextDays = (iso: string, days: number) => {
        if (!iso) return false;
        try {
          const d = new Date(iso); const t = new Date(todayISO);
          const diff = (d.getTime() - t.getTime()) / 86400000;
          return diff >= -1 && diff <= days;
        } catch { return false; }
      };

      const fin = enhanced?.financeSnapshot || {};
      const tasksAll: any[] = Array.isArray(enhanced?.tasks) ? enhanced.tasks : [];
      const obligationsAll: any[] = Array.isArray(enhanced?.upcomingObligations) ? enhanced.upcomingObligations : (Array.isArray(fin?.upcomingBills) ? fin.upcomingBills : []);
      const habitsAll: any[] = Array.isArray(enhanced?.habits) ? enhanced.habits : [];
      const eventsAll: any[] = Array.isArray(enhanced?.events) ? enhanced.events : [];

      const tasksDueToday = tasksAll.filter((t) => t?.dueDate?.startsWith(todayISO) && !t.completed).length;
      const tasksOverdue = tasksAll.filter((t) => t?.dueDate && t.dueDate < todayISO && !t.completed).length;
      const billsThisWeek = obligationsAll.filter((b) => inNextDays(b?.nextDueDate || b?.dueDate, 7)).length;
      const eventsToday = eventsAll.filter((e) => (e?.startDate || e?.date || "").startsWith(todayISO)).length;
      const habitsToday = habitsAll.length;

      const ctx = {
        scope: useFilter ? (scopeLabel || `Selected (${ids.length})`) : "Everyone",
        finance: {
          netWorth: Math.round((fin.totalAssetValue || 0) - (fin.totalLiabilities || 0)),
          totalAssets: Math.round(fin.totalAssetValue || 0),
          totalLiabilities: Math.round(fin.totalLiabilities || 0),
          monthlySpend: Math.round(fin.totalMonthlySpend || 0),
          topSpendCategories: Array.isArray(fin.spendByCategory) ? fin.spendByCategory.slice(0, 3) : [],
        },
        today: { tasksDueToday, tasksOverdue, billsThisWeek, eventsToday, habitsTracked: habitsToday },
      };

      const prompt = `You are a personal-life dashboard briefing.
Produce a focused, useful 3-4 sentence daily briefing for THIS scope: "${ctx.scope}".
Be specific with numbers. Mention only what actually has values. Skip empty signals.
Never fabricate data not provided. End with one concrete suggestion.

CONTEXT JSON:
${JSON.stringify(ctx, null, 2)}`;

      const anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
      const resp = await anthropicClient.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      });
      const text = resp.content[0]?.type === "text" ? (resp.content[0] as any).text.trim() : "";
      res.json({
        summary: text || "No summary available.",
        scope: ctx.scope,
        scopedIds: useFilter ? ids : null,
        generatedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      log.error("[AISummary]", err?.message || "unknown");
      res.status(500).json({ error: "Couldn't generate summary right now." });
    }
  }));

  app.post("/api/smart-fill/analyze", asyncHandler(async (req, res) => {
    const uid = (req as AuthenticatedRequest).userId || req.ip || "anonymous";
    if (rateLimit(`smartfill:${uid}`, 10)) {
      return res.status(429).json({ error: "Too many Smart Fill requests. Please wait." });
    }
    try {
      const { fileName, fileData, sources, mimeType } = req.body as { fileName: string; fileData: string; sources: SmartFillSource[]; mimeType?: string };
      if (!fileName || !fileData) return res.status(400).json({ error: "fileName and fileData required" });
      const MAX_FILE_SIZE = 10 * 1024 * 1024;
      const sizeBytes = Math.ceil((fileData.length * 3) / 4);
      if (sizeBytes > MAX_FILE_SIZE) return res.status(413).json({ error: "File too large (max 10MB)." });

      const safeSources: SmartFillSource[] = Array.isArray(sources)
        ? sources.filter((s) => s && typeof s.id === "string" && ["profile", "asset", "liability", "document"].includes(s.kind)).slice(0, 12)
        : [];

      const result = await analyzeSmartFill(fileName, fileData, safeSources, mimeType || "application/pdf");
      res.json(result);
    } catch (err: any) {
      log.error("[SmartFill.analyze]", err?.message || "unknown error");
      res.status(500).json({ error: "Smart Fill analysis failed. Try again." });
    }
  }));

  app.post("/api/smart-fill/render", asyncHandler(async (req, res) => {
    const uid = (req as AuthenticatedRequest).userId || req.ip || "anonymous";
    if (rateLimit(`smartfill:${uid}`, 10)) {
      return res.status(429).json({ error: "Too many Smart Fill requests. Please wait." });
    }
    try {
      const {
        fileName, fileData, fields, documentName,
        linkedProfileIds, dates, sources, mimeType,
      } = req.body as {
        fileName: string;
        fileData: string;
        fields: FillFieldInput[];
        documentName?: string;
        linkedProfileIds?: string[];
        dates?: Array<{ pdfLabel: string; iso: string; kind: "expiration" | "renewal" | "due" | "appointment" }>;
        sources?: SmartFillSource[];
        mimeType?: string;
      };
      if (!fileName || !fileData || !Array.isArray(fields)) return res.status(400).json({ error: "fileName, fileData, fields required" });
      const safeFields = fields
        .filter((f) => f && typeof f.pdfLabel === "string")
        .slice(0, 200)
        .map((f) => ({
          pdfLabel: String(f.pdfLabel).slice(0, 120),
          value: String(f.value ?? "").slice(0, 500),
          fieldKind: f.fieldKind,
          acroFormName: f.acroFormName,
        }));

      // For image-of-form uploads, skip PDF rendering and save the original image
      // with the filled fields as structured extractedData (no PDF overlay possible).
      const isImage = (mimeType || "").startsWith("image/");
      let filledBase64: string;
      let outMime: string;
      if (isImage) {
        let cleanInput = fileData;
        if (cleanInput.includes(",")) cleanInput = cleanInput.split(",").pop() || cleanInput;
        filledBase64 = cleanInput.replace(/\s/g, "");
        outMime = mimeType || "image/png";
      } else {
        const filledBytes = await renderFilledPdf(fileData, safeFields);
        filledBase64 = Buffer.from(filledBytes).toString("base64");
        outMime = "application/pdf";
      }

      // Save as a new Document — original is preserved (never overwritten).
      const baseName = (documentName || fileName).replace(/\.[^.]+$/, "");
      const newDoc = await storage.createDocument({
        name: `${baseName} — Smart Filled`,
        type: "smart_fill",
        mimeType: outMime,
        fileData: filledBase64,
        extractedData: {
          smartFill: {
            originalName: fileName,
            originalMimeType: mimeType || "application/pdf",
            filledAt: new Date().toISOString(),
            fieldCount: safeFields.length,
            sources: Array.isArray(sources) ? sources.map((s) => ({ id: s.id, kind: s.kind, name: s.name })) : [],
            // For image forms, preserve the structured fields directly since we can’t overlay them.
            fields: isImage ? safeFields : undefined,
          },
        },
        linkedProfiles: Array.isArray(linkedProfileIds) ? linkedProfileIds.filter((id) => typeof id === "string") : [],
        tags: ["smart-fill"],
      });

      // Auto-create an Obligation for any expiration / renewal / due date we extracted.
      const createdObligations: Array<{ id: string; name: string; nextDueDate: string; kind: string }> = [];
      if (Array.isArray(dates)) {
        for (const d of dates) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(d?.iso || "")) continue;
          const kind: "doc_expiration" | "bill" | "appointment" =
            d.kind === "expiration" || d.kind === "renewal" ? "doc_expiration"
            : d.kind === "appointment" ? "appointment"
            : "bill";
          try {
            const ob = await storage.createObligation({
              name: `${baseName} — ${d.pdfLabel || d.kind}`,
              kind,
              amount: 0,
              frequency: "yearly",
              category: "document",
              nextDueDate: d.iso,
              linkedDocumentId: newDoc.id,
              linkedProfiles: Array.isArray(linkedProfileIds) ? linkedProfileIds.filter((id) => typeof id === "string") : [],
              status: "active",
              autopay: false,
              autoLogExpense: false,
              leadTimeDays: 30,
            } as any);
            createdObligations.push({ id: ob.id, name: ob.name, nextDueDate: ob.nextDueDate, kind: ob.kind });
          } catch (e) {
            log.error("[SmartFill.render] obligation create failed", (e as any)?.message || e);
          }
        }
      }

      res.json({
        documentId: newDoc.id,
        documentName: newDoc.name,
        fileBase64: filledBase64,
        createdObligations,
      });
    } catch (err: any) {
      log.error("[SmartFill.render]", err?.message || "unknown error");
      res.status(500).json({ error: "Failed to fill PDF. Try again." });
    }
  }));

  // ---- Confirm Extraction (two-phase: user approves fields before saving) ----
  app.post("/api/chat/confirm-extraction", asyncHandler(async (req, res) => {
    try {
      const { extractionId, confirmedFields, targetProfileId, createCalendarEvents, trackerEntries } = req.body;
      if (!extractionId) {
        return res.status(400).json({ error: "extractionId required" });
      }

      // Ownership: extractionId must point to a document owned by this user.
      const extractionDoc = await storage.getDocument(extractionId);
      if (!extractionDoc) {
        return res.status(404).json({ error: "Resource not found" });
      }

      // If a targetProfileId was supplied by the client, verify it belongs to this user.
      if (targetProfileId) {
        const ownedProfile = await storage.getProfile(targetProfileId);
        if (!ownedProfile) {
          return res.status(404).json({ error: "Resource not found" });
        }
      }

      log.info(`[confirm-extraction] extractionId=${extractionId}, fields=${confirmedFields?.length || 0}, profileId=${targetProfileId || 'NONE'}, events=${createCalendarEvents?.length || 0}, trackers=${trackerEntries?.length || 0}`);

      // If no profile was selected, AI-pick the best profile from extracted fields.
      // Falls back to self profile (legacy behaviour) if AI can't decide.
      let resolvedProfileId = targetProfileId;
      let resolvedProfileSource: "caller" | "ai" | "self-default" | "none" = targetProfileId ? "caller" : "none";
      if (!resolvedProfileId && confirmedFields && confirmedFields.length > 0) {
        const profiles = await storage.getProfiles();
        if (profiles.length > 0) {
          // Wave 2 #4 — AI picks the best profile from extracted name-ish fields.
          try {
            const nameish = confirmedFields
              .filter((f: any) => /name|holder|owner|insured|patient|recipient|licensee|driver|policyhold/i.test(f.key))
              .map((f: any) => `${f.key}: ${unwrap(f.value)}`)
              .join("\n");
            if (nameish) {
              const decision = await aiPickIndex({
                task: "confirm-extraction-profile",
                question: "Which profile do these extracted fields belong to? Pick -1 only if no profile matches.",
                context: nameish,
                options: profiles.map((p: any) => `${p.name}${p.relationship ? ` (${p.relationship})` : ""}${p.dateOfBirth ? ` DOB ${p.dateOfBirth}` : ""}`),
                timeoutMs: 3000,
                minConfidence: 0.6,
                fallback: () => -1,
              });
              if (decision.value.index >= 0 && profiles[decision.value.index]) {
                resolvedProfileId = profiles[decision.value.index].id;
                resolvedProfileSource = "ai";
                log.info(`[confirm-extraction] AI-picked profile: ${profiles[decision.value.index].name} (${resolvedProfileId}) reason="${decision.value.reason}"`);
              }
            }
          } catch (e: any) {
            console.error(`[confirm-extraction] AI profile-pick failed silently: ${e?.message || e}`);
          }
        }
        if (!resolvedProfileId) {
          const selfProfile = profiles.find((p: any) => p.type === 'self');
          if (selfProfile) {
            resolvedProfileId = selfProfile.id;
            resolvedProfileSource = "self-default";
            log.info(`[confirm-extraction] Fell back to self profile: ${selfProfile.name} (${selfProfile.id})`);
          }
        }
      }

      const saved: string[] = [];
      // Track per-step failures so the response surfaces them instead of
      // pretending everything worked. Previously these errors were caught
      // and only logged, then the route returned `success: true`.
      const failures: string[] = [];

      // Helper: unwrap {value, confidence} objects into plain values
      const unwrap = (v: any) => (v && typeof v === 'object' && 'value' in v) ? v.value : v;

      // ═══ INTELLIGENT DATA ROUTING ═══
      // Each extracted field gets routed to the correct destination based on what it IS.
      // The document always keeps ALL data as the source of truth.

      // Step 0: ALWAYS save all confirmed fields to the document's extractedData (source of truth)
      if (confirmedFields && confirmedFields.length > 0) {
        try {
          const doc = await storage.getDocument(extractionId);
          if (doc) {
            const updatedData: Record<string, any> = { ...(doc.extractedData || {}) };
            for (const field of confirmedFields) {
              updatedData[field.key] = unwrap(field.value);
            }
            await storage.updateDocument(extractionId, { extractedData: updatedData });
            saved.push(`Saved ${confirmedFields.length} fields to document`);
          }
        } catch (e: any) {
          console.error("Failed to save fields to document:", e.message);
          failures.push(`document fields: ${e?.message || "unknown error"}`);
        }
      }

      // Step 1: Classify each field and route to the correct destination
      if (confirmedFields && confirmedFields.length > 0) {
        // Document-metadata fields that should NOT be saved to profiles
        const DOC_ONLY_FIELDS = new Set(['fileName', 'barcode', 'signatureType', 'documentTitle', 'reportTitle', 'signedBy', 'electronicSignature', 'electronicallySignedBy', 'facilityAddress']);

        // Wave 2 #5 — AI extra classification for fields NOT already in DOC_ONLY_FIELDS.
        // For each unfamiliar field, AI returns one of: "profile_fact" (default),
        // "doc_only" (extra DOC_ONLY treatment), or "skip" (junk). Single batched call.
        // Result is a Map<fieldKey, classification>; profile_fact preserves current behaviour.
        const aiFieldClassification = new Map<string, "profile_fact" | "doc_only" | "skip">();
        try {
          const unknownFields = confirmedFields
            .map((f: any) => f.key)
            .filter((k: string) => !DOC_ONLY_FIELDS.has(k));
          if (unknownFields.length > 0) {
            const dec = await aiDecide<Record<string, string>>({
              task: "field-destination-route",
              system: `You decide where each extracted field should live in a personal-finance / life-management app.
Return ONLY a JSON object mapping each field key (string) to one of these classifications:
  - "profile_fact"  — a stable attribute of the person/entity (name, DOB, address, license #, blood type, employer, etc.)
  - "doc_only"      — metadata that only makes sense on the document itself (barcode, page count, signature image ID, file checksum, etc.)
  - "skip"          — obvious junk / unparseable / placeholder values ("N/A", empty form labels, OCR noise)
If unsure, return "profile_fact".`,
              user: `Classify these field keys:\n${JSON.stringify(unknownFields)}\n\nReturn JSON only.`,
              timeoutMs: 3000,
              maxTokens: Math.min(800, 30 + unknownFields.length * 18),
              fallback: () => {
                const out: Record<string, string> = {};
                for (const k of unknownFields) out[k] = "profile_fact";
                return out;
              },
              validate: (p: any) => p && typeof p === "object" && !Array.isArray(p),
            });
            for (const [k, v] of Object.entries(dec.value)) {
              const c = (v === "profile_fact" || v === "doc_only" || v === "skip") ? v : "profile_fact";
              aiFieldClassification.set(k, c as any);
            }
            log.info(`[confirm-extraction] AI classified ${aiFieldClassification.size} fields via ${dec.source} in ${dec.durationMs}ms`);
          }
        } catch (e: any) {
          console.error(`[confirm-extraction] AI field classification failed silently: ${e?.message || e}`);
        }

        const profileFields: Record<string, any> = {};

        // Smart type coercion: convert string values to appropriate JS types
        function coerceValue(key: string, val: any): any {
          if (val === null || val === undefined || val === '') return val;
          const s = String(val).trim();

          // Boolean detection
          if (s === 'true' || s === 'True' || s === 'TRUE') return true;
          if (s === 'false' || s === 'False' || s === 'FALSE') return false;

          // Currency: strip $, commas, then parse as number
          const currencyMatch = s.match(/^\$?([\d,]+\.?\d*)$/);
          if (currencyMatch) {
            const num = parseFloat(currencyMatch[1].replace(/,/g, ''));
            if (!isNaN(num)) return num;
          }

          // Pure number (no currency symbol)
          if (/^-?\d+(\.\d+)?$/.test(s)) {
            return parseFloat(s);
          }

          // Keep strings as strings
          return s;
        }

        for (const field of confirmedFields) {
          const key = field.key;
          const val = unwrap(field.value);

          // Skip document-metadata fields — they belong on the document, not the profile
          if (DOC_ONLY_FIELDS.has(key)) continue;
          // Wave 2 #5: respect AI classification — skip junk + doc-only without altering profile.
          const aiClass = aiFieldClassification.get(key);
          if (aiClass === "doc_only" || aiClass === "skip") continue;

          // Normalize keys: dateOfBirth/dob → save as both dateOfBirth AND birthday
          if (key === 'dateOfBirth' || key === 'dob') {
            profileFields['dateOfBirth'] = coerceValue(key, val);
            profileFields['birthday'] = coerceValue(key, val);
          } else if (key === 'patientName') {
            // patientName → save as 'name' only if profile doesn't already have one
            // (checked below when we have the profile object)
            profileFields['_patientName'] = coerceValue(key, val);
          } else {
            profileFields[key] = coerceValue(key, val);
          }
        }

        // Save to the resolved profile
        if (resolvedProfileId && Object.keys(profileFields).length > 0) {
          const profile = await storage.getProfile(resolvedProfileId);
          if (profile) {
            const existingFields = profile.fields || {};

            // Handle patientName → name normalization
            if (profileFields['_patientName']) {
              const patientNameVal = profileFields['_patientName'];
              delete profileFields['_patientName'];
              if (!existingFields['name'] && !profile.name) {
                profileFields['name'] = patientNameVal;
              }
              // Always store patientName as well for reference
              profileFields['patientName'] = patientNameVal;
            }

            await storage.updateProfile(resolvedProfileId, {
              fields: { ...existingFields, ...profileFields },
            });
            saved.push(`Saved ${Object.keys(profileFields).length} fields to ${profile.name}`);
            log.info(`[confirm-extraction] Routed ${Object.keys(profileFields).length} fields to profile ${profile.name}`);

            // Link the document to the profile
            try {
              await storage.linkProfileTo(resolvedProfileId, "document", extractionId);
              await storage.propagateDocumentToAncestors(extractionId, resolvedProfileId);
            } catch { /* may already be linked */ }
          }
        }
      }

      // 2. Create calendar events for confirmed date fields
      if (createCalendarEvents && createCalendarEvents.length > 0) {
        for (const event of createCalendarEvents) {
          try {
            // Parse date from the field value. Uses the shared parser so
            // printed forms like "6/4/2029" (single-digit month/day) and
            // "Jun 4, 2029" normalize correctly instead of being dropped.
            const dateStr = normalizeDateString(event.date);
            if (!dateStr) continue;
            await storage.createEvent({
              title: event.title || `📅 ${event.field}`,
              date: dateStr,
              time: undefined,
              endTime: undefined,
              description: `Auto-created from document extraction (${event.field})`,
              location: undefined,
              allDay: true,
              category: event.category || "other",
              recurrence: "none",
              recurrenceEnd: undefined,
              color: undefined,
              linkedProfiles: resolvedProfileId ? [resolvedProfileId] : [],
              linkedDocuments: [extractionId],
              tags: ["document-extraction"],
              source: "chat",
            });
            saved.push(`Created event: ${event.title || event.field}`);
          } catch (evErr: any) {
            console.error("Failed to create calendar event from extraction:", evErr.message);
            failures.push(`calendar event "${event.title || event.field}": ${evErr?.message || "unknown error"}`);
          }
        }
      }

      // 3. Log tracker entries
      if (trackerEntries && trackerEntries.length > 0) {
        // ── Consolidate multi-component vitals BEFORE creating trackers ──
        // Medical reports list "Systolic Blood Pressure" and "Diastolic Blood
        // Pressure" as SEPARATE rows. Creating a tracker per row yields two
        // single-value trackers that the dashboard flags as an "incomplete
        // reading". Blood pressure is ONE measurement with two components, so
        // merge systolic + diastolic rows into a single "Blood Pressure" entry
        // (values:{systolic,diastolic}) that stores, charts, and reads as a
        // complete reading.
        const firstNum = (v: any): number | undefined => {
          if (v && typeof v === "object") {
            for (const k of Object.keys(v)) { const n = Number((v as any)[k]); if (isFinite(n)) return n; }
            return undefined;
          }
          const n = Number(v); return isFinite(n) ? n : undefined;
        };
        let bpSys: number | undefined, bpDia: number | undefined;
        const nonBpEntries: any[] = [];
        for (const e of trackerEntries) {
          const nm = String(e?.trackerName || "").toLowerCase();
          const vals = (e?.values && typeof e.values === "object") ? e.values : {};
          // Component rows: name says systolic/diastolic, OR a value key does.
          const sysFromKey = (vals as any).systolic ?? (vals as any).sbp;
          const diaFromKey = (vals as any).diastolic ?? (vals as any).dbp;
          if (/diastolic|\bdbp\b/.test(nm)) { bpDia = firstNum(e.values) ?? bpDia; continue; }
          if (/systolic|\bsbp\b/.test(nm)) { bpSys = firstNum(e.values) ?? bpSys; continue; }
          // A combined row that already carries both keys → leave intact, but
          // harvest the components so we don't also emit a partial second one.
          if (sysFromKey != null || diaFromKey != null) {
            if (sysFromKey != null) bpSys = Number(sysFromKey);
            if (diaFromKey != null) bpDia = Number(diaFromKey);
            if (sysFromKey != null && diaFromKey != null) continue; // fully covered by merged entry
          }
          nonBpEntries.push(e);
        }
        let normalizedTrackerEntries = trackerEntries;
        if (bpSys != null || bpDia != null) {
          const bpValues: Record<string, number> = {};
          if (bpSys != null) bpValues.systolic = bpSys;
          if (bpDia != null) bpValues.diastolic = bpDia;
          normalizedTrackerEntries = [
            ...nonBpEntries,
            { trackerName: "Blood Pressure", values: bpValues, unit: "mmHg", category: "health" },
          ];
        }
        for (const entry of normalizedTrackerEntries) {
          try {
            // Find or create the tracker
            const trackers = await storage.getTrackers();
            const humanName = (entry.trackerName || "").replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
            const normName = (entry.trackerName || "").toLowerCase().replace(/[_\s]/g, "");
            let tracker = trackers.find(
              (t: any) => t.name.toLowerCase().replace(/[_\s]/g, "") === normName
                && (resolvedProfileId
                    ? (t.linkedProfiles || []).some((pid: string) => pid === resolvedProfileId)
                    : true)
            );
            if (!tracker) {
              const fieldKeys = Object.keys(entry.values || {});
              tracker = await storage.createTracker({
                name: humanName,
                unit: entry.unit || "",
                category: entry.category || "health",
                fields: fieldKeys.length > 0
                  ? fieldKeys.map((k: string, i: number) => ({
                      name: k,
                      type: "number" as const,
                      unit: entry.unit || "",
                      isPrimary: i === 0,
                      options: [],
                    }))
                  : [{ name: "value", type: "number" as const, unit: entry.unit || "", isPrimary: true, options: [] }],
                // Pass linkedProfiles directly so createTracker doesn't default to "Me"
                linkedProfiles: resolvedProfileId ? [resolvedProfileId] : [],
              } as any);
              saved.push(`Created tracker: ${humanName}`);
            } else if (resolvedProfileId) {
              // Tracker already exists — ensure it's linked to the target profile
              const currentLinked = tracker.linkedProfiles || [];
              if (!currentLinked.includes(resolvedProfileId)) {
                try {
                  await storage.updateTracker(tracker.id, { linkedProfiles: [...currentLinked, resolvedProfileId] } as Partial<Tracker>);
                } catch { /* non-critical */ }
              }
            }
            // Log the entry with proper values object — run through the
            // shared normalizer so document-extracted entries land in the
            // exact same shape as chat-logged entries (same field names,
            // same units, no "99°F" raw strings).
            const rawValues = entry.values && typeof entry.values === "object" ? entry.values : { value: entry.values || 0 };
            const { values: entryValues, warnings: normWarnings } = normalizeTrackerEntry(tracker as any, rawValues);
            if (normWarnings.length > 0) {
              console.log(`[extraction normalize] ${tracker.name}: ${normWarnings.join("; ")}`);
            }
            await storage.logEntry({
              trackerId: tracker.id,
              values: entryValues,
              notes: `From document extraction`,
              profileId: resolvedProfileId,
            });
            saved.push(`Logged ${humanName}: ${Object.entries(entryValues).map(([k, v]) => `${k}=${v}`).join(", ")}`);
          } catch (tErr: any) {
            console.error("Failed to log tracker entry from extraction:", tErr.message);
            failures.push(`tracker entry "${entry.trackerName}": ${tErr?.message || "unknown error"}`);
          }
        }
      }

      // Create expense if user confirmed
      if (req.body.createExpense) {
        try {
          const exp = req.body.createExpense;
          const amt = parseFloat(exp.amount);
          if (!isFinite(amt) || amt <= 0) {
            throw new Error("Expense amount must be a positive number");
          }
          const expense = await storage.createExpense({
            description: exp.description,
            amount: amt,
            category: exp.category || 'general',
            vendor: exp.vendor,
            date: exp.date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }),
            tags: [],
            linkedProfiles: resolvedProfileId ? [resolvedProfileId] : [],
          });
          saved.push(`Created expense: $${amt.toFixed(2)} ${exp.description}`);
          // Link document to expense
          try { await storage.linkProfileTo(expense.id, "document", extractionId); } catch {}
        } catch (eErr: any) {
          console.error("Failed to create expense from extraction:", eErr?.message);
          failures.push(`expense: ${eErr?.message || "unknown error"}`);
        }
      }

      // Create obligation if user confirmed
      if (req.body.createObligation) {
        try {
          const obl = req.body.createObligation;
          const amt = parseFloat(obl.amount);
          if (!isFinite(amt) || amt <= 0) {
            throw new Error("Obligation amount must be a positive number");
          }
          if (!obl.nextDueDate) {
            throw new Error("Obligation requires a next due date");
          }
          await storage.createObligation({
            name: obl.name,
            amount: amt,
            frequency: obl.frequency || 'monthly',
            category: obl.category || 'general',
            nextDueDate: obl.nextDueDate,
            autopay: false,
            linkedProfiles: resolvedProfileId ? [resolvedProfileId] : [],
          });
          saved.push(`Created bill: $${amt.toFixed(2)}/${obl.frequency || 'mo'} ${obl.name}`);
        } catch (oErr: any) {
          console.error("Failed to create obligation from extraction:", oErr?.message);
          failures.push(`obligation: ${oErr?.message || "unknown error"}`);
        }
      }

      // Bust caches BEFORE responding so client's invalidate-and-refetch sees fresh state.
      clearAllCache();

      // If nothing succeeded but at least one thing was attempted-and-failed,
      // surface as 500 so the client shows a real error.
      const attempted = (confirmedFields?.length || 0) + (createCalendarEvents?.length || 0) + (trackerEntries?.length || 0) + (req.body.createExpense ? 1 : 0) + (req.body.createObligation ? 1 : 0);
      if (attempted > 0 && saved.length === 0 && failures.length > 0) {
        return res.status(500).json({
          success: false,
          error: "Confirmation failed",
          message: failures.join("; "),
          failures,
        });
      }

      // Partial success: 207-style — return success but include failures so the
      // client can warn the user that some pieces didn't save.
      res.json({
        success: failures.length === 0,
        message: saved.length > 0
          ? `Confirmed: ${saved.join("; ")}${failures.length > 0 ? ` — but ${failures.length} step(s) failed: ${failures.join("; ")}` : ""}`
          : (failures.length > 0 ? `All steps failed: ${failures.join("; ")}` : "No fields to save"),
        saved,
        failures,
      });
    } catch (err: any) {
      log.error("[ConfirmExtraction]", err?.message || "unknown error");
      res.status(500).json({ error: "Failed to confirm extraction" });
    }
  }));

  // ---- Dashboard ----
  // Ownership consolidation invariant probe (Stage 6 guardrail). Returns the
  // count of entity rows for this user whose JSONB linked_profiles disagrees
  // with the matching profile_<type> junction table. After Stage 2 backfill
  // this is 0 everywhere; the smoke contract asserts it stays 0.
  app.get("/api/diagnostics/ownership-consistency", asyncHandler(async (req, res) => {
    if (typeof (storage as any).getOwnershipConsistency !== "function") {
      return res.status(501).json({ error: "not implemented" });
    }
    const result = await (storage as any).getOwnershipConsistency();
    res.json(result);
  }));

  // [P0.5] Per-user ownership repair — re-syncs JSONB linked_profiles with the
  // junction tables for the authenticated user's rows. Authenticated like every
  // other /api route (global authMiddleware); NOT superadmin-gated because it
  // only touches the caller's own data.
  app.post("/api/admin/ownership-repair", asyncHandler(async (req, res) => {
    if (typeof (storage as any).repairOwnershipConsistency !== "function") {
      return res.status(501).json({ error: "Ownership repair is not available: storage.repairOwnershipConsistency is not implemented in this deployment" });
    }
    try {
      const summary = await (storage as any).repairOwnershipConsistency();
      // Repair may rewrite linked_profiles on any entity type — drop all caches.
      bustAllCaches();
      res.json({ success: true, summary });
    } catch (err: any) {
      log.error("[OwnershipRepair]", err?.message || err);
      res.status(500).json({ error: "Ownership repair failed" });
    }
  }));

  app.get("/api/stats", asyncHandler(async (req, res) => {
    const profileIdsParam = req.query.profileIds as string | undefined;
    const profileId = req.query.profileId as string | undefined;
    const filterIds = profileIdsParam ? profileIdsParam.split(",").filter(Boolean) : (profileId ? [profileId] : undefined);
    const userId = cacheUserKey(req as AuthenticatedRequest);
    const cacheKey = `stats:${userId}:${filterIds?.join(",") || "all"}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);
    // PERF 2026-05-30: enable per-request memo so getStats's internal ~10
    // Supabase fanouts share fetched tables (profiles/expenses/trackers/...).
    // Cold /api/stats?profileIds=Craig was measured at 8-12s before; with
    // memo it should match the bootstrap path's ~1.5s.
    try { (storage as any).enableRequestMemo?.(); } catch {}
    // dedupe: concurrent identical requests share one DB query
    const stats = await dedupe(cacheKey, () => storage.getStats(undefined, filterIds));
    try { (storage as any).disableRequestMemo?.(); } catch {}
    // 60-second cache. cacheBustMiddleware drops it synchronously on any mutation
    // (including AI-driven /api/chat and /api/upload paths), so this cannot serve
    // stale data after a write. Longer TTL = many more page navigations served
    // from cache without re-aggregating ~10 supabase queries each time.
    setCache(cacheKey, stats, 60 * 1000);
    res.json(stats);
  }));

  app.get("/api/dashboard-enhanced", asyncHandler(async (req, res) => {
    const profileIdsParam = req.query.profileIds as string | undefined;
    const profileId = req.query.profileId as string | undefined;
    const filterIds = profileIdsParam ? profileIdsParam.split(",").filter(Boolean) : (profileId ? [profileId] : undefined);
    const userId = cacheUserKey(req as AuthenticatedRequest);
    const cacheKey = `enhanced:${userId}:${filterIds?.join(",") || "all"}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);
    // PERF 2026-05-30: same memo treatment as /api/stats so getDashboardEnhanced's
    // internal fanouts share fetched tables.
    try { (storage as any).enableRequestMemo?.(); } catch {}
    // dedupe: concurrent identical requests share one DB query
    const data = await dedupe(cacheKey, () => storage.getDashboardEnhanced(undefined, filterIds));
    try { (storage as any).disableRequestMemo?.(); } catch {}
    // 60-second cache (same rationale as /api/stats above).
    setCache(cacheKey, data, 60 * 1000);
    res.json(data);
  }));

  // ---- Net Worth History (powers the dashboard hero trend line + MoM %) ----
  // The client has long called this endpoint (with a graceful []-fallback) but
  // it was never registered, so the hero chart had no data. Returns the daily
  // net-worth snapshot series. When exactly one profile is selected we return
  // that profile's per-profile series; otherwise the account aggregate.
  app.get("/api/net-worth/history", asyncHandler(async (req, res) => {
    const profileIdsParam = req.query.profileIds as string | undefined;
    const profileId = req.query.profileId as string | undefined;
    const ids = profileIdsParam ? profileIdsParam.split(",").filter(Boolean) : (profileId ? [profileId] : []);
    const lookbackDays = Math.min(400, Math.max(1, parseInt(String(req.query.lookbackDays || "120"), 10) || 120));
    const pid = ids.length === 1 ? ids[0] : undefined;
    try {
      const rows = typeof (storage as any).getNetWorthHistory === "function"
        ? await (storage as any).getNetWorthHistory(pid, lookbackDays)
        : [];
      res.json(Array.isArray(rows) ? rows : []);
    } catch {
      res.json([]);
    }
  }));

  // ---- Dashboard Bootstrap (PERF 2026-05-28) ----
  // Single round-trip that returns everything the dashboard skeleton blocks
  // on: stats, enhanced, profiles, incomes, budget summary. Each individual
  // endpoint still works (and is still used after mutations), but the cold
  // load fires *this* first and pre-fills the react-query cache so the UI
  // skips ~9 of the 10 parallel network calls it used to make.
  //
  // Why one endpoint matters: on Vercel each /api/* hit is its own serverless
  // invocation. Even though they run in parallel, each one pays the cold-start
  // + auth-middleware + Supabase-client-init tax. Folding them into a single
  // handler means one cold-start total and the underlying Promise.all of
  // storage calls share data instead of re-fetching profiles/expenses/etc.
  // multiple times across handlers.
  app.get("/api/dashboard-bootstrap", asyncHandler(async (req, res) => {
    const profileIdsParam = req.query.profileIds as string | undefined;
    const profileId = req.query.profileId as string | undefined;
    const filterIds = profileIdsParam ? profileIdsParam.split(",").filter(Boolean) : (profileId ? [profileId] : undefined);
    const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
    const userId = cacheUserKey(req as AuthenticatedRequest);
    const filterKey = filterIds?.join(",") || "all";
    const cacheKey = `bootstrap:${userId}:${filterKey}:${month}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const data = await dedupe(cacheKey, async () => {
      // PERF: enable per-request memoization on the scoped storage so that
      // getStats() + getDashboardEnhanced() + the lightweight Promise.all
      // share a single Supabase fetch per table (profiles/expenses/trackers/
      // tasks/events/obligations/etc) instead of refetching each one 2-3x.
      // Safe because storage is request-scoped via createScopedStorage and
      // memo is opt-in (default OFF).
      try { (storage as any).enableRequestMemo?.(); } catch {}

      // PERF: reuse the per-endpoint server caches so bootstrap is cheap when
      // /api/stats or /api/dashboard-enhanced have been hit in the last 15s.
      const statsCacheKey = `stats:${userId}:${filterKey}`;
      const enhancedCacheKey = `enhanced:${userId}:${filterKey}`;

      // Each of getStats() and getDashboardEnhanced() internally fans out to
      // ~10 Supabase queries. Running them parallel inside one handler doubles
      // in-flight load and saturates the connection pool, making the bootstrap
      // SLOWER than calling them separately. Instead: fetch the lightweight
      // pieces (profiles/incomes/expenses/budgets) in parallel with stats,
      // then enhanced serially. Total wall = max(stats, lightweight) + enhanced.
      const cachedStats = getCached(statsCacheKey);
      const cachedEnhanced = getCached(enhancedCacheKey);

      const [stats, profiles, incomes, expensesForBudget, budgets, obligationsAll, assetPartyLinks, liabilityProfileLinks] = await Promise.all([
        cachedStats ?? dedupe(statsCacheKey, async () => {
          const s = await storage.getStats(undefined, filterIds);
          setCache(statsCacheKey, s, 60 * 1000);
          return s;
        }),
        storage.getProfiles(),
        storage.getIncomes ? storage.getIncomes() : Promise.resolve([] as any[]),
        storage.getExpenses(),
        storage.getBudgets ? storage.getBudgets(month, filterIds) : Promise.resolve([] as any[]),
        // [PERF 2026-06-10] Seed payloads: the dashboard fired ~12 separate
        // GETs on mount — on serverless each parallel request can hit its own
        // cold instance. Bootstrap now carries every mount-time dataset so the
        // client seeds its query cache from ONE round trip.
        (storage as any).getObligations ? (storage as any).getObligations() : Promise.resolve([] as any[]),
        (storage as any).getAssetPartyLinks ? (storage as any).getAssetPartyLinks() : Promise.resolve([] as any[]),
        (storage as any).getLiabilityProfileLinks ? (storage as any).getLiabilityProfileLinks() : Promise.resolve([] as any[]),
      ]);

      const enhanced = cachedEnhanced ?? await dedupe(enhancedCacheKey, async () => {
        const e = await storage.getDashboardEnhanced(undefined, filterIds);
        setCache(enhancedCacheKey, e, 60 * 1000);
        return e;
      });

      // BUG-20260528-profile-filter-leakage: previously inline orphan check
      // diverged from canonical passesProfileFilter. Replaced with shared
      // function so /api/dashboard-bootstrap matches /api/expenses exactly.
      const filteredExpenses = (!filterIds || filterIds.length === 0)
        ? expensesForBudget
        : expensesForBudget.filter((e: any) =>
            passesProfileFilter(e.linkedProfiles, { selectedIds: filterIds, allProfiles: profiles })
          );
      const monthExpenses = filteredExpenses.filter((e: any) => (e.date || "").slice(0, 7) === month);
      const totalSpent = monthExpenses.reduce((s: number, e: any) => s + (e.amount || 0), 0);
      // BUG (user report 2026-06-27 "Craig has no budget but it shows $2,150"):
      // budgets were fetched UNSCOPED here (getBudgets(month) without filterIds),
      // so totalBudget summed every profile's budget regardless of the active
      // filter while totalSpent above was correctly scoped. The mismatched
      // budgetSummary then got seeded into the scoped query key, showing the
      // global budget total ($2,150 = Bob + Mike) on a profile (Craig) that owns
      // none. Scope budgets the same way GET /api/budgets does: getBudgets now
      // receives filterIds (returns matching + shared/null entries), then drop
      // the shared/null entries unless a self profile is in the selection.
      const selfIds = new Set(profiles.filter((p: any) => p.type === "self").map((p: any) => p.id));
      const selfInSel = !!filterIds && filterIds.some((id: string) => selfIds.has(id));
      const scopedBudgets = (!filterIds || filterIds.length === 0 || selfInSel)
        ? (budgets || [])
        : (budgets || []).filter((b: any) => b.profileId);
      const totalBudget = scopedBudgets.reduce((s: number, b: any) => s + (b.amount || 0), 0);
      const remaining = totalBudget - totalSpent;

      // BUG-20260528-profile-filter-leakage: same fix for incomes path.
      const filteredIncomes = (!filterIds || filterIds.length === 0)
        ? incomes
        : incomes.filter((i: any) =>
            passesProfileFilter(i.linkedProfiles, { selectedIds: filterIds, allProfiles: profiles })
          );

      return {
        stats,
        enhanced,
        profiles,
        incomes: filteredIncomes,
        budgetSummary: { totalBudget, totalSpent, remaining },
        // [PERF 2026-06-10] mount-time seed datasets — shapes mirror the
        // corresponding GET endpoints exactly (same canonical profile filter).
        // Expenses are seeded in FULL (not a 100-row first page) so the Finance
        // page total — computed client-side over this set — is correct on first
        // paint, matching the now full-by-default /api/expenses endpoint. Other
        // lists keep their first-page seed; only expenses drive a client total.
        expenses: filteredExpenses,
        budgets: scopedBudgets,
        obligations: ((!filterIds || filterIds.length === 0)
          ? obligationsAll
          : obligationsAll.filter((o: any) =>
              passesProfileFilter(o.linkedProfiles, { selectedIds: filterIds, allProfiles: profiles })
            )).slice(0, 100),
        assetPartyLinks: assetPartyLinks || [],
        liabilityProfileLinks: liabilityProfileLinks || [],
        month,
        filterIds: filterIds || [],
      };
    });

    setCache(cacheKey, data, 60 * 1000); // match /api/stats TTL
    try { (storage as any).disableRequestMemo?.(); } catch {}
    res.json(data);
  }));

  // ---- Insights ----
  app.get("/api/insights", asyncHandler(async (req, res) => {
    try {
      const uid = cacheUserKey(req as AuthenticatedRequest);
      const profileIdsParam = req.query.profileIds as string | undefined;
      const profileId = req.query.profileId as string | undefined;
      const ids = profileIdsParam ? profileIdsParam.split(",").filter(Boolean) : (profileId ? [profileId] : []);
      // Cache the *unfiltered* dataset under a per-user key for ~30s; filtering is cheap and runs per request.
      const ck = `insights-data:${uid}`;
      const hit = getCached(ck);
      const dataset = hit || await dedupe(ck, () => Promise.all([
        storage.getProfiles(),
        storage.getTrackers(),
        storage.getTasks(),
        storage.getExpenses(),
        storage.getHabits(),
        storage.getObligations(),
        storage.getJournalEntries(),
        storage.getDocuments(),
        storage.getGoals(),
        storage.getEvents(),
      ]));
      if (!hit) setCache(ck, dataset, 5 * 60 * 1000); // version-stamped key (migration 010): fresh by construction; TTL only bounds memory
      const [allProfiles, allTrackers, allTasks, allExpenses, habits, allObligations, journal, documents, goals, allEvents] =
        dataset as [Awaited<ReturnType<typeof storage.getProfiles>>, Awaited<ReturnType<typeof storage.getTrackers>>, Awaited<ReturnType<typeof storage.getTasks>>, Awaited<ReturnType<typeof storage.getExpenses>>, Awaited<ReturnType<typeof storage.getHabits>>, Awaited<ReturnType<typeof storage.getObligations>>, Awaited<ReturnType<typeof storage.getJournalEntries>>, Awaited<ReturnType<typeof storage.getDocuments>>, Awaited<ReturnType<typeof storage.getGoals>>, Awaited<ReturnType<typeof storage.getEvents>>];
      // BUG-20260528-profile-filter-leakage: previously inline mp() that
      // mirrored passesProfileFilter logic but wasn't the canonical call,
      // so future changes to passesProfileFilter wouldn't propagate. Now
      // delegates to the shared function.
      const filterActive = ids.length > 0;
      const fp = ids.length === 1 ? ids[0] : undefined; // back-compat for downstream code below
      const filterCtx = { selectedIds: ids, allProfiles };
      const mp = (linked: string[] | null | undefined) =>
        !filterActive || passesProfileFilter(linked, filterCtx);
      const profiles = allProfiles;
      const trackers = allTrackers.filter(t => mp(t.linkedProfiles));
      const tasks = allTasks.filter(t => mp(t.linkedProfiles));
      const expenses = allExpenses.filter(e => mp(e.linkedProfiles));
      const obligations = allObligations.filter(o => mp(o.linkedProfiles));
      const events = allEvents.filter(e => mp(e.linkedProfiles));
      const filteredHabits = habits.filter(h => mp(h.linkedProfiles || []));
      const filteredDocuments = documents.filter(d => mp(d.linkedProfiles));
      const insights = generateSmartInsights({
        profiles, trackers, tasks, expenses, habits: filteredHabits, obligations, journal, documents: filteredDocuments, goals, events,
      }, getTimezone(req));
      res.json(insights);
    } catch (err: any) {
      log.error("[Insights]", err?.message || "unknown error");
      res.status(500).json({ error: "Failed to generate insights" });
    }
  }));

  // ---- Calendar Status ----
  app.get("/api/calendar/status", asyncHandler(async (_req, res) => {
    try {
      // PERF FIX: was 3 sequential round trips. Parallelize — dashboard
      // pings this endpoint on every page load and on visibility recovery.
      const [lastSync, events, gcalRefreshToken] = await Promise.all([
        storage.getPreference("gcal_last_sync"),
        storage.getEvents(),
        storage.getPreference("gcal_refresh_token"),
      ]);
      const gcalEvents = events.filter((e: any) => e.tags?.includes("google-calendar"));
      const gcalConfigured = !!gcalRefreshToken;
      res.json({
        connected: gcalConfigured,
        lastSync: gcalConfigured ? lastSync : null,
        importedCount: gcalEvents.length,
        totalEvents: events.length,
      });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to get calendar status" });
    }
  }));

  // ---- Profile Type Definitions (Registry) ----
  app.get("/api/profile-types", asyncHandler(async (_req, res) => {
    const supaUrl = process.env.VITE_SUPABASE_URL;
    const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supaUrl || !supaKey) return res.json([]);
    const sb = createClient(supaUrl, supaKey);
    const { data, error } = await sb
      .from("profile_type_definitions")
      .select("*")
      .order("category")
      .order("sort_order");
    if (error) { console.error("[api]", error.message); return res.status(500).json({ error: "Failed to load data" }); }
    res.json(data);
  }));

  app.get("/api/profile-types/:typeKey", asyncHandler(async (req, res) => {
    const supaUrl = process.env.VITE_SUPABASE_URL;
    const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supaUrl || !supaKey) return res.status(501).json({ error: "Profile types not available in this environment" });
    const sb = createClient(supaUrl, supaKey);
    const { data, error } = await sb
      .from("profile_type_definitions")
      .select("*")
      .eq("type_key", req.params.typeKey)
      .single();
    if (error) return res.status(404).json({ error: "Type not found" });
    res.json(data);
  }));

  // ---- Profiles ----
  // PERF: slim variant for the MultiProfileFilter chip and other nav UI that
  // only needs id/type/name/avatar/parent. Skips heavy jsonb columns. MUST be
  // registered before /api/profiles/:id so "lite" isn't matched as an id.
  app.get("/api/profiles/lite", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const ck = `profiles-lite:${uid}`;
    const hit = getCached(ck);
    if (hit) {
      res.set("X-Total-Count", String(hit.length));
      return res.json(hit);
    }
    const items = await dedupe(ck, async () => {
      if (typeof (storage as any).getProfilesLite === "function") {
        return await (storage as any).getProfilesLite();
      }
      return await storage.getProfiles();
    });
    setCache(ck, items, 30 * 1000);
    res.set("X-Total-Count", String(items.length));
    res.json(items);
  }));

  app.get("/api/profiles", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const ck = `profiles:${uid}`;
    const hit = getCached(ck);
    if (hit) {
      res.set("X-Total-Count", String(hit.length));
      return res.json(paginateProfiles(hit, req, res));
    }
    const items = await dedupe(ck, () => storage.getProfiles());
    // 30s cache. Was 5s (over-defensive after a chat-race bug). cacheBustMiddleware
    // (line ~339) calls clearAllCache() synchronously on every POST/PATCH/DELETE
    // AND on /api/chat + /api/upload routes (where the AI creates profiles), so
    // staleness is bounded by the next write — not the TTL. Bumping to 30s makes
    // every page that calls /api/profiles on mount (every single page) feel
    // instant on warm loads. Cold-load is still bounded by Vercel/Supabase, not
    // by this TTL.
    setCache(ck, items, 30 * 1000);
    res.set("X-Total-Count", String(items.length));
    res.json(paginateProfiles(items, req, res));
  }));
  app.get("/api/profiles/:id", asyncHandler(async (req, res) => {
    const profile = await storage.getProfile(req.params.id);
    if (!profile) return res.status(404).json({ error: "Not found" });
    // S1 fix: storage layer filters by user_id; this check is defense-in-depth
    // in case a future refactor weakens that. Typed shape strips user_id, so
    // this only fires when a future mapper exposes it.
    if ((profile as any).userId && (profile as any).userId !== (req as AuthenticatedRequest).userId) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json(profile);
  }));
  app.get("/api/profiles/:id/detail", asyncHandler(async (req, res) => {
    // NO cache — profile detail must always reflect current DB state (Principle 5)
    const detail = await storage.getProfileDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: "Not found" });
    // S1 fix: storage layer filters by user_id; defense-in-depth ownership guard.
    if ((detail as any).userId && (detail as any).userId !== (req as AuthenticatedRequest).userId) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json(detail);
  }));

  // ---- Profile Tree (depth-first, all descendants) ----
  app.get("/api/profiles/:id/tree", asyncHandler(async (req, res) => {
    const root = await storage.getProfile(req.params.id);
    if (!root) return res.status(404).json({ error: "Not found" });
    // S1 fix: storage layer filters by user_id; defense-in-depth ownership guard.
    if ((root as any).userId && (root as any).userId !== (req as AuthenticatedRequest).userId) {
      return res.status(404).json({ error: "Not found" });
    }

    // Fetch all profiles once (user-scoped) then build tree in memory
    const allProfiles = await storage.getProfiles();

    // Index parent→children once so the depth-first walk is O(N) instead of
    // O(N²). For a corpus of 1000 profiles this drops the rollup-tree-fetch
    // from ~4M comparisons to ~1000.
    const childIndex = new Map<string, typeof allProfiles>();
    for (const p of allProfiles) {
      if (p.deletedAt) continue;
      const k = p.parentProfileId || "__root__";
      const arr = childIndex.get(k);
      if (arr) arr.push(p); else childIndex.set(k, [p]);
    }

    // Helper: build a TreeNode for a given profile, depth-first.
    // CYCLE GUARD: `visited` tracks every ancestor on the current path. If a
    // child's id is already in `visited` we have a loop (A→B→A), so we drop
    // that child instead of recursing forever. This protects against bad
    // data (manual SQL edits, race conditions in parent-reparenting) and
    // keeps the server from stack-overflowing.
    // DEPTH GUARD: a hard cap of 50 levels stops pathological trees while
    // still being far deeper than any realistic ownership chain.
    interface TreeNode {
      id: string;
      name: string;
      type: string;
      fields: Record<string, any>;
      parentProfileId?: string;
      children: TreeNode[];
    }
    const MAX_DEPTH = 50;

    function buildTree(profileId: string, visited: Set<string>, depth: number): TreeNode {
      const p = allProfiles.find(x => x.id === profileId)!;
      const node: TreeNode = {
        id: p.id,
        name: p.name,
        type: p.type,
        fields: p.fields,
        parentProfileId: p.parentProfileId,
        children: [],
      };
      if (depth >= MAX_DEPTH) return node; // guard against runaway trees
      const directChildren = childIndex.get(profileId) || [];
      const nextVisited = new Set(visited);
      nextVisited.add(profileId);
      for (const c of directChildren) {
        if (nextVisited.has(c.id)) {
          // cycle detected — skip this edge instead of recursing
          continue;
        }
        node.children.push(buildTree(c.id, nextVisited, depth + 1));
      }
      return node;
    }

    const tree = buildTree(root.id, new Set(), 0);
    res.json(tree);
  }));

  // ---- Profile Bootstrap (PERF 2026-05-28) ----
  // Single round-trip for /profiles/:id and /profile/:id pages. Each of those
  // pages used to fire ~10+ parallel GETs on mount (profile detail, tree,
  // /api/profiles, /api/asset-party-links, /api/liability-profile-links,
  // /api/dashboard-enhanced, /api/stats, /api/events, /api/expenses, ...).
  // Even with parallelism, each one pays the Vercel cold-start + auth +
  // Supabase client init tax, so cold loads stayed in the 5-15s range.
  //
  // This handler folds the must-have payload (detail + tree + allProfiles +
  // assetPartyLinks + liabilityProfileLinks) into a single response. The
  // ambient queries the page also wants (stats, dashboard-enhanced) reuse
  // their per-endpoint caches so they're effectively free when warm.
  app.get("/api/profile-bootstrap/:id", asyncHandler(async (req, res) => {
    const profileId = req.params.id;
    const userId = cacheUserKey(req as AuthenticatedRequest);
    const cacheKey = `profile-bootstrap:${userId}:${profileId}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const data = await dedupe(cacheKey, async () => {
      // PROFILE DETAIL has its own internal Promise.all batches (junction-table
      // lookups + entity fetch) — see supabase-storage.ts:getProfileDetail.
      // We run it in parallel with the lightweight pieces.
      const [detail, allProfiles, assetPartyLinks, liabilityProfileLinks] = await Promise.all([
        storage.getProfileDetail(profileId),
        storage.getProfiles(),
        storage.getAssetPartyLinks ? storage.getAssetPartyLinks().catch(() => [] as any[]) : Promise.resolve([] as any[]),
        storage.getLiabilityProfileLinks ? storage.getLiabilityProfileLinks().catch(() => [] as any[]) : Promise.resolve([] as any[]),
      ]);
      if (!detail) return null;
      // S1: ownership guard — storage filters by user_id but be defensive.
      if ((detail as any).userId && (detail as any).userId !== userId) return null;

      // Build the tree in-process from the already-fetched allProfiles list
      // (no extra DB round-trip, no duplicate getProfiles call).
      const childIndex = new Map<string, typeof allProfiles>();
      for (const p of allProfiles) {
        if (p.deletedAt) continue;
        const k = p.parentProfileId || "__root__";
        const arr = childIndex.get(k);
        if (arr) arr.push(p); else childIndex.set(k, [p]);
      }
      const MAX_DEPTH = 50;
      function buildTree(pid: string, visited: Set<string>, depth: number): any {
        const p = allProfiles.find(x => x.id === pid);
        if (!p) return null;
        const node: any = {
          id: p.id, name: p.name, type: p.type, fields: p.fields,
          parentProfileId: p.parentProfileId, children: [],
        };
        if (depth >= MAX_DEPTH) return node;
        const directChildren = childIndex.get(pid) || [];
        const nextVisited = new Set(visited);
        nextVisited.add(pid);
        for (const c of directChildren) {
          if (nextVisited.has(c.id)) continue;
          const child = buildTree(c.id, nextVisited, depth + 1);
          if (child) node.children.push(child);
        }
        return node;
      }
      const tree = buildTree(profileId, new Set(), 0);

      return {
        detail,
        tree,
        profiles: allProfiles,
        assetPartyLinks,
        liabilityProfileLinks,
      };
    });

    if (!data) return res.status(404).json({ error: "Not found" });
    // 30s cache. cacheBustMiddleware drops it on any mutation. Detail data
    // changes via mutations (chat-confirm-extraction, profile PATCH, link
    // changes) which all bust the cache, so 30s is safe.
    setCache(cacheKey, data, 30 * 1000);
    res.json(data);
  }));

  app.post("/api/profiles", asyncHandler(async (req, res) => {
    const uid_p1 = cacheUserKey(req as AuthenticatedRequest);
    if (!req.body.name || typeof req.body.name !== "string" || !req.body.name.trim()) {
      return res.status(400).json({ error: "Profile name is required" });
    }
    if (!req.body.type || typeof req.body.type !== "string" || !req.body.type.trim()) {
      return res.status(400).json({ error: "Profile type is required" });
    }
    req.body.name = sanitize(req.body.name);
    // Validate common profile fields if provided
    if (req.body.fields && typeof req.body.fields === "object") {
      const f = req.body.fields;
      if (f.email && typeof f.email === "string" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) {
        return res.status(400).json({ error: "Invalid email format" });
      }
      if (f.phone && typeof f.phone === "string" && !/^[\d\s()+-]{7,20}$/.test(f.phone)) {
        return res.status(400).json({ error: "Invalid phone number format" });
      }
      if (f.birthday && typeof f.birthday === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(f.birthday)) {
        return res.status(400).json({ error: "Birthday must be in YYYY-MM-DD format" });
      }
      if (f.bloodType && typeof f.bloodType === "string" && !/^(A|B|AB|O)[+-]$/i.test(f.bloodType)) {
        return res.status(400).json({ error: "Blood type must be A+, A-, B+, B-, AB+, AB-, O+, or O-" });
      }
    }
    // Duplicate detection policy (product decision 2026-06): duplicates are
    // ALLOWED for assets, vehicles, properties, subscriptions, loans, accounts,
    // investments, pets — everything except PEOPLE. You can legitimately own two
    // "Samsung TV"s or nest a "Tv" under a laptop. The only profiles that must
    // not duplicate are people, and ONLY on an EXACT full-name match (first +
    // last). No fuzzy/AI matching — it produced false positives like "Tv" ≈
    // "Samsung TV" that blocked valid creates.
    const existing = await storage.getProfiles();
    const PERSON_TYPES = new Set(["person", "self"]);
    if (PERSON_TYPES.has(req.body.type) && !req.body.skipDupCheck) {
      const norm = (s: any) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
      const newName = norm(req.body.name);
      const dup = existing.find(p => PERSON_TYPES.has(p.type) && !p.deletedAt && norm(p.name) === newName);
      if (dup) {
        return res.status(409).json({ error: `A person named "${dup.name}" already exists`, existingId: dup.id });
      }
    }
    // Auto-assign child-type profiles to self profile if no parent specified
    const childTypes = new Set(["vehicle", "asset", "subscription", "loan", "investment", "account", "property"]);
    if (childTypes.has(req.body.type) && !req.body.parentProfileId) {
      const selfProfile = existing.find(p => p.type === "self");
      if (selfProfile) {
        req.body.parentProfileId = selfProfile.id;
      }
    }
    // Strip skipDupCheck flag before schema validation (it's a control flag, not stored data).
    const { skipDupCheck: _skip, ...profileBody } = req.body;
    const parsed = insertProfileSchema.safeParse(profileBody);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation failed", issues: parsed.error.issues });

    // ---- parentProfileId validation on CREATE ----
    // Matches the rigour of PATCH: parent must exist, belong to this user,
    // and the resulting nesting depth must stay under 32 levels. Cycle
    // detection isn't strictly needed on create (the new profile has no id
    // yet so it can't be its own ancestor), but the depth check still is.
    if (parsed.data.parentProfileId) {
      const parentProfile = await storage.getProfile(parsed.data.parentProfileId);
      if (!parentProfile) {
        return res.status(404).json({ error: "Parent profile not found" });
      }
      // getProfile is user-scoped — if it returned, the parent belongs to us.
      // Defence-in-depth: depth walk.
      let depth = 1;
      let walkId: string | null = parsed.data.parentProfileId;
      const seen = new Set<string>();
      while (walkId && depth < 64) {
        if (seen.has(walkId)) break;
        seen.add(walkId);
        const wp = await storage.getProfile(walkId);
        if (!wp) break;
        const wpid: string | null = wp.parentProfileId || null;
        if (!wpid) break;
        depth++;
        walkId = wpid;
      }
      if (depth > 32) {
        return res.status(400).json({ error: "Cannot create: nesting depth would exceed 32 levels" });
      }
    }

    const created = await storage.createProfile(parsed.data);
    bustCache(`profiles:${uid_p1}`); bustCache(`stats:${uid_p1}`); bustCache(`enhanced:`); bustCache(`profile-detail:${uid_p1}:`);

    // Auto-ownership now lives in a single place: storage.createProfile resolves
    // the owning party from the parent chain (resolveAutoOwner) and links it at
    // 100%. A second hook here force-linked Self, producing a competing 100% link
    // that the SUM>100 DB trigger then split 50/50 — see
    // docs/dashboard-scope-contract.md. Keeping one writer keeps SUM == 100.

    // ---- Auto-bill: create a backing obligation for liabilities ----
    // If a liability/loan is created with a monthlyPayment, ensure a
    // matching obligation row exists so the loan appears on bills feeds,
    // calendar, and the NetWorthStrip's "monthly debt" rollup.
    if (created.type === "liability" || created.type === "loan") {
      await syncLiabilityObligation(created.id);
      bustCache(`profile-detail:${uid_p1}:`);
    }

    // Wave 2 #6 — AI-suggested obligation for recurring-bill candidates
    // (subscriptions, insurance, accounts, utilities). Fire-and-forget so it
    // never blocks the create response — the cache bust on completion will
    // surface the new obligation on next dashboard fetch.
    {
      const obligationCandidates = new Set(["subscription", "insurance", "account", "utility"]);
      if (obligationCandidates.has(created.type)) {
        (async () => {
          await syncAiSuggestedObligation(created.id);
          bustCache(`obligations:${uid_p1}`); bustCache(`profile-detail:${uid_p1}:`); bustCache(`enhanced:`);
        })();
      }
    }

    // ---- Location auto-attach hook ----
    // If the new profile has a name AND a parentProfileId, look at all siblings
    // (same parentProfileId, same userId, not this profile, not soft-deleted).
    // If a sibling's fields.location (case-insensitive, trimmed) === the new profile's name,
    // re-attach that sibling to the new profile.
    // Non-blocking: wrap in try/catch so failures never delay the create response.
    if (created.name && created.parentProfileId) {
      (async () => {
        try {
          const allProfiles = await storage.getProfiles();
          const newNameNorm = created.name.trim().toLowerCase();
          const siblings = allProfiles.filter(p =>
            p.id !== created.id &&
            p.parentProfileId === created.parentProfileId &&
            !p.deletedAt
          );
          for (const sibling of siblings) {
            const loc = typeof sibling.fields?.location === "string"
              ? sibling.fields.location.trim().toLowerCase()
              : null;
            if (loc && loc === newNameNorm) {
              // Re-attach sibling: set parentProfileId on the column only — the
              //   legacy JSON shadow is no longer written.
              await storage.updateProfile(sibling.id, {
                parentProfileId: created.id,
              });
            }
          }
        } catch (autoAttachErr: any) {
          console.error("[auto-attach] location hook failed:", autoAttachErr?.message || autoAttachErr);
        }
      })();
    }

    res.status(201).json(created);
  }));
  app.patch("/api/profiles/:id", asyncHandler(async (req, res) => {
    const uid_p2 = cacheUserKey(req as AuthenticatedRequest);
    // Capture `fieldsToDelete` BEFORE Zod parse. It is not in insertProfileSchema
    // (it is a write-only deletion hint, not a stored column) so the parser would
    // strip it. We sanitize to a string[] and re-attach to req.body after parse.
    // Without this, every profile-field delete from the UI silently no-ops.
    const fieldsToDeleteRaw: any = (req.body && typeof req.body === "object") ? req.body.fieldsToDelete : undefined;
    const fieldsToDelete: string[] | undefined = Array.isArray(fieldsToDeleteRaw)
      ? fieldsToDeleteRaw.filter((k: any) => typeof k === "string" && k.length > 0)
      : undefined;
    {
      const parsed = insertProfileSchema.partial().safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: `Validation failed: ${JSON.stringify(parsed.error.flatten())}` });
      req.body = { ...req.body, ...parsed.data };
      if (fieldsToDelete && fieldsToDelete.length > 0) {
        (req.body as any).fieldsToDelete = fieldsToDelete;
      } else {
        // Strip any non-array garbage that may have come in.
        delete (req.body as any).fieldsToDelete;
      }
    }
    if (req.body.name !== undefined) {
      if (typeof req.body.name !== "string" || req.body.name.trim() === "") {
        return res.status(400).json({ error: "Profile name must be a non-empty string" });
      }
      req.body.name = sanitize(req.body.name);
    }
    // Validate common profile fields if provided
    if (req.body.fields && typeof req.body.fields === "object") {
      const f = req.body.fields;
      if (f.email && typeof f.email === "string" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) {
        return res.status(400).json({ error: "Invalid email format" });
      }
      if (f.phone && typeof f.phone === "string" && !/^[\d\s()+-]{7,20}$/.test(f.phone)) {
        return res.status(400).json({ error: "Invalid phone number format" });
      }
      if (f.birthday && typeof f.birthday === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(f.birthday)) {
        return res.status(400).json({ error: "Birthday must be in YYYY-MM-DD format" });
      }
      if (f.bloodType && typeof f.bloodType === "string" && !/^(A|B|AB|O)[+-]$/i.test(f.bloodType)) {
        return res.status(400).json({ error: "Blood type must be A+, A-, B+, B-, AB+, AB-, O+, or O-" });
      }
    }

    // ---- parentProfileId validation ----
    // FIX 2: `parentProfileId` is the only accepted shape. Callers that still
    //   send the legacy `fields._parentProfileId` shadow get its value lifted
    //   to the top level (transitional courtesy), and the shadow is stripped.
    const hasTopLevel = "parentProfileId" in req.body;
    const hasLegacy = req.body.fields && typeof req.body.fields === "object" && "_parentProfileId" in req.body.fields;
    if (hasTopLevel || hasLegacy) {
      // Resolve the new parent value — empty string treated as null (detach)
      const rawParent: string | null | undefined = hasTopLevel
        ? req.body.parentProfileId
        : req.body.fields._parentProfileId;
      const newParentId: string | null = (!rawParent || rawParent === "") ? null : rawParent;

      if (newParentId !== null) {
        // Validate that new parent exists and belongs to the same user
        const parentProfile = await storage.getProfile(newParentId);
        if (!parentProfile) {
          return res.status(404).json({ error: "Parent profile not found" });
        }
        // Ownership check: storage is already scoped to the user, but double-check
        // by verifying the profile is accessible. If storage returned it, it's ours.
        // (For extra safety, compare with userId from request.)
        // Note: storage.getProfile() is user-scoped; if it returns a profile it belongs to this user.
        // Still, verify the parentProfile is not from a different user via the returned type.
        // Since getProfile is user-scoped, an accessible profile is always owned by the user.
        // If you can't access it → already returns undefined (handled above as 404).

        // Cycle detection
        const cycle = await storage.wouldCreateCycle(uid_p2, req.params.id, newParentId);
        if (cycle) {
          return res.status(400).json({ error: "Cannot set parent: would create a cycle" });
        }
        // Depth cap: 32 levels of nesting is far beyond any realistic use
        // (Home → Furniture → Couch → Screws is 4 levels). Reject inserts
        // that would push us past 32 to keep the parent-chain walks bounded.
        let depthFromParent = 1; // parent counts as level 1
        let walkId: string | null = newParentId;
        const seen = new Set<string>();
        while (walkId && depthFromParent < 64) {
          if (seen.has(walkId)) break;
          seen.add(walkId);
          const walkP = await storage.getProfile(walkId);
          if (!walkP) break;
          const wpid: string | null = walkP.parentProfileId || null;
          if (!wpid) break;
          depthFromParent++;
          walkId = wpid;
        }
        if (depthFromParent > 32) {
          return res.status(400).json({ error: "Cannot set parent: nesting depth would exceed 32 levels" });
        }
      }

      // Persist: set top-level parentProfileId. The legacy `fields._parentProfileId`
      //   shadow is no longer written — the column is the single source of truth.
      //   If the caller sent the shadow, strip it so it can't slip in.
      req.body.parentProfileId = newParentId;
      if (req.body.fields && typeof req.body.fields === "object" && "_parentProfileId" in req.body.fields) {
        delete req.body.fields._parentProfileId;
      }
    }

    const updated = await storage.updateProfile(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    bustCache(`profiles:${uid_p2}`); bustCache(`stats:${uid_p2}`); bustCache(`enhanced:`); bustCache(`profile-detail:${uid_p2}:`); bustCache(`cashflow:${uid_p2}`);
    // Invalidate the cached AI summary so it regenerates on next read. Stored
    // as a preference (profile_ai_<id>) with a 2h TTL — without this, edits to
    // fields like mileage / currentValue won't be reflected in the AI summary
    // for up to two hours. Empty string is treated as a cache miss in the
    // ai-summary read path (Boolean("") === false).
    try { await storage.setPreference(`profile_ai_${req.params.id}`, ""); } catch (err) { console.warn("[routes:patch-profile] failed to clear ai-summary cache:", err); }
    // Auto-bill sync: if monthlyPayment was added or changed on a liability,
    // keep its backing obligation row in step so dashboards stay accurate.
    if (updated.type === "liability" || updated.type === "loan") {
      await syncLiabilityObligation(updated.id);
      bustCache(`profile-detail:${uid_p2}:`);
    }
    res.json(updated);
  }));
  app.delete("/api/profiles/:id", asyncHandler(async (req, res) => {
    const uid_p3 = cacheUserKey(req as AuthenticatedRequest);
    const existing = await storage.getProfile(req.params.id);
    if (!existing) return res.status(404).json({ error: "Profile not found" });
    const ok = await storage.deleteProfile(req.params.id);
    bustCache(`profiles:${uid_p3}`); bustCache(`stats:${uid_p3}`); bustCache(`enhanced:`); bustCache(`profile-detail:${uid_p3}:`); bustCache(`cashflow:${uid_p3}`);
    if (!ok) {
      // Cascade had partial failures or the final row delete failed.
      // Surface as 500 so the client can show a real error instead of a
      // misleading success toast while orphan rows linger.
      return res.status(500).json({ error: "Profile deletion partially failed. Some linked items may remain." });
    }
    res.json({ success: true });
  }));

  // ---- Profile Link / Unlink ----
  app.post("/api/profiles/:id/link", asyncHandler(async (req, res) => {
    const { entityType, entityId } = req.body;
    if (!entityType || !entityId) return res.status(400).json({ error: "entityType and entityId required" });
    if (!KNOWN_ENTITY_TYPES.has(entityType)) {
      return res.status(400).json({ error: "Validation failed: unknown entityType" });
    }
    // Verify profile exists and is owned by user
    const profile = await storage.getProfile(req.params.id);
    if (!profile) return res.status(404).json({ error: "Resource not found" });
    // Verify the entity being linked belongs to this user
    const entityOwned = await verifyEntityOwnership(entityType, entityId);
    if (!entityOwned) return res.status(404).json({ error: "Resource not found" });
    try {
      await storage.linkProfileTo(req.params.id, entityType, entityId);
      // Auto-propagate document links up the profile chain
      if (entityType === "document") {
        try {
          await storage.propagateDocumentToAncestors(entityId, req.params.id);
        } catch { /* non-critical */ }
      }
      const uid_pl1 = cacheUserKey(req as AuthenticatedRequest);
      bustCache(`profiles:${uid_pl1}`); bustCache(`profile-detail:${uid_pl1}:`); bustCache(`enhanced:`); bustCache(`stats:${uid_pl1}`); bustCache(`${entityType}s:${uid_pl1}`);
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[profile-link]", err?.message || err);
      res.status(500).json({ error: "Link failed" });
    }
  }));

  app.post("/api/profiles/:id/unlink", asyncHandler(async (req, res) => {
    const { entityType, entityId } = req.body;
    await storage.unlinkProfileFrom(req.params.id, entityType, entityId);
    const uid_pl2 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`profiles:${uid_pl2}`); bustCache(`profile-detail:${uid_pl2}:`); bustCache(`enhanced:`); bustCache(`stats:${uid_pl2}`); bustCache(`${entityType}s:${uid_pl2}`);
    res.json({ ok: true });
  }));

  // ---- Profile photo upload ----
  // Accepts a base64 image, writes it to the public 'profile-photos' bucket,
  // and stores the resulting public URL on profiles.avatar. Returns the URL
  // so the client can render immediately. Replacing a photo overwrites the
  // same storage path so URLs stay stable per profile.
  app.post("/api/profiles/:id/photo", asyncHandler(async (req, res) => {
    const photoUserId = (req as AuthenticatedRequest).userId;
    if (!photoUserId) return res.status(401).json({ error: "Unauthorized" });
    const { fileData, mimeType } = req.body as { fileData?: string; mimeType?: string };
    if (!fileData) return res.status(400).json({ error: "fileData (base64) required" });
    const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"];
    const mt = (mimeType || "image/jpeg").toLowerCase();
    if (!ALLOWED.includes(mt)) return res.status(415).json({ error: `Unsupported image type: ${mt}` });
    // Limit to 5MB (base64 ~= 4/3 of binary size)
    const sizeBytes = Math.ceil((fileData.length * 3) / 4);
    if (sizeBytes > 5 * 1024 * 1024) return res.status(413).json({ error: "Photo too large (max 5MB)" });

    const profile = await storage.getProfile(req.params.id);
    if (!profile) return res.status(404).json({ error: "Profile not found" });

    // Strip data URI prefix if present
    let clean = fileData;
    if (clean.includes(",")) clean = clean.split(",").pop() || clean;
    clean = clean.replace(/\s/g, "");
    const buffer = Buffer.from(clean, "base64");

    const ext = mt === "image/png" ? "png" : mt === "image/webp" ? "webp" : mt === "image/gif" ? "gif" : mt.includes("heic") || mt.includes("heif") ? "heic" : "jpg";
    const storagePath = `${photoUserId}/${req.params.id}.${ext}`;

    const url = process.env.VITE_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return res.status(500).json({ error: "Storage not configured" });
    const admin = createClient(url, key);

    const { error: upErr } = await admin.storage.from("profile-photos").upload(storagePath, buffer, {
      contentType: mt,
      upsert: true,
      cacheControl: "3600",
    });
    if (upErr) {
      log.error("[ProfilePhoto] upload", upErr.message);
      return res.status(500).json({ error: "Photo upload failed" });
    }
    const { data: pub } = admin.storage.from("profile-photos").getPublicUrl(storagePath);
    // Add a cache-buster so an immediate replace shows the new image right away.
    const avatarUrl = `${pub.publicUrl}?t=${Date.now()}`;
    const updated = await storage.updateProfile(req.params.id, { avatar: avatarUrl });
    const uid_pp = photoUserId;
    bustCache(`profiles:${uid_pp}`); bustCache(`profile-detail:${uid_pp}:`);
    res.json({ avatar: avatarUrl, profile: updated });
  }));

  // Remove a profile photo (clears the avatar URL; storage object is left in
  // place so undo/restore is possible from the dashboard later).
  app.delete("/api/profiles/:id/photo", asyncHandler(async (req, res) => {
    const uid = (req as AuthenticatedRequest).userId;
    if (!uid) return res.status(401).json({ error: "Unauthorized" });
    const updated = await storage.updateProfile(req.params.id, { avatar: null as any });
    bustCache(`profiles:${uid}`); bustCache(`profile-detail:${uid}:`);
    res.json({ ok: true, profile: updated });
  }));

  // ---- Profile AI Summary ----
  // ── Find current market value via web search ──────────────────────────────────
  app.get("/api/profiles/:id/find-value", asyncHandler(async (req, res) => {
    const { id } = req.params;
    const profile = await storage.getProfile(id);
    if (!profile) return res.status(404).json({ error: "Profile not found" });

    // Build a rich search query from all known profile fields
    const f = profile.fields || {};
    const parts: string[] = [profile.name];

    // Vehicle-specific context
    if (f.year) parts.push(String(f.year));
    if (f.make) parts.push(String(f.make));
    if (f.model) parts.push(String(f.model));
    if (f.trim) parts.push(String(f.trim));
    if (f.mileage) parts.push(`${f.mileage} miles`);
    if (f.color) parts.push(String(f.color));
    if (f.condition) parts.push(String(f.condition));
    if (f.vin) parts.push(`VIN ${f.vin}`);

    // Property-specific context
    if (f.address) parts.push(String(f.address));
    if (f.city) parts.push(String(f.city));
    if (f.state) parts.push(String(f.state));
    if (f.sqft) parts.push(`${f.sqft} sq ft`);
    if (f.bedrooms) parts.push(`${f.bedrooms}bd`);
    if (f.bathrooms) parts.push(`${f.bathrooms}ba`);

    // Asset-specific context
    if (f.brand) parts.push(String(f.brand));
    if (f.category) parts.push(String(f.category));

    const searchQuery = `${parts.join(" ")} current market value 2026`;

    try {
      // Use Claude to do a web-search-backed valuation
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

      // Try web search first (Brave)
      let webContext = "";
      try {
        const braveKey = process.env.BRAVE_API_KEY;
        if (braveKey) {
          const braveRes = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(searchQuery)}&count=5`, {
            headers: { "X-Subscription-Token": braveKey, "Accept": "application/json" }
          });
          const braveData = await braveRes.json() as any;
          const snippets = (braveData.web?.results || []).slice(0, 5).map((r: any) => `${r.title}: ${r.description}`).join("\n");
          if (snippets) webContext = `\n\nWeb search results for "${searchQuery}":\n${snippets}`;
        }
      } catch { /* brave unavailable — proceed without */ }

      const prompt = `You are an expert asset appraiser. Based on the following profile information, estimate the current fair market value.

Profile: ${profile.name} (${profile.type})
Known details: ${JSON.stringify(f, null, 2)}${webContext}

Provide:
1. A single estimated current market value (number in USD)
2. A confidence level (low/medium/high)
3. A brief 1-sentence explanation of how you arrived at this value

Respond ONLY in JSON format:
{"value": 25000, "confidence": "medium", "explanation": "Based on...", "range": {"low": 22000, "high": 28000}}`;

      const resp = await client.messages.create({
        // Same model used elsewhere in the codebase. Note: claude-sonnet-4-5-20250929
        // was retired/erroring (2026-05-24); use 4-6 as the safe default. The env
        // override still works for emergencies but should also be set to a live ID.
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      });

      const text = resp.content[0].type === "text" ? resp.content[0].text : "";
      // Extract JSON from response
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No JSON in response");
      const result = JSON.parse(match[0]);

      res.json({
        estimatedValue: result.value,
        confidence: result.confidence,
        explanation: result.explanation,
        range: result.range,
        searchQuery,
        profileName: profile.name,
      });
    } catch (err: any) {
      console.error("[routes] find-value failed:", err?.message, err?.status, err?.error);
      const detail = err?.error?.error?.message || err?.message || "Unknown error";
      res.status(500).json({ error: `Failed to estimate value: ${detail}` });
    }
  }));

  app.get("/api/profiles/:id/ai-summary", asyncHandler(async (req, res) => {
    try {
      const { id } = req.params;
      const force = req.query.force === "true";

      // Check cache first (2-hour TTL)
      const cacheKey = `profile_ai_${id}`;
      if (!force) {
        const cached = await storage.getPreference(cacheKey);
        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            if (parsed.generatedAt) {
              const age = Date.now() - new Date(parsed.generatedAt).getTime();
              if (age < 7200000) { // 2 hour TTL
                // Re-normalize on read: older cache entries (written before the
                // generation path normalized these) could omit the arrays, which
                // crashed the client's `.length` access and blanked the profile
                // page. Always return a well-formed shape.
                return res.json({
                  summary: parsed.summary || "No summary available.",
                  actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
                  highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
                  generatedAt: parsed.generatedAt,
                });
              }
            }
          } catch (err) { console.error("[routes:profile-ai-summary] cache parse failed:", err); }
        }
      }

      // Load the full profile detail
      const detail = await storage.getProfileDetail(id);
      if (!detail) return res.status(404).json({ error: "Profile not found" });

      // Build compact data snapshot for the profile
      const now = new Date();

      // Sanitize: if the user has explicitly scrubbed a sensitive demographic
      // key (birthday, age, SSN) from the profile, strip every variant of
      // that key from each linked document's extractedData before sending
      // to the AI. Otherwise the AI confidently computes "45-year-old" from
      // a driver's license DOB even though the user just deleted Birthday.
      // See block at top of file for full rationale. DATA IS NOT DELETED —
      // the document's stored extractedData is untouched.
      const aiStripKeys = computeAiSensitiveStripKeys(detail.fields as Record<string, any>);
      const sanitizedFields = deepStripKeys(detail.fields, aiStripKeys);

      const profileData: Record<string, any> = {
        name: detail.name,
        type: detail.type,
        fields: sanitizedFields,
        tags: detail.tags,
        notes: detail.notes,
        documents: detail.relatedDocuments.map(d => ({
          name: d.name,
          type: d.type,
          extractedData: deepStripKeys(d.extractedData, aiStripKeys),
          createdAt: d.createdAt,
        })),
        expenses: detail.relatedExpenses.map(e => ({
          description: e.description,
          amount: e.amount,
          category: e.category,
          date: e.date,
        })),
        trackers: detail.relatedTrackers.map(t => ({
          name: t.name,
          category: t.category,
          unit: t.unit,
          entries: (t.entries || []).slice(-15).map(e => ({
            date: e.timestamp.slice(0, 10),
            values: e.values,
          })),
        })),
        tasks: detail.relatedTasks.map(t => ({
          title: t.title,
          status: t.status,
          priority: t.priority,
          dueDate: t.dueDate,
        })),
        events: detail.relatedEvents.map(e => ({
          title: e.title,
          date: e.date,
          category: e.category,
        })),
        obligations: detail.relatedObligations.map(o => ({
          name: o.name,
          amount: o.amount,
          frequency: o.frequency,
          nextDueDate: o.nextDueDate,
          autopay: o.autopay,
        })),
        timeline: detail.timeline.slice(-20).map(t => ({
          type: t.type,
          title: t.title,
          timestamp: t.timestamp,
        })),
      };

      // Type-specific prompt angles
      const typePrompts: Record<string, string> = {
        person: "Summarize this person's profile. Note recent interactions, linked documents, upcoming events, and any action items.",
        self: "Give a personal life overview: health trends, habits, mood, goals, upcoming obligations, and spending patterns.",
        pet: "Summarize this pet's health records, upcoming vaccinations, vet visits, spending, and any care items needing attention.",
        vehicle: "Summarize this vehicle's status: mileage, insurance, registration, loan, maintenance history, and upcoming service needs.",
        account: "Analyze this account: linked documents, recent activity, and any items needing attention.",
        subscription: "Analyze this subscription/account: cost, value, linked documents, payment history, and whether it's worth keeping.",
        asset: "Summarize this asset's value, maintenance needs, warranty status, documents, and expenses.",
        property: "Summarize this property's status: value, maintenance, documents, expenses, insurance, and upcoming obligations.",
        loan: "Analyze this loan: balance, payments, interest, payoff timeline, and linked documents.",
        liability: "Analyze this liability (loan/credit card/mortgage/etc.): current balance, monthly payment, APR, payoff timeline, total interest paid, recent payment history, linked assets/co-signers, and any action items (e.g. high APR refinance opportunity, missed payments, autopay setup).",
        investment: "Analyze this investment: performance, value, linked documents, and any action items.",
        medical: "Summarize this medical profile: conditions, medications, appointments, documents, and upcoming care needs.",
      };

      const typePrompt = typePrompts[detail.type] || "Summarize this profile's key information, linked entities, and any action items.";

      const systemPrompt = `You are the AI engine for Portol, a personal life management app. You analyze profile data to produce a concise, actionable summary.

Rules:
- Be specific with numbers and dates. Say "Last vet visit was 8 months ago" not "It's been a while."
- Identify action items: things the user should do (renew insurance, schedule appointment, etc.)
- Highlight key metrics as structured data.
- If data is sparse, still provide useful insights from what's available.
- Return ONLY valid JSON matching the exact schema below. No markdown, no code fences.
- The 'fields' block is the AUTHORITATIVE source of truth for personal facts (age, birthday, address, marital status, phone, SSN, etc.). If a personal fact is NOT present in 'fields', you MUST NOT infer it from linked documents, notes, or tags. In particular: NEVER compute or state a person's age unless 'fields.birthday' (or an equivalent date-of-birth field) is present. If 'fields.birthday' is absent, do not write any phrase like "X-year-old" or "age X" — just omit age from the summary.

JSON Schema:
{
  "summary": "string — 2-3 sentence natural language overview of this profile",
  "actionItems": ["string — specific actionable thing to do"],
  "highlights": [
    {
      "label": "string — metric label like 'Total Spent' or 'Last Visit'",
      "value": "string — the value like '$1,240' or '3 months ago'",
      "trend": "up | down | stable — optional, include only if a trend is clear"
    }
  ]
}

Generate 0-5 action items (only real, actionable ones). Generate 2-4 highlights with key metrics. The summary should be personalized and specific to the data.`;

      const userPrompt = `${typePrompt}\n\nProfile data:\n${JSON.stringify(profileData, null, 1)}`;

      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const response = await client.messages.create({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
        max_tokens: 1024,
        messages: [
          { role: "user", content: userPrompt },
        ],
        system: systemPrompt,
      });

      // Extract text from response
      const textBlock = response.content.find(b => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        throw new Error("No text response from Claude");
      }

      // Parse JSON response - strip any markdown code fences if present
      let jsonStr = textBlock.text.trim();
      if (jsonStr.startsWith("```")) {
        jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
      }
      let aiData: any;
      try {
        aiData = JSON.parse(jsonStr);
      } catch {
        aiData = {};
      }

      const result = {
        summary: aiData.summary || "No summary available.",
        actionItems: Array.isArray(aiData.actionItems) ? aiData.actionItems : [],
        highlights: Array.isArray(aiData.highlights) ? aiData.highlights : [],
        generatedAt: now.toISOString(),
      };

      // Cache the result
      await storage.setPreference(cacheKey, JSON.stringify(result));

      res.json(result);
    } catch (err: any) {
      log.error("[ProfileSummary]", err?.message || "unknown error");
      res.status(500).json({ error: "Failed to generate AI summary" });
    }
  }));

  // Wave 9: Look up current market value for an asset profile.
  // POST /api/profiles/:id/lookup-value
  // - Runs estimateAssetValue (live web search + AI) on the profile's fields
  // - Persists the result onto the profile (currentValue, valuationMethod,
  //   valuationConfidence, valuationRange, valuationDate, previousValue)
  // - Returns the new valuation so the client can show it without refetching
  app.post("/api/profiles/:id/lookup-value", asyncHandler(async (req, res) => {
    try {
      const { id } = req.params;
      const profile = await storage.getProfile(id);
      if (!profile) return res.status(404).json({ error: "Profile not found" });

      const valuableTypes = ["vehicle", "asset", "property", "investment"];
      if (!valuableTypes.includes(profile.type)) {
        return res.status(400).json({ error: `Cannot estimate value for type '${profile.type}'` });
      }

      const valuation = await estimateAssetValue({
        type: profile.type,
        name: profile.name,
        fields: profile.fields || {},
      });

      if (!valuation) {
        return res.status(422).json({
          error: "Could not determine a current market value from search results.",
          method: "no data",
        });
      }
      // Phase 8: accept estimatedValue === 0 as a valid "no data" placeholder.
      // We persist with low confidence so the user can edit manually instead of
      // hitting a hard 422 error. The AI fallback path always returns a record.

      const oldValue = (profile.fields as any)?.currentValue
                    ?? (profile.fields as any)?.purchasePrice
                    ?? 0;

      // DATA IS NOT DELETED — we merge into existing fields and preserve
      // previousValue so the user can compare against the prior estimate.
      const updatedFields = {
        ...(profile.fields || {}),
        currentValue: valuation.estimatedValue,
        valuationMethod: valuation.method,
        valuationConfidence: valuation.confidence,
        valuationRange: valuation.details,
        valuationDate: new Date().toISOString(),
        previousValue: oldValue,
      };
      await storage.updateProfile(id, { fields: updatedFields });

      // Bust the AI summary cache so the next render reflects the new value.
      try { await storage.setPreference(`profile_ai_${id}`, ""); } catch { /* ignore */ }

      res.json({
        previousValue: Number(oldValue) || 0,
        currentValue: valuation.estimatedValue,
        confidence: valuation.confidence,
        method: valuation.method,
        range: valuation.details,
        valuationDate: updatedFields.valuationDate,
      });
    } catch (err: any) {
      log.error("[LookupValue]", err?.message || "unknown error");
      res.status(500).json({ error: "Failed to look up current value" });
    }
  }));

  // ── Wave 3 #9: Stale asset valuation detector ───────────────────────
  // GET /api/assets/stale-valuations
  // Returns assets that should have their value refreshed, ranked by AI based
  // on type-specific staleness expectations (vehicles depreciate ~monthly,
  // properties yearly, investments more often, etc) and the age of the last
  // valuation. Cheap deterministic pre-filter → single AI ranking call.
  app.get("/api/assets/stale-valuations", asyncHandler(async (req, res) => {
    try {
      const profiles = await storage.getProfiles();
      const valuableTypes = new Set(["vehicle", "asset", "property", "investment"]);
      const candidates = profiles
        .filter((p: any) => valuableTypes.has(p.type) && !p.deletedAt)
        .map((p: any) => {
          const f = p.fields || {};
          const lastValuedRaw = f.valuationDate || f.lastValuedAt;
          const lastValued = lastValuedRaw ? new Date(lastValuedRaw) : null;
          const ageDays = lastValued ? Math.floor((Date.now() - lastValued.getTime()) / 86400000) : 9999;
          return {
            id: p.id,
            name: p.name,
            type: p.type,
            currentValue: Number(f.currentValue || f.purchasePrice || 0),
            lastValuedAt: lastValuedRaw || null,
            ageDays,
          };
        })
        // Pre-filter: only show if never valued OR >30 days old (cheap path) —
        // AI will further rank by type-specific staleness.
        .filter((c: any) => c.ageDays >= 30 || !c.lastValuedAt);

      if (candidates.length === 0) {
        return res.json({ stale: [], reason: "No assets due for refresh." });
      }
      // Limit to top 50 candidates for the AI call so the prompt stays cheap.
      const trimmed = candidates.slice(0, 50);

      const decision = await aiDecide<{ rankedIndices: number[]; reasons: Record<string, string> }>({
        task: "asset-stale-rank",
        system: `You rank assets by URGENCY of valuation refresh based on type-specific staleness norms:
- vehicle:    monthly       (high churn, market shifts)
- investment: weekly to monthly
- property:   yearly
- asset:      every 6 months (default)
Return ONLY JSON: {"rankedIndices":[<top 10 indices in order, most urgent first>],"reasons":{"<index>":"<short why>"}}
Factors: ageDays since last valuation, type churn rate, currentValue magnitude (bigger = more impact if stale).`,
        user: `Candidates:\n${JSON.stringify(trimmed.map((c: any, i: number) => ({ idx: i, ...c })))}\n\nReturn JSON only.`,
        timeoutMs: 4000,
        maxTokens: 500,
        fallback: () => {
          // Deterministic fallback: just sort by ageDays desc.
          const sortedIdx = trimmed
            .map((_: any, i: number) => i)
            .sort((a, b) => trimmed[b].ageDays - trimmed[a].ageDays)
            .slice(0, 10);
          const reasons: Record<string, string> = {};
          for (const i of sortedIdx) reasons[String(i)] = `${trimmed[i].ageDays}d since last valuation`;
          return { rankedIndices: sortedIdx, reasons };
        },
        validate: (p: any) => p && Array.isArray(p.rankedIndices),
      });

      const stale = decision.value.rankedIndices
        .map((i: number) => trimmed[i] ? { ...trimmed[i], reason: decision.value.reasons?.[String(i)] || "due" } : null)
        .filter(Boolean)
        .slice(0, 10);
      res.json({ stale, source: decision.source, totalCandidates: candidates.length });
    } catch (err: any) {
      log.error("[StaleValuations]", err?.message || "unknown error");
      res.status(500).json({ error: "Failed to compute stale valuations", stale: [] });
    }
  }));

  // ---- Trackers ----
  app.get("/api/trackers", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const ck = `trackers:${uid}`;
    const hit = getCached(ck);
    let items = hit || await dedupe(ck, () => storage.getTrackers());
    if (!hit) setCache(ck, items, 5 * 60 * 1000); // version-stamped key (migration 010): fresh by construction; TTL only bounds memory
    // BUG-20260528-finance-tracker: hide legacy rows whose category is no
    // longer surfaced. We filter at read time so we don't have to migrate
    // existing data (which the user wants kept intact).
    items = items.filter((t: any) => !HIDDEN_TRACKER_CATEGORIES.has(String(t.category || "").toLowerCase().trim()));
    const profileIdsParam = req.query.profileIds as string | undefined;
    if (profileIdsParam) {
      // [P2.4] canonical orphan rule — see filterByProfileScope.
      const ids = profileIdsParam.split(",").filter(Boolean);
      items = await filterByProfileScope(items, ids, uid);
    }
    res.json(paginate(items, req, res));
  }));
  app.get("/api/trackers/:id", asyncHandler(async (req, res) => {
    const tracker = await storage.getTracker(req.params.id);
    if (!tracker) return res.status(404).json({ error: "Not found" });
    // S1 fix: storage layer filters by user_id; defense-in-depth ownership guard.
    if ((tracker as any).userId && (tracker as any).userId !== (req as AuthenticatedRequest).userId) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json(tracker);
  }));
  app.post("/api/trackers", asyncHandler(async (req, res) => {
    if (!req.body.name || typeof req.body.name !== "string" || !req.body.name.trim()) {
      return res.status(400).json({ error: "Tracker name is required" });
    }
    // BUG-20260528-finance-tracker: money lives in expenses/budgets/obligations,
    // never in /trackers. Reject any tracker whose category resolves to a
    // hidden group. The matching client-side filter lives in trackers.tsx.
    if (req.body.category && HIDDEN_TRACKER_CATEGORIES.has(String(req.body.category).toLowerCase().trim())) {
      return res.status(400).json({
        error: `Trackers cannot use category "${req.body.category}". Use Expenses, Budgets, or Obligations for money tracking.`,
        code: "hidden_tracker_category",
      });
    }
    req.body.name = sanitize(req.body.name);
    // BUG-T01/CRUD01: Allow client to bypass dup check ("Create Anyway" flow)
    const skipDupCheck = !!req.body.skipDupCheck;
    if ("skipDupCheck" in req.body) delete req.body.skipDupCheck;
    // Duplicate tracker name detection — only block if same name AND same profile.
    // BUG-T01: previously, when linkedProfiles was empty on both sides we returned
    // a global dup, which made quick-add fail with 409 on a brand-new profile that
    // happens to share a tracker name ("Weight", "Steps") with an existing one.
    // Now an empty linkedProfiles array on the new tracker means "scope to whichever
    // profile the UI later attaches" — only dup if both old and new have NO profile
    // attribution AND identical name.
    const requestedProfiles = req.body.linkedProfiles || [];
    const existing = await storage.getTrackers();
    const dup = skipDupCheck ? null : existing.find(t => {
      if (t.name.toLowerCase() !== req.body.name.toLowerCase()) return false;
      const existingProfiles = t.linkedProfiles || [];
      if (requestedProfiles.length === 0 && existingProfiles.length === 0) return true;
      if (requestedProfiles.length === 0 || existingProfiles.length === 0) return false;
      return requestedProfiles.some((pid: string) => existingProfiles.includes(pid));
    });
    if (dup) {
      return res.status(409).json({ error: `A tracker named "${dup.name}" already exists for this profile`, existingId: dup.id });
    }
    const parsed = insertTrackerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation failed", issues: parsed.error.issues });
    // Pass linkedProfiles through to createTracker (schema strips it, so add it back)
    const trackerData = { ...parsed.data, linkedProfiles: requestedProfiles } as any;
    const created = await storage.createTracker(trackerData);
    // Bug fix: trackers list cache had a 5-min TTL but no busting on create —
    // newly added trackers wouldn't appear on dashboard / linked page until
    // the cache expired.
    const uid_tr1 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`trackers:${uid_tr1}`); bustCache(`trackers:`); bustCache(`stats:${uid_tr1}`); bustCache(`enhanced:`);
    res.status(201).json(created);
  }));
  app.patch("/api/trackers/:id", asyncHandler(async (req, res) => {
    {
      const parsed = insertTrackerSchema.partial().safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: `Validation failed: ${JSON.stringify(parsed.error.flatten())}` });
      req.body = { ...req.body, ...parsed.data };
    }
    if (req.body.name !== undefined) {
      if (typeof req.body.name !== "string" || req.body.name.trim() === "") {
        return res.status(400).json({ error: "Tracker name must be a non-empty string" });
      }
      req.body.name = sanitize(req.body.name);
    }
    const updated = await storage.updateTracker(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    // Bug fix: same as POST — patches were silently invisible until cache
    // expired (e.g. renaming a tracker would still show the old name on the
    // dashboard for up to 5 minutes).
    const uid_tr2 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`trackers:${uid_tr2}`); bustCache(`trackers:`); bustCache(`stats:${uid_tr2}`); bustCache(`enhanced:`);
    res.json(updated);
  }));
  app.post("/api/trackers/:id/entries", asyncHandler(async (req, res) => {
    const { values } = req.body;
    if (!values || typeof values !== "object") {
      return res.status(400).json({ error: "Values required" });
    }
    // BUG-T02/T03/T04: Coerce values against the tracker's field schema BEFORE
    // running the meaningful-value / numeric checks. The AI engine (and any chat
    // path) was logging strings like "Chicken Sandwich" or "running" into
    // numeric fields; those values would be stored as strings and then crash
    // any chart/aggregation that called toFixed() on them.
    {
      const tracker = await storage.getTracker(req.params.id);
      if (tracker && Array.isArray(tracker.fields)) {
        const numericFieldNames = new Set(
          tracker.fields
            .filter((f: any) => f && (f.type === "number" || f.type === "integer" || f.type === "decimal"))
            .map((f: any) => f.name)
        );
        for (const k of Object.keys(values)) {
          if (k === "_notes" || k === "notes" || k === "timestamp") continue;
          if (!numericFieldNames.has(k)) continue;
          const raw = (values as any)[k];
          if (raw == null || raw === "") continue;
          if (typeof raw === "number") {
            if (!isFinite(raw)) {
              return res.status(400).json({ error: `"${k}" must be a number (got ${raw}).` });
            }
            continue;
          }
          // Strings: try to coerce, but reject if the string isn't numeric.
          const s = String(raw).trim();
          // Strip currency, units like "lbs", "mi", but reject if no digit at all.
          const stripped = s.replace(/[$,\s]/g, "").replace(/[a-zA-Z\/%]+$/g, "");
          const n = parseFloat(stripped);
          if (!isFinite(n) || stripped === "" || !/\d/.test(stripped)) {
            return res.status(400).json({
              error: `"${k}" expects a number. Received "${s}" — use a numeric value (e.g. 12.5).`,
              field: k,
              received: s,
            });
          }
          (values as any)[k] = n;
        }
      }
    }
    // Reject entries where all meaningful values are empty/null/undefined
    const meaningfulKeys = Object.keys(values).filter(k => k !== '_notes' && k !== 'notes' && k !== 'timestamp');
    const hasAtLeastOneValue = meaningfulKeys.some(k => {
      const v = values[k];
      return v !== null && v !== undefined && v !== '' && !(typeof v === 'number' && isNaN(v));
    });
    if (meaningfulKeys.length > 0 && !hasAtLeastOneValue) {
      return res.status(400).json({ error: "At least one value is required. Cannot log an empty entry." });
    }
    // Only reject negative values for fields that can't be negative (calories, weight, distance)
    // Allow negatives for: temperature, elevation, profit/loss, position change
    const nonNegativeFields = new Set(['calories', 'weight', 'distance', 'duration', 'steps', 'heartRate', 'bpm', 'systolic', 'diastolic']);
    for (const [k, v] of Object.entries(values)) {
      if (typeof v === 'number' && v < 0 && nonNegativeFields.has(k)) {
        return res.status(400).json({ error: `${k} cannot be negative` });
      }
    }
    if (Object.values(values).some((v: any) => typeof v === "number" && isNaN(v))) {
      return res.status(400).json({ error: "All values must be valid numbers" });
    }
    // Sanity bounds — reject obviously impossible values
    const numericVals = Object.entries(values).filter(([, v]) => typeof v === 'number') as [string, number][];
    for (const [key, val] of numericVals) {
      if (key === '_notes') continue;
      // Weight (human): max 1000 lbs
      if (key === 'weight' && val > 1000) return res.status(400).json({ error: `Weight ${val} lbs is unrealistic. Max: 1000 lbs.` });
      // Weight (pet): max 500 lbs — check if the tracker is linked to a pet profile
      if (key === 'weight' && val > 500 && req.body.trackerId) {
        const tracker = await storage.getTracker(req.params.id);
        if (tracker) {
          const profiles = await storage.getProfiles();
          const isPetTracker = (tracker.linkedProfiles || []).some(pid => {
            const p = profiles.find(pr => pr.id === pid);
            return p?.type === 'pet';
          });
          if (isPetTracker) {
            return res.status(400).json({ error: `Pet weight ${val} lbs is unrealistic. Max: 500 lbs.` });
          }
        }
      }
      // Blood pressure systolic: max 300
      if ((key === 'systolic' || key === 'sbp') && val > 300) return res.status(400).json({ error: `Systolic ${val} is unrealistic. Max: 300.` });
      // Blood pressure diastolic: max 200
      if ((key === 'diastolic' || key === 'dbp') && val > 200) return res.status(400).json({ error: `Diastolic ${val} is unrealistic. Max: 200.` });
      // Heart rate: max 250
      if ((key === 'heartRate' || key === 'bpm' || key === 'pulse') && val > 250) return res.status(400).json({ error: `Heart rate ${val} is unrealistic. Max: 250.` });
      // Sleep hours: max 24
      if (key === 'hours' && val > 24) return res.status(400).json({ error: `Sleep ${val} hours is impossible. Max: 24.` });
      // Calories: max 20000
      if (key === 'calories' && val > 20000) return res.status(400).json({ error: `${val} calories is unrealistic. Max: 20,000.` });
      // Generic upper bound: no single numeric value over 100,000
      if (val > 100000) return res.status(400).json({ error: `Value ${val} for "${key}" exceeds maximum (100,000).` });
    }
    const parsed = insertTrackerEntrySchema.safeParse({ ...req.body, trackerId: req.params.id });
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation failed", issues: parsed.error.issues });
    const entry = await storage.logEntry(parsed.data);
    if (!entry) return res.status(404).json({ error: "Tracker not found" });
    const uid_te1 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`trackers:`); bustCache(`stats:${uid_te1}`); bustCache(`enhanced:`);
    res.status(201).json(entry);
  }));
  app.patch("/api/trackers/:id/entries/:entryId", asyncHandler(async (req, res) => {
    const { values, notes, mood, tags, timestamp, valuesToDelete } = req.body || {};
    // Apply the same numeric validation we use on POST entries so edits can't
    // smuggle bad numbers around the original bounds.
    if (values && typeof values === 'object') {
      if (Object.values(values).some((v: any) => typeof v === 'number' && isNaN(v))) {
        return res.status(400).json({ error: "All values must be valid numbers" });
      }
    }
    const patch: any = {};
    if (values && typeof values === 'object') patch.values = values;
    if (notes !== undefined) patch.notes = notes;
    if (mood !== undefined) patch.mood = mood;
    if (tags !== undefined) patch.tags = tags;
    if (timestamp && typeof timestamp === 'string') patch.timestamp = timestamp;
    // P1 universal-delete: clients can pass `valuesToDelete: [key, ...]` to
    // remove specific keys from the entry.values JSONB. Shallow-PATCH'ing
    // `{ values: rest }` no longer removes keys after the storage rewrite,
    // so we surface the explicit deletion signal here instead.
    if (Array.isArray(valuesToDelete)) {
      const clean = valuesToDelete.filter((k: any) => typeof k === 'string' && k.length > 0);
      if (clean.length > 0) patch.valuesToDelete = clean;
    }
    const updated = await storage.updateTrackerEntry(req.params.id, req.params.entryId, patch);
    if (!updated) return res.status(404).json({ error: "Entry not found" });
    const uid_tep = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`trackers:`); bustCache(`stats:${uid_tep}`); bustCache(`enhanced:`);
    res.json(updated);
  }));
  app.delete("/api/trackers/:id/entries/:entryId", asyncHandler(async (req, res) => {
    const deleted = await storage.deleteTrackerEntry(req.params.id, req.params.entryId);
    if (!deleted) return res.status(404).json({ error: "Entry not found" });
    const uid_te2 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`trackers:`); bustCache(`stats:${uid_te2}`); bustCache(`enhanced:`);
    res.json({ success: true });
  }));
  // Convenience endpoint: delete tracker entry by entry ID only (for chat undo)
  // S2 fix: defense-in-depth ownership check. storage.getTrackers() already filters
  // by user_id, so iterating it ensures we only delete entries on the caller's
  // trackers — even if a future refactor weakens the storage filter, we won't
  // delete cross-user rows. We also bust caches once we find a hit.
  // Lenient PATCH-by-entry-id (mirrors the DELETE fallback above): edit a
  // tracker entry without knowing its tracker id — used by the chat result
  // cards, which only carry the entry id. Resolves the owning tracker, then
  // applies the same value/notes/timestamp/valuesToDelete patch as the
  // tracker-scoped route.
  app.patch("/api/tracker-entries/:entryId", asyncHandler(async (req, res) => {
    const { values, notes, mood, tags, timestamp, valuesToDelete } = req.body || {};
    if (values && typeof values === 'object') {
      if (Object.values(values).some((v: any) => typeof v === 'number' && isNaN(v))) {
        return res.status(400).json({ error: "All values must be valid numbers" });
      }
    }
    const patch: any = {};
    if (values && typeof values === 'object') patch.values = values;
    if (notes !== undefined) patch.notes = notes;
    if (mood !== undefined) patch.mood = mood;
    if (tags !== undefined) patch.tags = tags;
    if (timestamp && typeof timestamp === 'string') patch.timestamp = timestamp;
    if (Array.isArray(valuesToDelete)) {
      const clean = valuesToDelete.filter((k: any) => typeof k === 'string' && k.length > 0);
      if (clean.length > 0) patch.valuesToDelete = clean;
    }
    const trackers = await storage.getTrackers();
    for (const t of trackers) {
      const entry = (t.entries || []).find((e: any) => e.id === req.params.entryId);
      if (entry) {
        const updated = await storage.updateTrackerEntry(t.id, req.params.entryId, patch);
        if (!updated) return res.status(404).json({ error: "Entry not found" });
        const uid_tep2 = cacheUserKey(req as AuthenticatedRequest);
        bustCache(`trackers:`); bustCache(`stats:${uid_tep2}`); bustCache(`enhanced:`); bustCache(`profile-detail:${uid_tep2}:`);
        return res.json(updated);
      }
    }
    return res.status(404).json({ error: "Entry not found" });
  }));
  app.delete("/api/tracker-entries/:entryId", asyncHandler(async (req, res) => {
    const trackers = await storage.getTrackers();
    for (const t of trackers) {
      const entry = (t.entries || []).find((e: any) => e.id === req.params.entryId);
      if (entry) {
        const deleted = await storage.deleteTrackerEntry(t.id, req.params.entryId);
        if (deleted) {
          const uid_te3 = cacheUserKey(req as AuthenticatedRequest);
          bustCache(`trackers:`); bustCache(`stats:${uid_te3}`); bustCache(`enhanced:`);
          return res.json({ success: true });
        }
      }
    }
    return res.status(404).json({ error: "Entry not found" });
  }));
  app.delete("/api/trackers/:id", asyncHandler(async (req, res) => {
    const existing = await storage.getTracker(req.params.id);
    if (!existing) return res.status(404).json({ error: "Tracker not found" });
    await storage.deleteTracker(req.params.id);
    // Bug fix: deleted trackers stayed visible for up to 5 minutes because
    // the trackers list cache wasn't busted.
    const uid_tr3 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`trackers:${uid_tr3}`); bustCache(`trackers:`); bustCache(`stats:${uid_tr3}`); bustCache(`enhanced:`);
    res.json({ success: true });
  }));

  // Migrate unlinked trackers to "self" profile
  app.post("/api/trackers/migrate-to-self", asyncHandler(async (_req, res) => {
    const count = await storage.migrateUnlinkedTrackersToSelf();
    res.json({ migrated: count });
  }));

  // ── Wave 1 #3: Smart tracker entry routing ───────────────────────────
  // User types free-form text ("weighed 178 today", "slept 7h", "ran 5k in 28 min")
  // and AI picks the right tracker + parses the numeric value(s). Returns the
  // logged entry. Falls back to 400 if no tracker matches confidently.
  app.post("/api/trackers/smart-entry", asyncHandler(async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "text is required" });
    if (text.length > 500) return res.status(400).json({ error: "text too long (max 500 chars)" });

    const trackers = await storage.getTrackers();
    if (!trackers || trackers.length === 0) {
      return res.status(404).json({ error: "No trackers exist. Create one first." });
    }

    // Build option list — include unit + field names so AI knows how to parse values.
    const options = trackers.map((t: any) => {
      const fields = Array.isArray(t.fields) && t.fields.length > 0
        ? t.fields.map((f: any) => `${f.key}${f.unit ? `(${f.unit})` : ""}`).join(",")
        : (t.unit ? `value(${t.unit})` : "value");
      return `${t.name} [${t.category || "general"}] fields:${fields}`;
    });

    const decision = await aiDecide<{ trackerIndex: number; values: Record<string, number>; notes?: string; confidence: number; reason: string }>({
      task: "tracker-smart-entry",
      system: `You route free-form text into the correct tracker and extract numeric values.
Return ONLY a JSON object: {"trackerIndex": <0..${trackers.length - 1} or -1>, "values": {fieldKey: number, ...}, "notes": "<optional>", "confidence": <0..1>, "reason": "<short>"}
Rules:
- Pick the SINGLE best tracker. Use -1 only if nothing fits.
- Use the EXACT fieldKey strings shown in fields: parens are units, not part of the key.
- Convert obvious units to the tracker's expected unit (e.g. kg → lbs if tracker uses lbs).
- For multi-field trackers (e.g. blood pressure), parse all values you can find.
- Put any non-numeric description in notes.`,
      user: `Text: "${text}"\n\nAvailable trackers:\n${options.map((o, i) => `${i}. ${o}`).join("\n")}\n\nReturn JSON only.`,
      timeoutMs: 4000,
      maxTokens: 300,
      fallback: () => ({ trackerIndex: -1, values: {}, confidence: 0, reason: "AI unavailable" }),
      validate: (p: any) => p && typeof p === "object" && typeof p.trackerIndex === "number" && typeof p.values === "object" && typeof p.confidence === "number",
    });

    if (decision.value.trackerIndex < 0 || decision.value.confidence < 0.5 || !trackers[decision.value.trackerIndex]) {
      return res.status(422).json({ error: "Could not confidently route entry to any tracker", reason: decision.value.reason, source: decision.source });
    }

    const tracker = trackers[decision.value.trackerIndex];
    const cleanValues: Record<string, number> = {};
    for (const [k, v] of Object.entries(decision.value.values)) {
      if (typeof v === "number" && Number.isFinite(v)) cleanValues[k] = v;
    }
    if (Object.keys(cleanValues).length === 0) {
      return res.status(422).json({ error: "AI could not extract any numeric values from text", reason: decision.value.reason });
    }

    // [P1.5] Run through the shared normalizer so smart-entry logs land in
    // the exact same shape as chat-logged and document-extracted entries
    // (canonical field names, units converted to the tracker's unit).
    const { values: normalizedValues, warnings: normWarnings } = normalizeTrackerEntry(tracker as any, cleanValues);
    if (normWarnings.length > 0) {
      console.log(`[smart-entry normalize] ${tracker.name}: ${normWarnings.join("; ")}`);
    }

    const parsed = insertTrackerEntrySchema.safeParse({
      trackerId: tracker.id,
      values: normalizedValues,
      notes: decision.value.notes || text,
      timestamp: new Date().toISOString(),
    });
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation failed" });

    const entry = await storage.logEntry(parsed.data);
    if (!entry) return res.status(500).json({ error: "Failed to log entry" });

    const uid_se = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`trackers:`); bustCache(`stats:${uid_se}`); bustCache(`enhanced:`);
    res.status(201).json({
      entry,
      tracker: { id: tracker.id, name: tracker.name },
      ai: { source: decision.source, confidence: decision.value.confidence, reason: decision.value.reason },
    });
  }));

  // ---- Tasks ----
  app.get("/api/tasks", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const ck = `tasks:${uid}`;
    const hit = getCached(ck);
    let items: Awaited<ReturnType<typeof storage.getTasks>> = hit || await dedupe(ck, () => storage.getTasks());
    if (!hit) setCache(ck, items, 5 * 60 * 1000); // version-stamped key (migration 010): fresh by construction; TTL only bounds memory
    // Support both ?profileId=x (single) and ?profileIds=x,y (multi)
    const fp = req.query.profileId as string | undefined;
    const fps = req.query.profileIds as string | undefined;
    const filterProfileIds = fps ? fps.split(",").filter(Boolean) : fp ? [fp] : [];
    if (filterProfileIds.length > 0) {
      const allProfiles = await storage.getProfiles();
      const selfIds = allProfiles.filter(p => p.type === "self").map(p => p.id);
      const hasSelf = filterProfileIds.some(id => selfIds.includes(id));
      items = items.filter(item => {
        const lp = item.linkedProfiles || [];
        return lp.some(id => filterProfileIds.includes(id)) || (hasSelf && lp.length === 0);
      });
    }
    res.json(paginate(items, req, res));
  }));
  app.get("/api/tasks/:id", asyncHandler(async (req, res) => {
    const tasks = await storage.getTasks();
    const task = tasks.find(t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    // S1 fix: storage layer filters by user_id; defense-in-depth ownership guard.
    if ((task as any).userId && (task as any).userId !== (req as AuthenticatedRequest).userId) {
      return res.status(404).json({ error: "Task not found" });
    }
    res.json(task);
  }));
  app.post("/api/tasks", asyncHandler(async (req, res) => {
    if (!req.body.title || typeof req.body.title !== "string" || !req.body.title.trim()) {
      return res.status(400).json({ error: "Task title required" });
    }
    req.body.title = sanitize(req.body.title);
    if (req.body.description) req.body.description = sanitize(req.body.description);
    const parsed = insertTaskSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation failed", issues: parsed.error.issues });
    const newTask = await storage.createTask(parsed.data);
    const uid_t1 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`tasks:${uid_t1}`); bustCache(`stats:${uid_t1}`); bustCache(`enhanced:`); bustCache(`calendar:${uid_t1}`); bustCache(`notifications:${uid_t1}`);
    res.status(201).json(newTask);
  }));
  app.patch("/api/tasks/:id", asyncHandler(async (req, res) => {
    {
      const parsed = insertTaskSchema.partial().safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: `Validation failed: ${JSON.stringify(parsed.error.flatten())}` });
      req.body = { ...req.body, ...parsed.data };
    }
    if (req.body.title !== undefined) {
      if (typeof req.body.title !== "string" || req.body.title.trim() === "") {
        return res.status(400).json({ error: "Task title must be a non-empty string" });
      }
      req.body.title = sanitize(req.body.title);
    }
    if (req.body.description) req.body.description = sanitize(req.body.description);
    const updated = await storage.updateTask(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    const uid_t2 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`tasks:${uid_t2}`); bustCache(`stats:${uid_t2}`); bustCache(`enhanced:`); bustCache(`calendar:${uid_t2}`); bustCache(`notifications:${uid_t2}`);
    res.json(updated);
  }));
  app.delete("/api/tasks/:id", asyncHandler(async (req, res) => {
    // Idempotent: soft-delete succeeds even if already deleted
    await storage.deleteTask(req.params.id);
    const uid_t3 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`tasks:${uid_t3}`); bustCache(`stats:${uid_t3}`); bustCache(`enhanced:`); bustCache(`calendar:${uid_t3}`); bustCache(`notifications:${uid_t3}`);
    res.json({ success: true });
  }));
  app.patch("/api/tasks/:id/restore", asyncHandler(async (req, res) => {
    const ok = await storage.restoreTask(req.params.id);
    if (!ok) return res.status(404).json({ error: "Task not found" });
    const uid_t4 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`tasks:${uid_t4}`); bustCache(`stats:${uid_t4}`); bustCache(`enhanced:`); bustCache(`calendar:${uid_t4}`); bustCache(`notifications:${uid_t4}`);
    const task = await storage.getTask(req.params.id);
    res.json(task || { id: req.params.id, restored: true });
  }));

  // ---- Budgets ----
  app.get("/api/budgets", asyncHandler(async (req, res) => {
    const month = (req.query.month as string) || getUserCurrentMonth(getTimezone(req));
    const fps = req.query.profileIds as string | undefined;
    const fp = req.query.profileId as string | undefined;
    const filterProfileIds = fps ? fps.split(",").filter(Boolean) : fp ? [fp] : [];
    // Per-profile budgets: when a profile filter is active, return only
    // entries owned by one of the selected profiles plus shared/null-profile
    // entries (handled inside getBudgets). Self-scoped (null profileId)
    // entries are hidden when the filter explicitly excludes the self profile,
    // mirroring the prior behavior for the dashboard hero tile.
    if (filterProfileIds.length > 0) {
      const allProfiles = await storage.getProfiles();
      const selfIds = new Set(allProfiles.filter(p => p.type === "self").map(p => p.id));
      const selfInSel = filterProfileIds.some(id => selfIds.has(id));
      const scoped = await storage.getBudgets(month, filterProfileIds);
      const budgets = selfInSel ? scoped : scoped.filter(b => b.profileId);
      return res.json({ month, budgets });
    }
    const budgets = await storage.getBudgets(month);
    res.json({ month, budgets });
  }));

  app.post("/api/budgets", asyncHandler(async (req, res) => {
    const { month, category, amount, notes, profileId } = req.body;
    if (!category || typeof category !== "string" || !category.trim()) {
      return res.status(400).json({ error: "category is required and must be a non-empty string" });
    }
    if (amount === undefined || amount === null) {
      return res.status(400).json({ error: "amount is required" });
    }
    // Bug fix: previously used Number(amount) which silently converts "abc"
    // (or any junk) to NaN and then writes NaN into the budget JSON, breaking
    // every aggregation that uses it. Reject non-finite / non-positive values
    // at the gateway.
    const parsedAmount = Number(amount);
    if (!isFinite(parsedAmount) || parsedAmount < 0) {
      return res.status(400).json({ error: "amount must be a finite non-negative number" });
    }
    if (notes !== undefined && typeof notes !== "string") {
      return res.status(400).json({ error: "notes must be a string" });
    }
    if (profileId !== undefined && profileId !== null && typeof profileId !== "string") {
      return res.status(400).json({ error: "profileId must be a string" });
    }
    const m = month || getUserCurrentMonth(getTimezone(req));
    const budget = await storage.addBudget(m, category.trim(), parsedAmount, notes, profileId || undefined);
    res.json(budget);
  }));

  app.patch("/api/budgets/:id", asyncHandler(async (req, res) => {
    const month = (req.query.month as string) || getUserCurrentMonth(getTimezone(req));
    // Bug fix: PATCH body was forwarded raw to storage.updateBudget which then
    // spread it onto the budget. A bad amount would silently land in DB.
    if (req.body && typeof req.body === "object") {
      if (req.body.amount !== undefined && req.body.amount !== null) {
        const n = typeof req.body.amount === "number" ? req.body.amount : Number(req.body.amount);
        if (!isFinite(n) || n < 0) {
          return res.status(400).json({ error: "amount must be a finite non-negative number" });
        }
        req.body.amount = n;
      }
      if (req.body.category !== undefined && (typeof req.body.category !== "string" || !req.body.category.trim())) {
        return res.status(400).json({ error: "category must be a non-empty string" });
      }
      if (req.body.notes !== undefined && req.body.notes !== null && typeof req.body.notes !== "string") {
        return res.status(400).json({ error: "notes must be a string" });
      }
    }
    const ok = await storage.updateBudget(month, req.params.id, req.body);
    if (!ok) return res.status(404).json({ error: "Budget not found" });
    res.json({ success: true });
  }));

  app.delete("/api/budgets/:id", asyncHandler(async (req, res) => {
    const month = (req.query.month as string) || getUserCurrentMonth(getTimezone(req));
    const ok = await storage.deleteBudget(month, req.params.id);
    if (!ok) return res.status(404).json({ error: "Budget not found" });
    res.json({ success: true });
  }));

  app.post("/api/budgets/copy", asyncHandler(async (req, res) => {
    const { fromMonth, toMonth } = req.body;
    if (!fromMonth || !toMonth) return res.status(400).json({ error: "fromMonth and toMonth required" });
    const count = await storage.copyBudgetsToMonth(fromMonth, toMonth);
    res.json({ copied: count, toMonth });
  }));

  // ──────────────────────────────────────────────────────────────────────────
  // Import from ChatGPT — finance import engine
  // (prompt → paste → validate → preview → atomic commit → history → undo)
  // ──────────────────────────────────────────────────────────────────────────

  // Resolve the single profile an import is scoped to: the caller's selection,
  // validated to belong to THIS user; falls back to the self profile. Never lets
  // an import target a profile the user doesn't own (cross-user/profile guard).
  async function resolveImportProfileId(req: any): Promise<string> {
    const requested = (req.body?.profileId ?? req.query?.profileId) as string | undefined;
    if (requested && typeof requested === "string") {
      const owned = await storage.getProfile(requested).catch(() => null);
      if (owned) return owned.id;
    }
    const self = await storage.getSelfProfile?.();
    if (self) return self.id;
    const all = await storage.getProfiles();
    if (all.length > 0) return all[0].id;
    throw new Error("No profile available to import into. Create a profile first.");
  }

  // Generate the strict ChatGPT prompt seeded with the user's current finance state.
  app.post("/api/finance-import/prompt", asyncHandler(async (req, res) => {
    const profileId = await resolveImportProfileId(req);
    const [profiles, obligations, history] = await Promise.all([
      storage.getProfiles(),
      storage.getObligations().catch(() => []),
      storage.listFinanceImports(1).catch(() => []),
    ]);
    const byType = (t: string) => profiles.filter((p: any) => p.type === t).map((p: any) => p.name);
    const subs = obligations.filter((o: any) => o.kind === "subscription").map((o: any) => o.name);
    const bills = obligations.filter((o: any) => o.kind !== "subscription").map((o: any) => o.name);
    const month = getUserCurrentMonth(getTimezone(req));
    const budgets = (await storage.getBudgets(month).catch(() => [])).map((b: any) => b.category);
    const profile = profiles.find((p: any) => p.id === profileId);
    const prompt = buildImportPrompt({
      accounts: byType("account"),
      subscriptions: subs,
      budgets,
      liabilities: [...byType("liability"), ...byType("loan"), ...bills],
      assets: [...byType("asset"), ...byType("property"), ...byType("vehicle"), ...byType("investment")],
      lastImportAt: history[0]?.createdAt || null,
      profileName: profile?.name || "Me",
      baseCurrency: "USD",
    });
    res.json({ prompt, profileId, profileName: profile?.name || "Me" });
  }));

  // Validate + dry-run: returns the diff (new/duplicate/update/warnings) WITHOUT writing.
  app.post("/api/finance-import/preview", asyncHandler(async (req, res) => {
    const profileId = await resolveImportProfileId(req);
    const raw = typeof req.body?.json === "string" ? req.body.json : JSON.stringify(req.body?.json ?? "");
    const validation = validateFinanceImport(raw);
    if (!validation.ok || !validation.data) {
      return res.status(422).json({ ok: false, errors: validation.errors });
    }
    const plan = await planImport(storage, validation.data, profileId);
    res.json({ ok: true, profileId, recordCount: validation.recordCount, plan });
  }));

  // Validate + commit atomically. Re-validates server-side (never trusts the client preview).
  app.post("/api/finance-import/commit", asyncHandler(async (req, res) => {
    const profileId = await resolveImportProfileId(req);
    const raw = typeof req.body?.json === "string" ? req.body.json : JSON.stringify(req.body?.json ?? "");
    const validation = validateFinanceImport(raw);
    if (!validation.ok || !validation.data) {
      return res.status(422).json({ ok: false, errors: validation.errors });
    }
    const plan = await planImport(storage, validation.data, profileId);
    const result = await applyImport(storage, validation.data, profileId, plan);
    res.json({ ok: true, batchId: result.batchId, summary: result.summary, plan, profileId });
  }));

  // Import history (most recent first).
  app.get("/api/finance-import/history", asyncHandler(async (_req, res) => {
    const items = await storage.listFinanceImports(50).catch(() => []);
    res.json({ items });
  }));

  // Undo a committed import — deletes every row it created.
  app.post("/api/finance-import/:id/undo", asyncHandler(async (req, res) => {
    try {
      const result = await undoImport(storage, req.params.id);
      res.json({ ok: true, removed: result.removed });
    } catch (e: any) {
      res.status(404).json({ ok: false, error: e?.message || "Import not found" });
    }
  }));

  // ---- Expenses ----
  app.get("/api/expenses", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const ck = `expenses:${uid}`;
    const hit = getCached(ck);
    let items = hit || await dedupe(ck, () => storage.getExpenses());
    if (!hit) setCache(ck, items, 5 * 60 * 1000); // version-stamped key (migration 010): fresh by construction; TTL only bounds memory
    // Server-side filtering
    if (req.query.category && typeof req.query.category === "string") {
      items = items.filter((e: any) => e.category === req.query.category);
    }
    // [P2.4] single (?profileId=) and multi (?profileIds=) now share the same
    // canonical orphan rule via filterByProfileScope.
    const profileIdsParam = req.query.profileIds as string | undefined;
    const expenseFilterIds = profileIdsParam
      ? profileIdsParam.split(",").filter(Boolean)
      : (req.query.profileId && typeof req.query.profileId === "string" ? [req.query.profileId as string] : []);
    if (expenseFilterIds.length > 0) {
      items = await filterByProfileScope(items, expenseFilterIds, uid);
    }
    if (req.query.from && typeof req.query.from === "string") {
      items = items.filter((e: any) => e.date >= (req.query.from as string));
    }
    if (req.query.to && typeof req.query.to === "string") {
      items = items.filter((e: any) => e.date <= (req.query.to as string));
    }
    // Full-by-default: the Finance page computes its total client-side over the
    // entire returned set, so truncating here under-counts the total. Expense
    // rows are small and bounded per user (the dashboard already loads them all
    // server-side), so returning the whole set is cheap and correct.
    res.json(paginateFull(items, req, res));
  }));
  app.get("/api/expenses/:id", asyncHandler(async (req, res) => {
    const expense = await storage.getExpense(req.params.id);
    if (!expense) return res.status(404).json({ error: "Not found" });
    // S1 fix: storage layer filters by user_id; defense-in-depth ownership guard.
    if ((expense as any).userId && (expense as any).userId !== (req as AuthenticatedRequest).userId) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json(expense);
  }));
  app.post("/api/expenses", asyncHandler(async (req, res) => {
    if (!req.body.amount || typeof req.body.amount !== "number" || req.body.amount <= 0) {
      return res.status(400).json({ error: "Positive amount required" });
    }
    if (!req.body.description || typeof req.body.description !== "string" || !req.body.description.trim()) {
      return res.status(400).json({ error: "Description required" });
    }
    const ALLOWED_EXPENSE_CATEGORIES = ["food", "transport", "health", "entertainment", "pet", "vehicle", "housing", "utilities", "general", "education", "shopping", "insurance", "travel", "subscription", "utility", "other"];
    if (req.body.category !== undefined && !ALLOWED_EXPENSE_CATEGORIES.includes(req.body.category)) {
      return res.status(400).json({ error: `Category must be one of: ${ALLOWED_EXPENSE_CATEGORIES.join(", ")}` });
    }
    if (req.body.date !== undefined) {
      const parsed_date = new Date(req.body.date);
      if (isNaN(parsed_date.getTime())) {
        return res.status(400).json({ error: "Date must be a valid date" });
      }
    }
    req.body.description = sanitize(req.body.description);
    if (req.body.vendor) req.body.vendor = sanitize(req.body.vendor);

    // Wave 1 #1 — AI categorize when caller didn't provide a meaningful category.
    // Only fires for missing / "other" / "general" so we don't override deliberate picks.
    if (!req.body.category || req.body.category === "other" || req.body.category === "general") {
      try {
        const decision = await aiPickIndex({
          task: "expense-create-category",
          question: "Which expense category does this transaction belong to?",
          context: `Description: "${req.body.description}"${req.body.vendor ? `\nVendor: "${req.body.vendor}"` : ""}\nAmount: $${req.body.amount}`,
          options: ALLOWED_EXPENSE_CATEGORIES,
          timeoutMs: 3000,
          minConfidence: 0.55,
          fallback: () => -1,
        });
        if (decision.value.index >= 0) {
          req.body.category = ALLOWED_EXPENSE_CATEGORIES[decision.value.index];
        }
      } catch (e: any) {
        console.error(`[expense-create] AI categorize failed silently: ${e?.message || e}`);
      }
    }

    const parsed = insertExpenseSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation failed", issues: parsed.error.issues });
    const newExpense = await storage.createExpense(parsed.data);
    const uid_e1 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`expenses:${uid_e1}`); bustCache(`stats:${uid_e1}`); bustCache(`enhanced:`);
    res.status(201).json(newExpense);
  }));
  app.patch("/api/expenses/:id", asyncHandler(async (req, res) => {
    {
      const parsed = insertExpenseSchema.partial().safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: `Validation failed: ${JSON.stringify(parsed.error.flatten())}` });
      req.body = { ...req.body, ...parsed.data };
    }
    if (req.body.amount !== undefined && (typeof req.body.amount !== "number" || req.body.amount <= 0)) {
      return res.status(400).json({ error: "Expense amount must be a positive number" });
    }
    if (req.body.description) req.body.description = sanitize(req.body.description);
    if (req.body.vendor) req.body.vendor = sanitize(req.body.vendor);
    const updated = await storage.updateExpense(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    const uid_e2 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`expenses:${uid_e2}`); bustCache(`stats:${uid_e2}`); bustCache(`enhanced:`);
    res.json(updated);
  }));
  app.delete("/api/expenses/:id", asyncHandler(async (req, res) => {
    // Idempotent: soft-delete succeeds even if already deleted
    await storage.deleteExpense(req.params.id);
    const uid_e3 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`expenses:${uid_e3}`); bustCache(`stats:${uid_e3}`); bustCache(`enhanced:`);
    res.json({ success: true });
  }));

  // ---- Paychecks ----
  app.get("/api/paychecks", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const ck = `paychecks:${uid}`;
    const hit = getCached(ck);
    let items: Awaited<ReturnType<typeof storage.getPaychecks>> = hit || await dedupe(ck, () => storage.getPaychecks());
    if (!hit) setCache(ck, items, 5 * 60 * 1000); // version-stamped key (migration 010): fresh by construction; TTL only bounds memory
    const profileIdsParam = req.query.profileIds as string | undefined;
    const profileId = req.query.profileId as string | undefined;
    const ids = profileIdsParam ? profileIdsParam.split(",").filter(Boolean) : (profileId ? [profileId] : []);
    if (ids.length > 0) {
      items = items.filter((item: any) => {
        const linked = item.linkedProfiles || [];
        return ids.some(id => linked.includes(id) || item.profileId === id);
      });
    }
    res.json(items);
  }));

  app.post("/api/paychecks", asyncHandler(async (req, res) => {
    const { source, amount, expected_date, notes } = req.body;
    if (!source || typeof source !== "string" || !source.trim()) {
      return res.status(400).json({ error: "source is required and must be a non-empty string" });
    }
    if (amount === undefined || amount === null) {
      return res.status(400).json({ error: "amount is required" });
    }
    // Bug fix: amount was not type-checked, so a payload with amount: "abc"
    // would pass !amount (truthy string) and end up writing a non-numeric
    // value to the paychecks table, breaking the sum-of-paychecks dashboard.
    const numAmount = typeof amount === "number" ? amount : Number(amount);
    if (!isFinite(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: "amount must be a finite positive number" });
    }
    if (!expected_date || typeof expected_date !== "string") {
      return res.status(400).json({ error: "expected_date is required" });
    }
    const dParsed = new Date(expected_date);
    if (isNaN(dParsed.getTime())) {
      return res.status(400).json({ error: "expected_date must be a valid date" });
    }
    const created = await storage.createPaycheck({ source: source.trim(), amount: numAmount, expected_date, notes });
    const uid_pc1 = cacheUserKey(req as AuthenticatedRequest);
    // Bug fix: paychecks list cache had a 3-min TTL but no busting on create —
    // newly added paychecks wouldn't appear on the Finance page until expiry.
    bustCache(`paychecks:${uid_pc1}`); bustCache(`stats:${uid_pc1}`); bustCache(`enhanced:`); bustCache(`cashflow:${uid_pc1}`);
    res.json(created);
  }));

  app.patch("/api/paychecks/:id/confirm", asyncHandler(async (req, res) => {
    const { actual_amount } = req.body;
    const updated = await storage.confirmPaycheck(req.params.id, actual_amount);
    const uid_pc2 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`paychecks:${uid_pc2}`); bustCache(`stats:${uid_pc2}`); bustCache(`enhanced:`); bustCache(`cashflow:${uid_pc2}`);
    res.json(updated);
  }));

  app.delete("/api/paychecks/:id", asyncHandler(async (req, res) => {
    await storage.deletePaycheck(req.params.id);
    const uid_pc3 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`paychecks:${uid_pc3}`); bustCache(`stats:${uid_pc3}`); bustCache(`enhanced:`); bustCache(`cashflow:${uid_pc3}`);
    res.json({ success: true });
  }));

  // ---- Loan Amortization ----
  app.get("/api/loans/schedule", asyncHandler(async (req, res) => {
    const loanId = req.query.loanId as string;
    const profileIdsParam = req.query.profileIds as string | undefined;
    const profileId = req.query.profileId as string | undefined;
    const ids = profileIdsParam ? profileIdsParam.split(",").filter(Boolean) : (profileId ? [profileId] : []);
    let items: any[];
    if (loanId) {
      items = await storage.getLoanSchedule(loanId);
    } else {
      items = await storage.getAllLoanSchedules();
    }
    if (ids.length > 0) {
      items = items.filter((item: any) => {
        const linked = item.linkedProfiles || [];
        return ids.some(id => linked.includes(id) || item.profileId === id);
      });
    }
    res.json(items);
  }));

  app.post("/api/loans/schedule", asyncHandler(async (req, res) => {
    const { entries } = req.body;
    if (!Array.isArray(entries)) return res.status(400).json({ error: "entries array required" });
    const created = await storage.createLoanSchedule(entries);
    const uid_ln1 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`stats:${uid_ln1}`); bustCache(`enhanced:`); bustCache(`cashflow:${uid_ln1}`); bustCache(`profile-detail:${uid_ln1}:`);
    res.json(created);
  }));

  app.patch("/api/loans/payment/:id/mark", asyncHandler(async (req, res) => {
    const updated = await storage.markLoanPayment(req.params.id);
    const uid_ln2 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`stats:${uid_ln2}`); bustCache(`enhanced:`); bustCache(`cashflow:${uid_ln2}`); bustCache(`profile-detail:${uid_ln2}:`);
    res.json(updated);
  }));

  // ---- Cashflow ----
  app.get("/api/cashflow", asyncHandler(async (req, res) => {
    const month = req.query.month as string;
    const profileIdsParam = req.query.profileIds as string | undefined;
    const profileId = req.query.profileId as string | undefined;
    const ids = profileIdsParam ? profileIdsParam.split(",").filter(Boolean) : (profileId ? [profileId] : []);
    let items = await storage.getCashflow(month);
    if (ids.length > 0) {
      // Use the unified passesProfileFilter so non-self profiles do NOT see
      // orphan cashflow rows, but the rule still allows item.profileId direct
      // matches (legacy cashflow rows store the owner in profileId, not
      // linkedProfiles).
      const allProfiles = await storage.getProfiles();
      const filterCtx = { selectedIds: ids, allProfiles };
      items = items.filter((item: any) => {
        const linked = item.linkedProfiles || [];
        if (item.profileId && ids.includes(item.profileId)) return true;
        return passesProfileFilter(linked, filterCtx);
      });
    }
    res.json(items);
  }));

  app.post("/api/cashflow", asyncHandler(async (req, res) => {
    const { month, week, projected_income, projected_expenses, actual_income, actual_expenses } = req.body;
    if (!month || typeof month !== "string") return res.status(400).json({ error: "month is required" });
    if (week === undefined || week === null) return res.status(400).json({ error: "week is required" });
    // Bug fix: previously the four numeric fields were written through with no
    // validation. A bad payload could insert non-numeric values into the
    // cashflow_projections table and corrupt every downstream net-cashflow
    // calculation. Coerce + validate each that's provided.
    const numFields: Record<string, any> = { projected_income, projected_expenses, actual_income, actual_expenses };
    const cleaned: Record<string, number | undefined> = {};
    for (const [k, v] of Object.entries(numFields)) {
      if (v === undefined || v === null) continue;
      const n = typeof v === "number" ? v : Number(v);
      if (!isFinite(n)) {
        return res.status(400).json({ error: `${k} must be a finite number` });
      }
      cleaned[k] = n;
    }
    res.json(await storage.upsertCashflow({ month, week, ...cleaned } as any));
  }));

  // ---- Events ----
  app.get("/api/events", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const ck = `events:${uid}`;
    const hit = getCached(ck);
    let items = hit || await dedupe(ck, () => storage.getEvents());
    if (!hit) setCache(ck, items, 5 * 60 * 1000); // version-stamped key (migration 010): fresh by construction; TTL only bounds memory
    const profileIdsParam = req.query.profileIds as string | undefined;
    if (profileIdsParam) {
      // [P2.4] canonical orphan rule — see filterByProfileScope.
      const ids = profileIdsParam.split(",").filter(Boolean);
      items = await filterByProfileScope(items, ids, uid);
    }
    res.json(paginate(items, req, res));
  }));
  app.get("/api/events/:id", asyncHandler(async (req, res) => {
    const event = await storage.getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: "Not found" });
    // S1 fix: storage layer filters by user_id; defense-in-depth ownership guard.
    if ((event as any).userId && (event as any).userId !== (req as AuthenticatedRequest).userId) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json(event);
  }));
  app.post("/api/events", asyncHandler(async (req, res) => {
    const parsed = insertEventSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation failed", issues: parsed.error.issues });
    const newEvent = await storage.createEvent(parsed.data);
    const uid_ev1 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`events:${uid_ev1}`); bustCache(`stats:${uid_ev1}`); bustCache(`enhanced:`); bustCache(`calendar:${uid_ev1}`);
    res.status(201).json(newEvent);
  }));
  app.patch("/api/events/:id", asyncHandler(async (req, res) => {
    {
      const parsed = insertEventSchema.partial().safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: `Validation failed: ${JSON.stringify(parsed.error.flatten())}` });
      req.body = { ...req.body, ...parsed.data };
    }
    if (req.body.title !== undefined) {
      if (typeof req.body.title !== "string" || !req.body.title.trim()) return res.status(400).json({ error: "Event title must be a non-empty string" });
      req.body.title = sanitize(req.body.title);
    }
    const updated = await storage.updateEvent(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    const uid_ev2 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`events:${uid_ev2}`); bustCache(`stats:${uid_ev2}`); bustCache(`enhanced:`); bustCache(`calendar:${uid_ev2}`);
    res.json(updated);
  }));
  app.delete("/api/events/:id", asyncHandler(async (req, res) => {
    const existing = await storage.getEvent(req.params.id);
    if (!existing) return res.status(404).json({ error: "Event not found" });
    await storage.deleteEvent(req.params.id);
    const uid_ev3 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`events:${uid_ev3}`); bustCache(`stats:${uid_ev3}`); bustCache(`enhanced:`); bustCache(`calendar:${uid_ev3}`);
    res.json({ success: true });
  }));

  // ---- Unified Calendar Timeline ----
  app.get("/api/calendar/timeline", asyncHandler(async (req, res) => {
    const startRaw = req.query.start as string;
    const endRaw = req.query.end as string;
    const tz = getTimezone(req);
    const start = (startRaw && isValidDateStr(startRaw)) ? startRaw : getUserToday(tz);
    const endDefault = toLocalDateStr(new Date(Date.now() + 60 * 86400000), tz);
    const end = (endRaw && isValidDateStr(endRaw)) ? endRaw : endDefault;
    const profileIdsRaw = req.query.profileIds as string | undefined;
    const profileIds = profileIdsRaw ? profileIdsRaw.split(",").filter(Boolean) : undefined;
    try {
      const items = await storage.getCalendarTimeline(start, end, profileIds);
      res.json(items);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to load calendar" });
    }
  }));

  // ---- Documents ----
  app.get("/api/documents", asyncHandler(async (req, res) => {
    let items = await storage.getDocuments();
    // [P2.4] Profile filter (parity with /api/obligations, /api/tasks, etc.) —
    // single and multi param share the canonical orphan rule via filterByProfileScope.
    const profileIdsParam = req.query.profileIds as string | undefined;
    const fp = req.query.profileId as string | undefined;
    const docFilterIds = profileIdsParam ? profileIdsParam.split(",").filter(Boolean) : (fp ? [fp] : []);
    if (docFilterIds.length > 0) {
      const uid_doc = cacheUserKey(req as AuthenticatedRequest);
      items = await filterByProfileScope(items, docFilterIds, uid_doc);
    }
    res.json(paginate(items, req, res));
  }));
  app.get("/api/documents/:id", asyncHandler(async (req, res) => {
    const doc = await storage.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    // S1 fix: storage layer filters by user_id; defense-in-depth ownership guard.
    if ((doc as any).userId && (doc as any).userId !== (req as AuthenticatedRequest).userId) {
      return res.status(404).json({ error: "Not found" });
    }
    // Strip base64 fileData from JSON response — clients fetch binary via /file.
    // But tell the client whether a binary exists so the preview UI can render
    // <img src=/file> instead of showing "No preview available" for docs that
    // DO have a file.
    const { fileData, ...docMeta } = doc as any;
    const hasFile = !!fileData && String(fileData).length > 0;
    res.json({ ...docMeta, hasFile, fileSize: hasFile ? Math.floor(String(fileData).length * 0.75) : 0 });
  }));
  app.post("/api/documents", asyncHandler(async (req, res) => {
    if (!req.body.name || typeof req.body.name !== "string" || !req.body.name.trim()) {
      return res.status(400).json({ error: "Document name is required" });
    }
    req.body.name = sanitize(req.body.name);
    if (!req.body.type || typeof req.body.type !== "string") {
      return res.status(400).json({ error: "Document type is required" });
    }
    try {
      // Wave 1 #2 — AI auto-link to profile when caller didn't specify any.
      // Reads the doc name + extracted fields and picks the best matching profile
      // (e.g. "Sarah's drivers license.pdf" → Sarah's profile). Falls back to no
      // linkage so behaviour is identical to before when AI is unavailable.
      const linked = Array.isArray(req.body.linkedProfiles) ? req.body.linkedProfiles : [];
      if (linked.length === 0) {
        try {
          const profiles = await storage.getProfiles();
          if (profiles && profiles.length > 0) {
            const extracted = req.body.extractedData || {};
            const ctxLines = [
              `Document name: ${req.body.name}`,
              `Document type: ${req.body.type}`,
            ];
            // Surface any name-ish fields the extractor pulled out
            for (const k of ["fullName", "name", "firstName", "lastName", "owner", "holder", "insured", "patient", "recipient", "licensee"]) {
              if (typeof (extracted as any)[k] === "string") ctxLines.push(`${k}: ${(extracted as any)[k]}`);
            }
            const options = profiles.map((p: any) => {
              const parts = [p.name];
              if (p.relationship) parts.push(`(${p.relationship})`);
              if (p.dateOfBirth) parts.push(`DOB ${p.dateOfBirth}`);
              return parts.join(" ");
            });
            const decision = await aiPickIndex({
              task: "doc-create-link-profile",
              question: "Which profile does this document most likely belong to? Pick -1 only if no profile clearly matches.",
              context: ctxLines.join("\n"),
              options,
              timeoutMs: 3500,
              minConfidence: 0.6,
              fallback: () => -1,
            });
            if (decision.value.index >= 0 && profiles[decision.value.index]) {
              req.body.linkedProfiles = [profiles[decision.value.index].id];
            }
          }
        } catch (e: any) {
          console.error(`[doc-create] AI auto-link failed silently: ${e?.message || e}`);
        }
      }

      const doc = await storage.createDocument(req.body);
      const uid_d1 = cacheUserKey(req as AuthenticatedRequest);
      bustCache(`documents:${uid_d1}`); bustCache(`stats:${uid_d1}`); bustCache(`enhanced:`); bustCache(`profile-detail:${uid_d1}:`); bustCache(`notifications:${uid_d1}`);
      res.status(201).json(doc);
    } catch (err: any) {
      console.error("[documents]", err?.message || err);
      res.status(400).json({ error: "Failed to create document" });
    }
  }));
  app.patch("/api/documents/:id", asyncHandler(async (req, res) => {
    {
      const parsed = insertDocumentSchema.partial().safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: `Validation failed: ${JSON.stringify(parsed.error.flatten())}` });
      req.body = { ...req.body, ...parsed.data };
    }
    if (req.body.name !== undefined) {
      if (typeof req.body.name !== "string" || !req.body.name.trim()) return res.status(400).json({ error: "Document name must be a non-empty string" });
      req.body.name = sanitize(req.body.name);
    }
    const updated = await storage.updateDocument(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    const uid_d2 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`documents:${uid_d2}`); bustCache(`stats:${uid_d2}`); bustCache(`enhanced:`); bustCache(`profile-detail:${uid_d2}:`); bustCache(`notifications:${uid_d2}`);
    res.json(updated);
  }));
  app.delete("/api/documents/:id", asyncHandler(async (req, res) => {
    // Idempotent: soft-delete succeeds even if already deleted
    await storage.deleteDocument(req.params.id);
    const uid_d3 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`documents:${uid_d3}`); bustCache(`stats:${uid_d3}`); bustCache(`enhanced:`); bustCache(`profile-detail:${uid_d3}:`); bustCache(`notifications:${uid_d3}`);
    res.json({ success: true });
  }));
  // ---- Re-extract: re-read a stored document and recover missed fields ----
  // No re-upload needed — we re-read the file bytes saved at upload time and
  // merge any newly-found fields into extractedData (existing values kept).
  app.post("/api/documents/:id/reextract", asyncHandler(async (req, res) => {
    const doc = await storage.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    const result = await reextractDocument(req.params.id);
    if (!result.ok) return res.status(422).json({ error: result.message });
    const uidR = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`documents:${uidR}`); bustCache(`stats:${uidR}`); bustCache(`enhanced:`); bustCache(`profile-detail:${uidR}:`);
    res.json(result);
  }));

  // Bulk re-extraction across every stored document. Runs sequentially to stay
  // within model rate limits; returns a per-document summary of recovered fields.
  app.post("/api/documents/reextract-all", asyncHandler(async (req, res) => {
    const docs = await storage.getDocuments();
    const results: Array<{ id: string; name: string; ok: boolean; addedKeys: string[]; message: string }> = [];
    let totalNewFields = 0;
    for (const d of docs) {
      try {
        const r = await reextractDocument((d as any).id);
        const added = r.addedKeys || [];
        totalNewFields += added.length;
        results.push({ id: (d as any).id, name: (d as any).name, ok: r.ok, addedKeys: added, message: r.message });
      } catch (e: any) {
        results.push({ id: (d as any).id, name: (d as any).name, ok: false, addedKeys: [], message: e?.message || "failed" });
      }
    }
    const uidR = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`documents:${uidR}`); bustCache(`stats:${uidR}`); bustCache(`enhanced:`); bustCache(`profile-detail:${uidR}:`);
    res.json({ documentsProcessed: docs.length, totalNewFields, results });
  }));

  app.get("/api/profiles/:id/documents", asyncHandler(async (req, res) => {
    // Pre-check: verify the profile belongs to the requester before returning
    // any docs linked to it, otherwise an attacker can enumerate another user's
    // documents by guessing profile UUIDs.
    const profile = await storage.getProfile(req.params.id);
    if (!profile) return res.status(404).json({ error: "Resource not found" });
    res.json(await storage.getDocumentsForProfile(req.params.id));
  }));

  // ---- Document file serving (for download / share) ----
  app.get("/api/documents/:id/file", asyncHandler(async (req, res) => {
    const doc = await storage.getDocument(req.params.id);
    if (!doc || !doc.fileData) return res.status(404).json({ error: "Not found" });
    // S1 fix: storage layer filters by user_id; defense-in-depth ownership guard.
    if ((doc as any).userId && (doc as any).userId !== (req as AuthenticatedRequest).userId) {
      return res.status(404).json({ error: "Not found" });
    }
    const buffer = Buffer.from(doc.fileData, "base64");
    res.setHeader("Content-Type", doc.mimeType);
    // Sanitize filename: strip all non-alphanumeric except dots, hyphens, underscores
    const safeName = (doc.name || 'document').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
    // Defence against MIME-confused script execution: force download for active
    // content types and strip browser sniffing on every response.
    const activeMime = new Set([
      "text/html",
      "image/svg+xml",
      "application/xhtml+xml",
    ]);
    const disposition = activeMime.has((doc.mimeType || "").toLowerCase()) ? "attachment" : "inline";
    res.setHeader("Content-Disposition", `${disposition}; filename="${safeName}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    res.setHeader("Content-Length", buffer.length.toString());
    res.send(buffer);
  }));

  // ---- Document Email with Attachment (Resend) ----
  app.post("/api/documents/:id/send-email", asyncHandler(async (req, res) => {
    const emailUserId = (req as AuthenticatedRequest).userId || req.ip || 'anonymous';
    if (rateLimit(`email:${emailUserId}`, 10, 3600000)) {
      return res.status(429).json({ error: "Too many email send attempts. Try again in an hour." });
    }
    const { to, subject, message } = req.body as { to: string; subject?: string; message?: string };
    if (!to || !to.includes('@')) return res.status(400).json({ error: "Valid email required" });

    // Fetch document with its file data (getDocument downloads from storage if needed)
    const doc = await storage.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });

    const RESEND_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_KEY) {
      console.error('[email] RESEND_API_KEY env var not set');
      return res.status(503).json({ error: "Email service not configured" });
    }

    // Build file extension for attachment filename
    const mimeExtMap: Record<string, string> = {
      'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/jpg': '.jpg',
      'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
      'text/plain': '.txt', 'text/csv': '.csv',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
      'application/msword': '.doc', 'application/vnd.ms-excel': '.xls',
    };
    const ext = mimeExtMap[doc.mimeType || ''] || '';
    const filename = doc.name.endsWith(ext) ? doc.name : `${doc.name}${ext}`;

    // Attachment: use base64 fileData if available (limit 10MB to stay within Resend limit)
    const attachments: { filename: string; content: string; content_type?: string }[] = [];
    if (doc.fileData && doc.fileData.length > 10 && doc.fileData.length < 10_000_000) {
      attachments.push({
        filename,
        content: doc.fileData,          // already base64
        content_type: doc.mimeType || 'application/octet-stream',
      });
    }

    const hasAttachment = attachments.length > 0;
    const emailBody: any = {
      from: "Portol <onboarding@resend.dev>",
      to: [to],
      subject: subject || `${doc.name} — shared from Portol`,
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <div style="margin-bottom:20px">
          <img src="https://portol.me/portol-logo-sm.png" alt="Portol" height="28" />
        </div>
        <h2 style="color:#1a1a1a;margin:0 0 8px">${doc.name}</h2>
        <p style="color:#666;font-size:13px;margin:0 0 16px">Type: ${doc.type || doc.mimeType || 'document'}</p>
        ${message ? `<p style="color:#444;font-size:14px;background:#f5f5f5;padding:12px;border-radius:6px">${message}</p>` : ''}
        ${hasAttachment
          ? `<p style="color:#444;font-size:13px;">The document is attached to this email.</p>`
          : `<p style="color:#888;font-size:12px;">File could not be attached (too large or unavailable).</p>`
        }
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0" />
        <p style="color:#999;font-size:11px">Sent via Portol &bull; <a href="https://portol.me" style="color:#6d28d9">portol.me</a></p>
      </div>`,
    };

    if (attachments.length > 0) emailBody.attachments = attachments;

    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(emailBody),
    });
    const result = await resp.json();
    if (!resp.ok) {
      console.error('[send-email] Resend error:', result);
      return res.status(500).json({ error: result.message || result.name || "Email failed to send", detail: result });
    }
    res.json({ success: true, emailId: result.id, attached: hasAttachment, filename: hasAttachment ? filename : undefined });
  }));

  // ---- Habits ----
  app.get("/api/habits", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const ck = `habits:${uid}`;
    const hit = getCached(ck);
    let items = hit || await dedupe(ck, () => storage.getHabits());
    if (!hit) setCache(ck, items, 5 * 60 * 1000); // version-stamped key (migration 010): fresh by construction; TTL only bounds memory
    // [P2.4] single (?profileId=) and multi (?profileIds=) now share the same
    // canonical orphan rule via filterByProfileScope.
    const profileIdsParam = req.query.profileIds as string | undefined;
    const fp = req.query.profileId as string | undefined;
    const habitFilterIds = profileIdsParam ? profileIdsParam.split(",").filter(Boolean) : (fp ? [fp] : []);
    if (habitFilterIds.length > 0) {
      items = await filterByProfileScope(items, habitFilterIds, uid);
    }
    res.json(paginate(items, req, res));
  }));
  app.get("/api/habits/:id", asyncHandler(async (req, res) => {
    const habit = await storage.getHabit(req.params.id);
    if (!habit) return res.status(404).json({ error: "Not found" });
    // S1 fix: storage layer filters by user_id; defense-in-depth ownership guard.
    if ((habit as any).userId && (habit as any).userId !== (req as AuthenticatedRequest).userId) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json(habit);
  }));
  app.post("/api/habits", asyncHandler(async (req, res) => {
    if (!req.body.name || typeof req.body.name !== "string" || !req.body.name.trim()) {
      return res.status(400).json({ error: "Habit name is required" });
    }
    const parsed = insertHabitSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation failed", issues: parsed.error.issues });
    let newHabit = await storage.createHabit(parsed.data);
    // Apply linkedProfiles if provided (not part of insert schema)
    if (Array.isArray(req.body.linkedProfiles) && req.body.linkedProfiles.length > 0) {
      const updated = await storage.updateHabit(newHabit.id, { linkedProfiles: req.body.linkedProfiles });
      if (updated) newHabit = updated;
    }
    const uid_h3 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`habits:${uid_h3}`); bustCache(`stats:${uid_h3}`); bustCache(`enhanced:`); bustCache(`notifications:${uid_h3}`);
    res.status(201).json(newHabit);
  }));
  app.post("/api/habits/:id/checkin", asyncHandler(async (req, res) => {
    const { date, value, notes } = req.body;
    const checkin = await storage.checkinHabit(req.params.id, date, value, notes);
    if (!checkin) return res.status(404).json({ error: "Habit not found" });
    // Return the full updated habit (with recalculated streak) instead of just the checkin
    const updatedHabit = await storage.getHabit(req.params.id);
    const uid_h1 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`habits:${uid_h1}`); bustCache(`stats:${uid_h1}`); bustCache(`enhanced:`); bustCache(`notifications:${uid_h1}`);
    res.status(201).json(updatedHabit || checkin);
  }));
  app.delete("/api/habits/:id/checkin/:checkinId", asyncHandler(async (req, res) => {
    const ok = await storage.deleteHabitCheckin(req.params.id, req.params.checkinId);
    if (!ok) return res.status(404).json({ error: "Checkin not found" });
    const uid_h2 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`habits:${uid_h2}`); bustCache(`stats:${uid_h2}`); bustCache(`enhanced:`); bustCache(`notifications:${uid_h2}`);
    res.json({ success: true });
  }));
  app.patch("/api/habits/:id", asyncHandler(async (req, res) => {
    try {
      {
        const parsed = insertHabitSchema.partial().safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: `Validation failed: ${JSON.stringify(parsed.error.flatten())}` });
        req.body = { ...req.body, ...parsed.data };
      }
      const result = await storage.updateHabit(req.params.id, req.body);
      if (!result) return res.status(404).json({ error: "Habit not found" });
      const uid_h4 = cacheUserKey(req as AuthenticatedRequest);
      bustCache(`habits:${uid_h4}`); bustCache(`stats:${uid_h4}`); bustCache(`enhanced:`);
      res.json(result);
    } catch (e: any) { console.error("[habits]", e?.message || e); res.status(500).json({ error: "Failed to update habit" }); }
  }));
  app.delete("/api/habits/:id", asyncHandler(async (req, res) => {
    const existing = await storage.getHabit(req.params.id);
    if (!existing) return res.status(404).json({ error: "Habit not found" });
    await storage.deleteHabit(req.params.id);
    const uid_h5 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`habits:${uid_h5}`); bustCache(`stats:${uid_h5}`); bustCache(`enhanced:`);
    res.json({ success: true });
  }));
  app.patch("/api/habits/:id/restore", asyncHandler(async (req, res) => {
    const ok = await storage.restoreHabit(req.params.id);
    if (!ok) return res.status(404).json({ error: "Habit not found" });
    const uid_h6 = cacheUserKey(req as AuthenticatedRequest);
    // Bug fix: missing `enhanced:` bust meant a restored habit could remain
    // missing from the dashboard until the 15-second cache expired.
    bustCache(`habits:${uid_h6}`); bustCache(`stats:${uid_h6}`); bustCache(`enhanced:`);
    const habit = await storage.getHabit(req.params.id);
    res.json(habit || { id: req.params.id, restored: true });
  }));

  // ---- Obligations ----
  app.get("/api/obligations", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const ck = `obligations:${uid}`;
    const hit = getCached(ck);
    let items: Awaited<ReturnType<typeof storage.getObligations>> = hit || await dedupe(ck, () => storage.getObligations());
    if (!hit) setCache(ck, items, 5 * 60 * 1000); // version-stamped key (migration 010): fresh by construction; TTL only bounds memory
    // [P2.4] single (?profileId=) and multi (?profileIds=) now share the same
    // canonical orphan rule via filterByProfileScope.
    const profileIdsParam = req.query.profileIds as string | undefined;
    const fp = req.query.profileId as string | undefined;
    const oblFilterIds = profileIdsParam ? profileIdsParam.split(",").filter(Boolean) : (fp ? [fp] : []);
    if (oblFilterIds.length > 0) {
      items = await filterByProfileScope(items, oblFilterIds, uid);
    }
    res.json(paginate(items, req, res));
  }));
  app.get("/api/obligations/:id", asyncHandler(async (req, res) => {
    const ob = await storage.getObligation(req.params.id);
    if (!ob) return res.status(404).json({ error: "Not found" });
    // S1 fix: storage layer filters by user_id; defense-in-depth ownership guard.
    if ((ob as any).userId && (ob as any).userId !== (req as AuthenticatedRequest).userId) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json(ob);
  }));
  // BUG-REC-001 (Round 7): in-memory dedup so a user mashing the Quick-Add
  // "Add" button doesn't create N copies of the same obligation. Key includes
  // name+amount+frequency+nextDueDate so two genuinely distinct obligations
  // submitted in quick succession still both get through. 8s window matches
  // /pay dedup. Memory bounded the same way (cleanup once >500 entries).
  const recentObligationCreates = new Map<string, { at: number; id: string }>();
  app.post("/api/obligations", asyncHandler(async (req, res) => {
    const parsed = insertObligationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation failed", issues: parsed.error.issues });
    const uid_o1 = cacheUserKey(req as AuthenticatedRequest);
    // Build a stable fingerprint of the new obligation. Same uid + same
    // name/amount/frequency/nextDueDate inside 8s = treat as a duplicate
    // click and return the original record instead of inserting again.
    const fp = `${uid_o1}|${(parsed.data.name || "").trim().toLowerCase()}|${Number(parsed.data.amount) || 0}|${parsed.data.frequency || ""}|${parsed.data.nextDueDate || ""}`;
    const prior = recentObligationCreates.get(fp);
    if (prior && Date.now() - prior.at < 8000) {
      // Re-fetch so the response shape matches a fresh insert.
      const existing = await storage.getObligation(prior.id);
      if (existing) {
        return res.status(200).json({ ...existing, deduped: true });
      }
    }
    const created = await storage.createObligation(parsed.data);
    recentObligationCreates.set(fp, { at: Date.now(), id: created.id });
    if (recentObligationCreates.size > 500) {
      const cutoff = Date.now() - 30000;
      for (const [k, v] of recentObligationCreates) if (v.at < cutoff) recentObligationCreates.delete(k);
    }
    bustCache(`obligations:${uid_o1}`); bustCache(`stats:${uid_o1}`); bustCache(`enhanced:`); bustCache(`cashflow:${uid_o1}`); bustCache(`calendar:${uid_o1}`); bustCache(`notifications:${uid_o1}`);
    res.status(201).json(created);
  }));
  app.patch("/api/obligations/:id", asyncHandler(async (req, res) => {
    {
      const parsed = insertObligationSchema.partial().safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: `Validation failed: ${JSON.stringify(parsed.error.flatten())}` });
      req.body = { ...req.body, ...parsed.data };
    }
    if (req.body.name !== undefined) {
      if (typeof req.body.name !== "string" || !req.body.name.trim()) return res.status(400).json({ error: "Obligation name must be a non-empty string" });
      req.body.name = sanitize(req.body.name);
    }
    if (req.body.amount !== undefined && (typeof req.body.amount !== "number" || req.body.amount < 0)) {
      return res.status(400).json({ error: "Amount must be a non-negative number" });
    }
    const updated = await storage.updateObligation(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    const uid_o2 = cacheUserKey(req as AuthenticatedRequest);
    // BUG-20260528-obligation-patch-materialize: previously the PATCH handler
    // never re-materialized occurrences, so edits to frequency or nextDueDate
    // wouldn't show on the calendar/obligations list until /materialize was
    // explicitly called. Now best-effort regenerate so calendar reflects edit.
    if (
      req.body.frequency !== undefined ||
      req.body.nextDueDate !== undefined ||
      req.body.amount !== undefined ||
      req.body.startDate !== undefined ||
      req.body.endDate !== undefined
    ) {
      try {
        const { materializeOccurrences } = await import("./obligation-engine");
        const supabase = (storage as any).supabase;
        if (supabase) await materializeOccurrences(supabase, uid_o2, req.params.id);
      } catch (e: any) {
        log.warn("[obligation PATCH] materialize failed", e?.message || e);
      }
    }
    bustCache(`obligations:${uid_o2}`); bustCache(`stats:${uid_o2}`); bustCache(`enhanced:`); bustCache(`cashflow:${uid_o2}`); bustCache(`calendar:${uid_o2}`); bustCache(`notifications:${uid_o2}`);
    res.json(updated);
  }));
  // In-memory dedupe to absorb rapid double/triple-click of the "Mark Paid"
  // button on flaky connections (the previous implementation let users create
  // 3 duplicate payments by tapping when the UI didn't update fast enough).
  // Key = userId:obligationId; cleared after 8s.
  const recentPayments = new Map<string, number>();
  app.post("/api/obligations/:id/pay", asyncHandler(async (req, res) => {
    let { amount, method, confirmationNumber, date } = req.body;
    if (amount !== undefined && (typeof amount !== "number" || amount <= 0)) {
      return res.status(400).json({ error: "Payment amount must be a positive number" });
    }
    // Validate date if provided
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "Date must be YYYY-MM-DD format" });
    }
    // Default to obligation's own amount if none provided
    const uid_o3 = cacheUserKey(req as AuthenticatedRequest);
    if (amount === undefined || amount === null) {
      const ob = await storage.getObligation(req.params.id);
      if (!ob) return res.status(404).json({ error: "Obligation not found" });
      amount = ob.amount;
    }
    // Idempotency window: ignore identical pay request within 8s
    const dedupeKey = `${uid_o3}:${req.params.id}`;
    const lastAt = recentPayments.get(dedupeKey) || 0;
    if (Date.now() - lastAt < 8000) {
      return res.status(200).json({ ok: true, deduped: true });
    }
    recentPayments.set(dedupeKey, Date.now());
    // Clean old entries occasionally to bound memory
    if (recentPayments.size > 500) {
      const cutoff = Date.now() - 30000;
      for (const [k, t] of recentPayments) if (t < cutoff) recentPayments.delete(k);
    }
    const payment = await storage.payObligation(req.params.id, amount, method, confirmationNumber);
    if (!payment) return res.status(404).json({ error: "Obligation not found" });
    bustCache(`obligations:${uid_o3}`); bustCache(`stats:${uid_o3}`); bustCache(`enhanced:`); bustCache(`cashflow:${uid_o3}`); bustCache(`expenses:${uid_o3}`); bustCache(`calendar:${uid_o3}`); bustCache(`notifications:${uid_o3}`);
    res.status(201).json(payment);
  }));

  // Undo the most recent payment for an obligation. The toast-action "Undo"
  // button shown right after marking-paid was previously a no-op (it PATCHed
  // a non-existent `isPaid` field). This deletes the latest obligation_payments
  // row so the obligation re-appears as unpaid for the current period.
  app.delete("/api/obligations/:id/last-payment", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const ob = await storage.getObligation(req.params.id);
    if (!ob) return res.status(404).json({ error: "Obligation not found" });
    if (!ob.payments || ob.payments.length === 0) {
      return res.status(404).json({ error: "No payments to undo" });
    }
    // Pick the most recent payment (by createdAt if available, else by date).
    const sorted = [...ob.payments].sort((a, b) => {
      const ak = (a.createdAt || a.date || "");
      const bk = (b.createdAt || b.date || "");
      return bk.localeCompare(ak);
    });
    const latest = sorted[0];
    const { error } = await (storage as any).supabase
      .from("obligation_payments")
      .delete()
      .eq("id", latest.id)
      .eq("user_id", uid);
    if (error) {
      console.error("[api] undo payment failed:", error.message);
      return res.status(500).json({ error: "Failed to undo payment" });
    }
    // Also clear the dedupe entry so the user can immediately re-pay.
    recentPayments.delete(`${uid}:${req.params.id}`);
    bustCache(`obligations:${uid}`); bustCache(`stats:${uid}`); bustCache(`enhanced:`); bustCache(`cashflow:${uid}`); bustCache(`expenses:${uid}`); bustCache(`calendar:${uid}`); bustCache(`notifications:${uid}`);
    res.json({ success: true, deletedPaymentId: latest.id });
  }));

  app.delete("/api/obligations/:id", asyncHandler(async (req, res) => {
    const existing = await storage.getObligation(req.params.id);
    if (!existing) return res.status(404).json({ error: "Obligation not found" });
    await storage.deleteObligation(req.params.id);
    const uid_o4 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`obligations:${uid_o4}`); bustCache(`stats:${uid_o4}`); bustCache(`enhanced:`); bustCache(`cashflow:${uid_o4}`); bustCache(`calendar:${uid_o4}`); bustCache(`notifications:${uid_o4}`);
    res.json({ success: true });
  }));

  // ─── Obligation Occurrences (Wave 16) ────────────────────────────────────
  // Per-instance status tracking so a single recurring obligation can have
  // some occurrences marked done, some skipped, some rescheduled, etc.
  // These power the new dashboard "Due today / Overdue / Upcoming" cards
  // and the calendar chips.
  app.get("/api/obligation-occurrences", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const tz = getTimezone(req);
    const today = getUserToday(tz);
    const start = (req.query.start as string) && /^\d{4}-\d{2}-\d{2}$/.test(req.query.start as string)
      ? (req.query.start as string)
      : today;
    const end = (req.query.end as string) && /^\d{4}-\d{2}-\d{2}$/.test(req.query.end as string)
      ? (req.query.end as string)
      : toLocalDateStr(new Date(Date.now() + 90 * 86400000), tz);
    const { listOccurrences, backfillLateStatuses } = await import("./obligation-engine");
    const supabase = (storage as any).supabase;
    // Cheap maintenance pass — keeps 'pending' rows from looking on-time when
    // they're already past due. Bounded by index on (user_id,status,due_at).
    await backfillLateStatuses(supabase, uid);
    let items = await listOccurrences(supabase, uid, start, end);
    // Profile filter — each occurrence carries its parent obligation with
    // linked_profiles. Match parity with /api/obligations.
    const profileIdsParam = req.query.profileIds as string | undefined;
    const fp = req.query.profileId as string | undefined;
    if (profileIdsParam) {
      const ids = profileIdsParam.split(",").filter(Boolean);
      if (ids.length > 0) {
        items = items.filter((occ: any) => {
          const lp: string[] = occ?.obligation?.linked_profiles || occ?.obligation?.linkedProfiles || [];
          return lp.some((pid: string) => ids.includes(pid));
        });
      }
    } else if (fp) {
      const allProfiles = await storage.getProfiles();
      const isSelf = allProfiles.find(p => p.id === fp)?.type === "self";
      items = items.filter((occ: any) => {
        const lp: string[] = occ?.obligation?.linked_profiles || occ?.obligation?.linkedProfiles || [];
        return lp.includes(fp) || (isSelf && lp.length === 0);
      });
    }
    res.json(items);
  }));

  app.post("/api/obligations/:id/materialize", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    // Wave 17: default horizon is the engine's default (2 years). When the caller
    // explicitly passes `days`, clamp to [7, 1825] (5 years) so we still bound a
    // pathological request but allow full-series materialization on demand.
    const { materializeOccurrences } = await import("./obligation-engine");
    const supabase = (storage as any).supabase;
    const requested = Number(req.body?.days);
    const result = req.body?.days !== undefined && Number.isFinite(requested)
      ? await materializeOccurrences(supabase, uid, req.params.id, Math.min(1825, Math.max(7, requested)))
      : await materializeOccurrences(supabase, uid, req.params.id);
    bustCache(`calendar:${uid}`); bustCache(`enhanced:`);
    res.json(result);
  }));

  app.post("/api/obligation-occurrences/:occId/status", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const { status, actualAmount, method, notes } = req.body || {};
    const allowed = ["done", "skipped", "pending", "late"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of ${allowed.join(", ")}` });
    }
    if (actualAmount !== undefined && (typeof actualAmount !== "number" || actualAmount < 0)) {
      return res.status(400).json({ error: "actualAmount must be a non-negative number" });
    }
    const { markOccurrence } = await import("./obligation-engine");
    const supabase = (storage as any).supabase;
    const result = await markOccurrence(supabase, uid, req.params.occId, status, { actualAmount, method, notes });
    if (!result.ok) return res.status(400).json({ error: result.error });
    bustCache(`obligations:${uid}`); bustCache(`stats:${uid}`); bustCache(`enhanced:`);
    bustCache(`cashflow:${uid}`); bustCache(`expenses:${uid}`); bustCache(`calendar:${uid}`);
    bustCache(`notifications:${uid}`); bustCache(`profile-detail:${uid}:`);
    res.json(result.occurrence);
  }));

  app.post("/api/obligation-occurrences/:occId/reschedule", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const { newDueAt } = req.body || {};
    const { rescheduleOccurrence } = await import("./obligation-engine");
    const supabase = (storage as any).supabase;
    const result = await rescheduleOccurrence(supabase, uid, req.params.occId, newDueAt);
    if (!result.ok) return res.status(400).json({ error: result.error });
    bustCache(`calendar:${uid}`); bustCache(`enhanced:`); bustCache(`notifications:${uid}`);
    res.json(result.occurrence);
  }));

  // ---- Artifacts ----
  app.get("/api/artifacts", asyncHandler(async (req, res) => {
    let items = await storage.getArtifacts();
    const profileIdsParam = req.query.profileIds as string | undefined;
    if (profileIdsParam) {
      // [P3.3] canonical orphan rule — artifacts store linkedProfiles at the
      // top level (rowToArtifact maps linked_profiles), same as other entities.
      const ids = profileIdsParam.split(",").filter(Boolean);
      const uid_ar = cacheUserKey(req as AuthenticatedRequest);
      items = await filterByProfileScope(items, ids, uid_ar);
    }
    res.json(paginate(items, req, res));
  }));
  app.get("/api/artifacts/:id", asyncHandler(async (req, res) => {
    const artifact = await storage.getArtifact(req.params.id);
    if (!artifact) return res.status(404).json({ error: "Not found" });
    res.json(artifact);
  }));
  app.post("/api/artifacts", asyncHandler(async (req, res) => {
    if (req.body.title) req.body.title = sanitize(req.body.title);
    const parsed = insertArtifactSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation failed", issues: parsed.error.issues });
    const created = await storage.createArtifact(parsed.data);
    const uid_a1 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`artifacts:${uid_a1}`); bustCache(`stats:${uid_a1}`); bustCache(`enhanced:`);
    res.status(201).json(created);
  }));
  app.patch("/api/artifacts/:id", asyncHandler(async (req, res) => {
    // P1 universal-delete: capture `metadataToDelete` BEFORE Zod parse. It is
    // not in insertArtifactSchema (write-only deletion hint, not a stored
    // column) so the parser would strip it. Without this, every artifact
    // metadata-field delete from the UI silently no-ops.
    const metadataToDeleteRaw: any = (req.body && typeof req.body === "object") ? req.body.metadataToDelete : undefined;
    const metadataToDelete: string[] | undefined = Array.isArray(metadataToDeleteRaw)
      ? metadataToDeleteRaw.filter((k: any) => typeof k === "string" && k.length > 0)
      : undefined;
    {
      const parsed = insertArtifactSchema.partial().safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: `Validation failed: ${JSON.stringify(parsed.error.flatten())}` });
      req.body = { ...req.body, ...parsed.data };
      if (metadataToDelete && metadataToDelete.length > 0) {
        (req.body as any).metadataToDelete = metadataToDelete;
      } else {
        delete (req.body as any).metadataToDelete;
      }
    }
    if (req.body.title !== undefined) {
      if (typeof req.body.title !== "string" || !req.body.title.trim()) return res.status(400).json({ error: "Artifact title must be a non-empty string" });
      req.body.title = sanitize(req.body.title);
    }
    if (req.body.description !== undefined && typeof req.body.description === "string") req.body.description = sanitize(req.body.description);
    const updated = await storage.updateArtifact(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    const uid_a2 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`artifacts:${uid_a2}`); bustCache(`stats:${uid_a2}`); bustCache(`enhanced:`);
    res.json(updated);
  }));
  app.post("/api/artifacts/:id/toggle/:itemId", asyncHandler(async (req, res) => {
    const result = await storage.toggleChecklistItem(req.params.id, req.params.itemId);
    if (!result) return res.status(404).json({ error: "Not found" });
    const uid_a3 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`artifacts:${uid_a3}`); bustCache(`stats:${uid_a3}`); bustCache(`enhanced:`);
    res.json(result);
  }));
  app.delete("/api/artifacts/:id", asyncHandler(async (req, res) => {
    const existing = await storage.getArtifact(req.params.id);
    if (!existing) return res.status(404).json({ error: "Artifact not found" });
    await storage.deleteArtifact(req.params.id);
    const uid_a4 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`artifacts:${uid_a4}`); bustCache(`stats:${uid_a4}`); bustCache(`enhanced:`);
    res.json({ success: true });
  }));

  // Duplicate an artifact — used by the editor's "Save as copy" affordance for
  // doc/sheet types. Server-side copy avoids round-tripping the full payload.
  app.post("/api/artifacts/:id/duplicate", asyncHandler(async (req, res) => {
    const src = await storage.getArtifact(req.params.id);
    if (!src) return res.status(404).json({ error: "Artifact not found" });
    const newTitle = (req.body?.title && typeof req.body.title === "string" && req.body.title.trim())
      ? sanitize(req.body.title.trim())
      : `${src.title} (copy)`;
    const created = await storage.createArtifact({
      type: src.type,
      title: newTitle,
      content: src.content || "",
      items: (src.items || []).map(i => ({ text: i.text, checked: i.checked })),
      tags: src.tags || [],
      pinned: false,
      linkedProfiles: src.linkedProfiles || [],
      language: src.language,
      dataBindings: src.dataBindings,
      chartData: src.chartData,
      sheetData: src.sheetData,
      source: src.source,
    } as any);
    const uid_adup = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`artifacts:${uid_adup}`); bustCache(`stats:${uid_adup}`); bustCache(`enhanced:`);
    res.status(201).json(created);
  }));

  // ---- Public share links for artifacts ----
  // POST /api/artifacts/:id/share — generate (or return existing) public share token.
  // DELETE /api/artifacts/:id/share — revoke the token.
  // GET /api/public/artifacts/:token — read-only fetch (no auth, sanitized payload).
  app.post("/api/artifacts/:id/share", asyncHandler(async (req, res) => {
    const existing = await storage.getArtifact(req.params.id);
    if (!existing) return res.status(404).json({ error: "Not found" });
    let token = existing.shareToken;
    if (!token) {
      const { randomBytes } = await import("crypto");
      // S4: 32-byte token (was 16). 64 hex chars = 2^256 keyspace, making
      // online enumeration of valid tokens computationally infeasible.
      token = randomBytes(32).toString("hex");
      if (typeof storage.setArtifactShareToken === "function") {
        await storage.setArtifactShareToken(req.params.id, token);
      } else {
        await storage.updateArtifact(req.params.id, { shareToken: token });
      }
    }
    const uid_sh = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`artifacts:${uid_sh}`);
    res.json({ token, path: `/share/${token}` });
  }));
  app.delete("/api/artifacts/:id/share", asyncHandler(async (req, res) => {
    const existing = await storage.getArtifact(req.params.id);
    if (!existing) return res.status(404).json({ error: "Not found" });
    if (typeof storage.setArtifactShareToken === "function") {
      await storage.setArtifactShareToken(req.params.id, null);
    }
    const uid_sh2 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`artifacts:${uid_sh2}`);
    res.json({ success: true });
  }));

  // Public read-only viewer endpoint — no auth, looked up by share token via service role.
  // Sanitised: drops linked_profiles and only exposes fields needed to render.
  //
  // S4 hardening:
  //   - Per-IP rate limit (10/min) so an attacker can't enumerate token space.
  //   - Generic 404 body for ALL failures (invalid format / not found /
  //     internal error) so response shape doesn't distinguish valid from
  //     invalid tokens.
  //   - Constant-ish response delay floor (~80ms) on negative responses to
  //     flatten the 200-vs-404 timing oracle.
  app.get("/api/public/artifacts/:token", asyncHandler(async (req, res) => {
    const NOT_FOUND_BODY = { error: "Not found" };
    const NOT_FOUND_DELAY_MS = 80;
    async function deny(status: number = 404) {
      // Sleep a constant floor before responding so an attacker can't
      // distinguish "invalid format" (fast) from "unknown token" (slow DB).
      await new Promise((r) => setTimeout(r, NOT_FOUND_DELAY_MS));
      return res.status(status).json(NOT_FOUND_BODY);
    }
    // Per-IP rate limit: 10 requests / minute is generous for a real viewer
    // (page loads once, then it's cached) but cuts enumeration throughput by
    // ~6 orders of magnitude vs the unlimited baseline.
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
      || req.socket.remoteAddress
      || "unknown";
    if (rateLimit(`public-artifact:${ip}`, 10, 60_000)) {
      return res.status(429).json(NOT_FOUND_BODY);
    }
    const token = String(req.params.token || "").trim();
    // Accept legacy 16-byte (32 hex) tokens AND new 32-byte (64 hex) tokens.
    // Note: legacy 32-hex tokens are 128 bits of randomness, which is still
    // computationally infeasible to enumerate — they remain safe to honor.
    // Reject anything that isn't hex of an expected length so we don't even
    // hit the DB for obvious garbage. This path goes through deny(), so it
    // gets the same constant delay as an unknown-token miss (no timing
    // oracle on format validity).
    if (!/^[a-f0-9]+$/i.test(token) || (token.length !== 32 && token.length !== 64)) {
      return deny();
    }
    const url = process.env.VITE_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return deny(500);
    const { createClient } = await import("@supabase/supabase-js");
    const admin = createClient(url, key);
    // Metadata projection: select ONLY the whitelisted metadata keys
    // (language/sheetData/chartData) instead of the whole metadata column,
    // so shareToken and any internal flags never even reach this process —
    // and can never be accidentally echoed in the response below.
    const { data, error } = await admin
      .from("artifacts")
      .select("id, type, title, content, items, created_at, updated_at, language:metadata->>language, sheetData:metadata->sheetData, chartData:metadata->chartData")
      .filter("metadata->>shareToken", "eq", token)
      .limit(1);
    if (error) return deny(500);
    const row = (data || [])[0] as Record<string, any> | undefined;
    if (!row) return deny();
    res.setHeader("Cache-Control", "public, max-age=60");
    // Whitelisted response fields ONLY — never the raw metadata object or
    // shareToken.
    res.json({
      id: row.id,
      type: row.type,
      title: row.title,
      content: row.content || "",
      items: row.items || [],
      language: row.language ?? undefined,
      sheetData: row.sheetData ?? undefined,
      chartData: row.chartData ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }));

  // ---- Journal ----
  app.get("/api/journal", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const ck = `journal:${uid}`;
    const hit = getCached(ck);
    let items: Awaited<ReturnType<typeof storage.getJournalEntries>> = hit || await dedupe(ck, () => storage.getJournalEntries());
    if (!hit) setCache(ck, items, 5 * 60 * 1000); // version-stamped key (migration 010): fresh by construction; TTL only bounds memory
    const profileIdsParam = req.query.profileIds as string | undefined;
    const fp = req.query.profileId as string | undefined;
    if (profileIdsParam) {
      const ids = profileIdsParam.split(",").filter(Boolean);
      if (ids.length > 0) {
        // Filter by linkedProfiles; entries with no linked profiles only show
        // when the selection includes a self-type profile (treat them as the user's own).
        const allProfiles = await storage.getProfiles();
        const selfIds = new Set(allProfiles.filter(p => p.type === "self").map(p => p.id));
        const includesSelf = ids.some(id => selfIds.has(id));
        items = items.filter((j: any) => {
          const lp: string[] = j.linkedProfiles || [];
          if (lp.length === 0) return includesSelf;
          return lp.some(pid => ids.includes(pid));
        });
      }
    } else if (fp) {
      const allProfiles = await storage.getProfiles();
      const isSelf = allProfiles.find(p => p.id === fp)?.type === "self";
      // Journal entries are personal — only show for self profile
      if (!isSelf) { items = []; }
    }
    res.json(paginate(items, req, res));
  }));
  app.post("/api/journal", asyncHandler(async (req, res) => {
    if (!req.body.content || typeof req.body.content !== "string" || !req.body.content.trim()) {
      return res.status(400).json({ error: "Journal content is required" });
    }
    req.body.content = sanitize(req.body.content);
    const parsed = insertJournalEntrySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation failed", issues: parsed.error.issues });
    let newEntry = await storage.createJournalEntry(parsed.data);
    // Apply linkedProfiles if provided (not part of insert schema)
    if (Array.isArray(req.body.linkedProfiles) && req.body.linkedProfiles.length > 0) {
      const updated = await storage.updateJournalEntry(newEntry.id, { linkedProfiles: req.body.linkedProfiles } as any);
      if (updated) newEntry = updated as any;
    }
    const uid_j1 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`stats:${uid_j1}`);
    res.status(201).json(newEntry);
  }));
  app.patch("/api/journal/:id", asyncHandler(async (req, res) => {
    {
      const parsed = insertJournalEntrySchema.partial().safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: `Validation failed: ${JSON.stringify(parsed.error.flatten())}` });
      req.body = { ...req.body, ...parsed.data };
    }
    if (req.body.content !== undefined) {
      if (typeof req.body.content !== "string") return res.status(400).json({ error: "Journal content must be a string" });
      req.body.content = sanitize(req.body.content);
    }
    if (req.body.mood !== undefined) {
      const validMoods = ["amazing", "great", "good", "okay", "neutral", "bad", "awful", "terrible"];
      if (!validMoods.includes(req.body.mood)) return res.status(400).json({ error: `Invalid mood. Must be one of: ${validMoods.join(", ")}` });
    }
    const updated = await storage.updateJournalEntry(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    const uid_j2 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`stats:${uid_j2}`);
    res.json(updated);
  }));
  app.delete("/api/journal/:id", asyncHandler(async (req, res) => {
    // Single-call delete — storage.deleteJournalEntry uses .select() to tell
    // us whether a row was actually removed, so we avoid the TOCTOU race that
    // existed when we used getJournalEntries() to pre-check existence.
    const removed = await storage.deleteJournalEntry(req.params.id);
    if (!removed) return res.status(404).json({ error: "Journal entry not found" });
    const uid_j3 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`stats:${uid_j3}`);
    res.json({ success: true });
  }));

  // ---- Memory ----
  app.get("/api/memories", asyncHandler(async (req, res) => {
    try {
      let items: any[] = await storage.getMemories();
      const profileId = req.query.profileId as string | undefined;
      if (profileId) {
        items = items.filter((item: any) =>
          (item.linkedProfiles || []).includes(profileId) || item.profileId === profileId
        );
      }
      res.json(items);
    }
    catch { res.status(500).json({ error: "Failed to load memories" }); }
  }));
  app.post("/api/memories", asyncHandler(async (req, res) => {
    const parsed = insertMemorySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation failed", issues: parsed.error.issues });
    try { res.status(201).json(await storage.saveMemory(parsed.data)); }
    catch (err: any) { console.error("[memories]", err?.message || err); res.status(500).json({ error: "Failed to save memory" }); }
  }));
  app.get("/api/memories/recall", asyncHandler(async (req, res) => {
    const q = (req.query.q as string) || "";
    try { res.json(await storage.recallMemory(q)); }
    catch { res.status(500).json({ error: "Recall failed" }); }
  }));
  app.patch("/api/memories/:id", asyncHandler(async (req, res) => {
    if (req.body.key !== undefined && (typeof req.body.key !== "string" || !req.body.key.trim())) {
      return res.status(400).json({ error: "Memory key must be a non-empty string" });
    }
    if (req.body.value !== undefined && req.body.value === null) {
      return res.status(400).json({ error: "Memory value cannot be null" });
    }
    try {
      const result = await storage.updateMemory(req.params.id, req.body);
      if (!result) return res.status(404).json({ error: "Memory not found" });
      res.json(result);
    } catch (e: any) { console.error("[memories]", e?.message || e); res.status(500).json({ error: "Failed to update memory" }); }
  }));
  app.delete("/api/memories/:id", asyncHandler(async (req, res) => {
    // Single-call delete — storage.deleteMemory uses .select() to detect
    // whether a row was removed, avoiding TOCTOU between getMemories() and
    // delete that could let two concurrent clients both think they succeeded.
    const removed = await storage.deleteMemory(req.params.id);
    if (!removed) return res.status(404).json({ error: "Memory not found" });
    res.json({ success: true });
  }));

  // ---- Notifications (computed on each request) ----
  app.get("/api/notifications", asyncHandler(async (req, res) => {
    try {
      const userId = cacheUserKey(req as AuthenticatedRequest);
      const notifCacheKey = `notifications:${userId}`;
      // Make profile filter part of the cache key so two different filters
      // don't share the same cached payload (was returning unfiltered list).
      const _pIdsForKey = (req.query.profileIds as string | undefined) || (req.query.profileId as string | undefined) || "";
      const fullKey = _pIdsForKey ? `${notifCacheKey}:${_pIdsForKey}` : notifCacheKey;
      const notifCached = getCached(fullKey);
      if (notifCached) return res.json(notifCached);

      interface Notification {
        id: string;
        type: "document_expiring" | "task_overdue" | "task_due_today" | "bill_due" | "habit_at_risk" | "streak_milestone";
        severity: "critical" | "warning" | "info";
        title: string;
        message: string;
        entityId?: string;
        entityType?: string;
        dueDate?: string;
        dismissed?: boolean;
      }

      const notifications: Notification[] = [];
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const notifTz = getTimezone(req);
      const todayStr = getUserToday(notifTz);

      // Helper: try to parse various date formats into a Date object
      const parseDate = (val: string): Date | null => {
        if (!val || typeof val !== "string") return null;
        const trimmed = val.trim();
        // YYYY-MM-DD
        if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
          const d = new Date(trimmed);
          return isNaN(d.getTime()) ? null : d;
        }
        // MM/DD/YYYY or M/D/YYYY
        const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (slashMatch) {
          const d = new Date(Number(slashMatch[3]), Number(slashMatch[1]) - 1, Number(slashMatch[2]));
          return isNaN(d.getTime()) ? null : d;
        }
        // MM-DD-YYYY
        const dashMatch = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
        if (dashMatch) {
          const d = new Date(Number(dashMatch[3]), Number(dashMatch[1]) - 1, Number(dashMatch[2]));
          return isNaN(d.getTime()) ? null : d;
        }
        // Try native parsing as last resort
        const d = new Date(trimmed);
        return isNaN(d.getTime()) ? null : d;
      };

      const daysDiff = (dateA: Date, dateB: Date): number => {
        const a = new Date(dateA); a.setHours(0,0,0,0);
        const b = new Date(dateB); b.setHours(0,0,0,0);
        return Math.round((a.getTime() - b.getTime()) / 86400000);
      };

      // PERF (2026-05-31): fetch every list this endpoint needs in parallel.
      // Previously each section did `await storage.getX()` sequentially, so a
      // cold notifications request paid the Supabase round-trip latency 5x
      // back-to-back. Measured at portol.me: /api/notifications cold = 9.3s.
      // Five-way Promise.all collapses the wave to a single round-trip wide.
      // Each fetch is independent so this is safe.
      const [documents, _profilesForNotif, _tasksForNotif, _obligationsForNotif, _habitsForNotif] = await Promise.all([
        storage.getDocuments(),
        storage.getProfiles(),
        storage.getTasks(),
        storage.getObligations(),
        storage.getHabits(),
      ]);

      // --- Document Expirations ---
      const expirationKeywords = ["expir", "exp date", "exp_date", "expdate", "valid until", "valid through", "valid_until", "valid_through", "expires", "expiration"];

      for (const doc of documents) {
        if (!doc.extractedData || typeof doc.extractedData !== "object") continue;
        const fields = doc.extractedData as Record<string, any>;
        for (const [key, value] of Object.entries(fields)) {
          if (!value || typeof value !== "string") continue;
          const keyLower = key.toLowerCase();
          const isExpirationField = expirationKeywords.some(kw => keyLower.includes(kw));
          if (!isExpirationField) continue;
          const expDate = parseDate(value);
          if (!expDate) continue;
          const diff = daysDiff(expDate, today);
          if (diff < 0) {
            notifications.push({
              id: `doc-exp-${doc.id}-${key}`,
              type: "document_expiring",
              severity: "critical",
              title: `Expired: ${doc.name}`,
              message: `${key} expired ${Math.abs(diff)} day${Math.abs(diff) !== 1 ? "s" : ""} ago (${value})`,
              entityId: doc.id,
              entityType: "document",
              dueDate: value,
            });
          } else if (diff <= 7) {
            notifications.push({
              id: `doc-exp-${doc.id}-${key}`,
              type: "document_expiring",
              severity: "warning",
              title: `Expiring soon: ${doc.name}`,
              message: `${key} expires in ${diff} day${diff !== 1 ? "s" : ""} (${value})`,
              entityId: doc.id,
              entityType: "document",
              dueDate: value,
            });
          } else if (diff <= 30) {
            notifications.push({
              id: `doc-exp-${doc.id}-${key}`,
              type: "document_expiring",
              severity: "info",
              title: `Expiring: ${doc.name}`,
              message: `${key} expires in ${diff} days (${value})`,
              entityId: doc.id,
              entityType: "document",
              dueDate: value,
            });
          }
        }
      }

      // --- Also scan profile fields for expiration dates ---
      const profiles = _profilesForNotif;
      for (const profile of profiles) {
        if (!profile.fields || typeof profile.fields !== "object") continue;
        for (const [key, value] of Object.entries(profile.fields as Record<string, any>)) {
          if (!value || typeof value !== "string") continue;
          const keyLower = key.toLowerCase();
          const isExpirationField = expirationKeywords.some(kw => keyLower.includes(kw));
          if (!isExpirationField) continue;
          const expDate = parseDate(value);
          if (!expDate) continue;
          const diff = daysDiff(expDate, today);
          if (diff < 0) {
            notifications.push({
              id: `profile-exp-${profile.id}-${key}`,
              type: "document_expiring",
              severity: "critical",
              title: `Expired: ${profile.name} - ${key}`,
              message: `Expired ${Math.abs(diff)} day${Math.abs(diff) !== 1 ? "s" : ""} ago (${value})`,
              entityId: profile.id,
              entityType: "profile",
              dueDate: value,
            });
          } else if (diff <= 7) {
            notifications.push({
              id: `profile-exp-${profile.id}-${key}`,
              type: "document_expiring",
              severity: "warning",
              title: `Expiring soon: ${profile.name} - ${key}`,
              message: `Expires in ${diff} day${diff !== 1 ? "s" : ""} (${value})`,
              entityId: profile.id,
              entityType: "profile",
              dueDate: value,
            });
          } else if (diff <= 30) {
            notifications.push({
              id: `profile-exp-${profile.id}-${key}`,
              type: "document_expiring",
              severity: "info",
              title: `Expiring: ${profile.name} - ${key}`,
              message: `Expires in ${diff} days (${value})`,
              entityId: profile.id,
              entityType: "profile",
              dueDate: value,
            });
          }
        }
      }

      // --- Task Due Dates ---
      const tasks = _tasksForNotif;
      for (const task of tasks) {
        if (task.status === "done" || !task.dueDate) continue;
        const due = parseDate(task.dueDate);
        if (!due) continue;
        const diff = daysDiff(due, today);
        if (diff < 0) {
          notifications.push({
            id: `task-overdue-${task.id}`,
            type: "task_overdue",
            severity: "critical",
            title: `Overdue: ${task.title}`,
            message: `Was due ${Math.abs(diff)} day${Math.abs(diff) !== 1 ? "s" : ""} ago`,
            entityId: task.id,
            entityType: "task",
            dueDate: task.dueDate,
          });
        } else if (diff === 0) {
          notifications.push({
            id: `task-today-${task.id}`,
            type: "task_due_today",
            severity: "warning",
            title: `${task.title} is due today`,
            message: `Priority: ${task.priority}`,
            entityId: task.id,
            entityType: "task",
            dueDate: task.dueDate,
          });
        } else if (diff <= 3) {
          notifications.push({
            id: `task-soon-${task.id}`,
            type: "task_due_today",
            severity: "info",
            title: `${task.title} due in ${diff} day${diff !== 1 ? "s" : ""}`,
            message: `Priority: ${task.priority}`,
            entityId: task.id,
            entityType: "task",
            dueDate: task.dueDate,
          });
        }
      }

      // --- Bills/Obligations ---
      const obligations = _obligationsForNotif;
      for (const ob of obligations) {
        if (!ob.nextDueDate) continue;
        const due = parseDate(ob.nextDueDate);
        if (!due) continue;
        const diff = daysDiff(due, today);
        if (diff < 0) {
          notifications.push({
            id: `bill-overdue-${ob.id}`,
            type: "bill_due",
            severity: "critical",
            title: `Overdue bill: ${ob.name}`,
            message: `$${ob.amount.toFixed(2)} was due ${Math.abs(diff)} day${Math.abs(diff) !== 1 ? "s" : ""} ago`,
            entityId: ob.id,
            entityType: "obligation",
            dueDate: ob.nextDueDate,
          });
        } else if (diff <= 3) {
          notifications.push({
            id: `bill-soon-${ob.id}`,
            type: "bill_due",
            severity: "warning",
            title: `Bill due soon: ${ob.name}`,
            message: `$${ob.amount.toFixed(2)} due in ${diff} day${diff !== 1 ? "s" : ""}${diff === 0 ? " (today)" : ""}`,
            entityId: ob.id,
            entityType: "obligation",
            dueDate: ob.nextDueDate,
          });
        } else if (diff <= 7 && !ob.autopay) {
          notifications.push({
            id: `bill-upcoming-${ob.id}`,
            type: "bill_due",
            severity: "info",
            title: `Upcoming bill: ${ob.name}`,
            message: `$${ob.amount.toFixed(2)} due in ${diff} days (no autopay)`,
            entityId: ob.id,
            entityType: "obligation",
            dueDate: ob.nextDueDate,
          });
        }
      }

      // --- Habit Streak Risk & Milestones ---
      const habits = _habitsForNotif;
      const streakMilestones = [7, 14, 30, 60, 90, 100, 365];
      for (const habit of habits) {
        // Streak risk: hasn't checked in today and has streak >= 3
        const checkedInToday = habit.checkins?.some(c => c.date === todayStr);
        if (!checkedInToday && habit.currentStreak >= 3) {
          notifications.push({
            id: `habit-risk-${habit.id}`,
            type: "habit_at_risk",
            severity: "warning",
            title: `Don't break your ${habit.name} streak!`,
            message: `${habit.currentStreak} day${habit.currentStreak !== 1 ? "s" : ""} and counting — check in today`,
            entityId: habit.id,
            entityType: "habit",
          });
        }
        // Streak milestones
        if (streakMilestones.includes(habit.currentStreak)) {
          notifications.push({
            id: `habit-milestone-${habit.id}-${habit.currentStreak}`,
            type: "streak_milestone",
            severity: "info",
            title: `Milestone! ${habit.currentStreak}-day ${habit.name} streak \u{1F389}`,
            message: `You've kept your ${habit.name} habit for ${habit.currentStreak} days straight!`,
            entityId: habit.id,
            entityType: "habit",
          });
        }
      }

      // Deduplicate: keep only the most severe notification per entityId
      const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };
      const seenEntities = new Map<string, number>();
      const deduped: Notification[] = [];
      for (const notif of notifications) {
        const dedupeKey = notif.entityId && notif.entityType
          ? `${notif.entityType}:${notif.entityId}`
          : notif.id;
        const existing = seenEntities.get(dedupeKey);
        if (existing !== undefined) {
          // Keep the more severe one (lower order = more severe)
          if (severityOrder[notif.severity] < severityOrder[deduped[existing].severity]) {
            deduped[existing] = notif;
          }
        } else {
          seenEntities.set(dedupeKey, deduped.length);
          deduped.push(notif);
        }
      }

      // Sort: critical first, then warning, then info
      deduped.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

      // Profile filter — trim to notifications whose source entity is linked
      // to the selected profile(s). Note: this is NOT cached so the same user
      // can switch profiles and see immediate results.
      const profileIdsParam = req.query.profileIds as string | undefined;
      const fp = req.query.profileId as string | undefined;
      const ids = profileIdsParam
        ? profileIdsParam.split(",").filter(Boolean)
        : (fp ? [fp] : []);
      if (ids.length > 0) {
        const [allDocs, allTasks, allObs, allHabits] = await Promise.all([
          storage.getDocuments(), storage.getTasks(), storage.getObligations(), storage.getHabits(),
        ]);
        const matchesProfile = (entityType: string | undefined, entityId: string | undefined): boolean => {
          if (!entityType || !entityId) return false;
          if (entityType === "profile") return ids.includes(entityId);
          const collection: any[] =
            entityType === "document" ? allDocs :
            entityType === "task" ? allTasks :
            entityType === "obligation" ? allObs :
            entityType === "habit" ? allHabits : [];
          const ent = collection.find((x: any) => x.id === entityId);
          if (!ent) return false;
          const lp: string[] = ent.linkedProfiles || [];
          return lp.some((pid: string) => ids.includes(pid));
        };
        const filtered = deduped.filter(n => matchesProfile(n.entityType, n.entityId));
        setCache(fullKey, filtered, 2 * 60 * 1000);
        return res.json(filtered);
      }

      setCache(fullKey, deduped, 2 * 60 * 1000); // 2-minute cache
      res.json(deduped);
    } catch (err: any) {
      log.error("[Notifications]", err?.message || "unknown error");
      res.status(500).json({ error: "Failed to compute notifications" });
    }
  }));

  // ---- Search ----
  app.get("/api/search", asyncHandler(async (req, res) => {
    const q = (req.query.q as string) || "";
    try {
      let results = await storage.search(q);
      // Honor the active profile filter so global search reflects what the
      // user is currently focused on. Profiles themselves are filtered by id;
      // other entities are filtered by linkedProfiles.
      const profileIdsParam = req.query.profileIds as string | undefined;
      const fp = req.query.profileId as string | undefined;
      const ids = profileIdsParam
        ? profileIdsParam.split(",").filter(Boolean)
        : (fp ? [fp] : []);
      if (ids.length > 0) {
        // Co-ownership drives visibility: an asset/liability the selected party
        // owns ANY share of (even 1%) must appear in search, not just items
        // whose linkedProfiles names them. Build the owner index once.
        const [assetLinks, liabLinks, allProfiles] = await Promise.all([
          storage.getAssetPartyLinks().catch(() => [] as any[]),
          storage.getLiabilityProfileLinks().catch(() => [] as any[]),
          storage.getProfiles().catch(() => [] as any[]),
        ]);
        const records: OwnershipRecord[] = [
          ...((assetLinks as any[]) || []).map((l) => ({ itemId: l.assetProfileId, partyId: l.partyProfileId, ownershipPercentage: Number(l.ownershipPercentage ?? 0), role: l.role })),
          ...((liabLinks as any[]) || []).map((l) => ({ itemId: l.liabilityProfileId, partyId: l.partyProfileId, ownershipPercentage: Number(l.ownershipPercentage ?? 0), role: l.role })),
        ];
        const ownerIndex = buildOwnerIndex(records);
        const selfIds = selfIdsFrom(allProfiles as any[]);
        const isAssetOrLiability = (type?: string) => !!type && (ASSET_PROFILE_TYPES.has(type) || LIABILITY_PROFILE_TYPES.has(type));
        results = results.filter((r: any) => {
          if (r._type === "profile") {
            if (ids.includes(r.id)) return true;
            // Asset/liability profiles surface for any selected co-owner (or for
            // Self when unowned). Other profile types match by id only.
            if (isAssetOrLiability(r.type)) return itemVisibleForSelection(r.id, ids, ownerIndex, selfIds);
            return false;
          }
          const lp: string[] = r.linkedProfiles || [];
          return lp.some((pid: string) => ids.includes(pid));
        });
      }
      res.json(results);
    } catch (err: any) {
      res.status(500).json({ error: "Search failed" });
    }
  }));

  // ---- Data Cleanup ----
  // S1: admin-only — destructive / global-state mutations. To grant access,
  // set ADMIN_EMAILS=foo@bar.com,baz@qux.com in the env.
  // Migrate base64 documents from DB to Supabase Storage
  app.post("/api/cleanup/migrate-documents-to-storage", requireAdmin, asyncHandler(async (req, res) => {
    const cleanupUid = (req as AuthenticatedRequest).userId || req.ip || 'anonymous';
    if (rateLimit(`cleanup:${cleanupUid}`, 2, 3600000)) {
      return res.status(429).json({ error: "Migration already in progress or rate limited." });
    }
    if (req.body?.confirm !== "MIGRATE") {
      return res.status(400).json({ error: "Migration requires confirmation parameter" });
    }
    const result = await storage.migrateDocumentsToStorage();
    res.json(result);
  }));

  app.post("/api/cleanup/tracker-entries", requireAdmin, asyncHandler(async (req, res) => {
    const cleanupTUid = (req as AuthenticatedRequest).userId || req.ip || 'anonymous';
    if (rateLimit(`cleanup-tracker:${cleanupTUid}`, 5, 3600000)) {
      return res.status(429).json({ error: "Cleanup rate limited. Try again later." });
    }
    const trackers = await storage.getTrackers();
    let cleaned = 0;
    const details: string[] = [];

    for (const tracker of trackers) {
      const name = tracker.name.toLowerCase();
      for (const entry of tracker.entries) {
        let isGarbage = false;
        const vals = entry.values;

        // Negative values in health trackers
        if (Object.values(vals).some((v: any) => typeof v === 'number' && v < 0)) {
          isGarbage = true;
        }
        // Weight over 1000 lbs or under 10 lbs (for humans)
        if (name.includes('weight') && !name.includes('max') && !name.includes('rex')) {
          const w = vals.weight ?? vals.value;
          if (typeof w === 'number' && (w > 1000 || w < 10)) isGarbage = true;
        }
        // Calories over 20000
        if ((name.includes('calori') || name.includes('nutrition')) && vals.calories && typeof vals.calories === 'number' && vals.calories > 20000) {
          isGarbage = true;
        }
        // Sleep over 24 hours
        if (name.includes('sleep') && vals.hours && typeof vals.hours === 'number' && (vals.hours > 24 || vals.hours < 0)) {
          isGarbage = true;
        }
        // Blood pressure: systolic over 300 or diastolic over 200
        if (name.includes('blood pressure') || name.includes('bp')) {
          const sys = vals.systolic ?? vals.sbp;
          const dia = vals.diastolic ?? vals.dbp;
          if ((typeof sys === 'number' && sys > 300) || (typeof dia === 'number' && dia > 200)) isGarbage = true;
          // Partial: only one value present
          if ((sys == null && dia != null) || (sys != null && dia == null)) isGarbage = true;
        }
        // All values empty
        const hasValue = Object.entries(vals).some(([k, v]) => k !== '_notes' && k !== 'notes' && v != null && v !== '');
        if (!hasValue) isGarbage = true;

        if (isGarbage) {
          try {
            await storage.deleteTrackerEntry(tracker.id, entry.id);
            cleaned++;
            details.push(`${tracker.name}: removed entry ${entry.id.slice(0, 8)} (${JSON.stringify(vals).slice(0, 80)})`);
          } catch { /* skip if can't delete */ }
        }
      }
    }

    bustAllCaches();
    res.json({ cleaned, details: details.slice(0, 50) });
  }));

  // ---- Export / Import ----
  app.get("/api/export", asyncHandler(async (req, res) => {
    try {
      // PERF FIX: was 12 sequential awaits — each one a Supabase round trip
      // serialized after the previous. On a typical user this means ~1.5s of
      // pure latency stacked up. Resolve all in parallel so the export
      // completes in O(1) round-trip time instead of O(n).
      let [
        profiles, trackers, tasks, expenses, events, documents,
        habits, obligations, artifacts, journalEntries, memories, domains,
      ] = await Promise.all([
        storage.getProfiles(),
        storage.getTrackers(),
        storage.getTasks(),
        storage.getExpenses(),
        storage.getEvents(),
        storage.getDocuments(),
        storage.getHabits(),
        storage.getObligations(),
        storage.getArtifacts(),
        storage.getJournalEntries(),
        storage.getMemories(),
        storage.getDomains(),
      ]);
      // [P6.2] Optional ?profileIds= scoping. Each entity collection goes
      // through the same canonical orphan rule as the list endpoints.
      // Profiles, memories and domains are reference data with no
      // linkedProfiles — always exported in full.
      const profileIdsParam = req.query.profileIds as string | undefined;
      const exportFilterIds = profileIdsParam ? profileIdsParam.split(",").filter(Boolean) : [];
      if (exportFilterIds.length > 0) {
        const uid_ex = cacheUserKey(req as AuthenticatedRequest);
        [trackers, tasks, expenses, events, documents, habits, obligations, artifacts, journalEntries] =
          await Promise.all([
            filterByProfileScope(trackers, exportFilterIds, uid_ex),
            filterByProfileScope(tasks, exportFilterIds, uid_ex),
            filterByProfileScope(expenses, exportFilterIds, uid_ex),
            filterByProfileScope(events, exportFilterIds, uid_ex),
            filterByProfileScope(documents, exportFilterIds, uid_ex),
            filterByProfileScope(habits, exportFilterIds, uid_ex),
            filterByProfileScope(obligations, exportFilterIds, uid_ex),
            filterByProfileScope(artifacts, exportFilterIds, uid_ex),
            filterByProfileScope(journalEntries, exportFilterIds, uid_ex),
          ]);
      }
      const data = {
        version: 1,
        exportedAt: new Date().toISOString(),
        scope: exportFilterIds.length > 0 ? "filtered" : "all",
        ...(exportFilterIds.length > 0 ? { filteredProfileIds: exportFilterIds } : {}),
        profiles, trackers, tasks, expenses, events, documents,
        habits, obligations, artifacts, journalEntries, memories, domains,
      };
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="portol-backup-${getUserToday(getTimezone(req))}.json"`);
      res.json(data);
    } catch (err: any) {
      log.error("[Export]", err?.message || "unknown error");
      res.status(500).json({ error: "Export failed" });
    }
  }));

  app.post("/api/import", asyncHandler(async (req, res) => {
    try {
      const importUid = (req as AuthenticatedRequest).userId || req.ip || 'anonymous';
      if (rateLimit(`import:${importUid}`, 3, 3600000)) {
        return res.status(429).json({ error: "Import rate limited. Try again in an hour." });
      }
      const data = req.body;
      if (!data || !data.version) {
        return res.status(400).json({ error: "Invalid import file — missing version field" });
      }
      const imported: Record<string, number> = {};
      const failed: Record<string, string[]> = {};

      // Helper: try to import an item, track success/failure
      async function tryImport(category: string, name: string, fn: () => Promise<any>) {
        try {
          await fn();
          imported[category] = (imported[category] || 0) + 1;
        } catch (err: any) {
          if (!failed[category]) failed[category] = [];
          failed[category].push(`${name}: ${err?.message || "unknown error"}`);
        }
      }

      // Import profiles
      if (data.profiles && Array.isArray(data.profiles)) {
        for (const p of data.profiles) {
          await tryImport("profiles", p.name || "unnamed", () => storage.createProfile({ type: p.type, name: p.name, fields: p.fields, tags: p.tags, notes: p.notes }));
        }
      }
      // Import trackers + entries
      if (data.trackers && Array.isArray(data.trackers)) {
        for (const t of data.trackers) {
          await tryImport("trackers", t.name || "unnamed", async () => {
            const created = await storage.createTracker({ name: t.name, category: t.category, unit: t.unit, icon: t.icon, fields: t.fields });
            if (t.entries) {
              for (const e of t.entries) {
                await tryImport("trackerEntries", `${t.name} entry`, () => storage.logEntry({ trackerId: created.id, values: e.values, notes: e.notes, mood: e.mood, tags: e.tags }));
              }
            }
          });
        }
      }
      // Import tasks
      if (data.tasks && Array.isArray(data.tasks)) {
        for (const t of data.tasks) {
          await tryImport("tasks", t.title || "unnamed", () => storage.createTask({ title: t.title, description: t.description, priority: t.priority, dueDate: t.dueDate, tags: t.tags }));
        }
      }
      // Import expenses
      if (data.expenses && Array.isArray(data.expenses)) {
        for (const e of data.expenses) {
          await tryImport("expenses", e.description || "unnamed", () => storage.createExpense({ amount: e.amount, category: e.category, description: e.description, vendor: e.vendor, date: e.date, tags: e.tags }));
        }
      }
      // Import events
      if (data.events && Array.isArray(data.events)) {
        for (const e of data.events) {
          await tryImport("events", e.title || "unnamed", () => storage.createEvent({ title: e.title, date: e.date, time: e.time, endTime: e.endTime, allDay: e.allDay, description: e.description, location: e.location, category: e.category || "personal", recurrence: e.recurrence || "none", tags: e.tags || [], source: e.source || "manual", linkedProfiles: e.linkedProfiles || [], linkedDocuments: e.linkedDocuments || [] }));
        }
      }
      // Import documents
      if (data.documents && Array.isArray(data.documents)) {
        for (const d of data.documents) {
          await tryImport("documents", d.name || "unnamed", () => storage.createDocument({ name: d.name, type: d.type, mimeType: d.mimeType, fileData: d.fileData, extractedData: d.extractedData, tags: d.tags }));
        }
      }
      // Import habits
      if (data.habits && Array.isArray(data.habits)) {
        for (const h of data.habits) {
          await tryImport("habits", h.name || "unnamed", async () => {
            const created = await storage.createHabit({ name: h.name, icon: h.icon, color: h.color, frequency: h.frequency });
            if (h.checkins) {
              for (const c of h.checkins) {
                await tryImport("habitCheckins", `${h.name} checkin`, () => storage.checkinHabit(created.id, c.date, c.value, c.notes));
              }
            }
          });
        }
      }
      // Import obligations
      if (data.obligations && Array.isArray(data.obligations)) {
        for (const o of data.obligations) {
          await tryImport("obligations", o.name || "unnamed", async () => {
            const created = await storage.createObligation({ name: o.name, amount: o.amount, frequency: o.frequency, category: o.category, nextDueDate: o.nextDueDate, autopay: o.autopay, notes: o.notes });
            if (o.payments) {
              for (const p of o.payments) {
                await tryImport("obligationPayments", `${o.name} payment`, () => storage.payObligation(created.id, p.amount, p.method, p.confirmationNumber));
              }
            }
          });
        }
      }
      // Import artifacts
      if (data.artifacts && Array.isArray(data.artifacts)) {
        for (const a of data.artifacts) {
          await tryImport("artifacts", a.title || "unnamed", () => storage.createArtifact({ type: a.type, title: a.title, content: a.content, items: a.items?.map((i: any) => ({ text: i.text, checked: i.checked })) || [], tags: a.tags, pinned: a.pinned, linkedProfiles: a.linkedProfiles || [], language: a.language, dataBindings: a.dataBindings, chartData: a.chartData }));
        }
      }
      // Import journal entries
      if (data.journalEntries && Array.isArray(data.journalEntries)) {
        for (const j of data.journalEntries) {
          await tryImport("journalEntries", j.date || "unnamed", () => storage.createJournalEntry({ date: j.date, mood: j.mood, content: j.content, tags: j.tags, energy: j.energy, gratitude: j.gratitude, highlights: j.highlights }));
        }
      }
      // Import memories
      if (data.memories && Array.isArray(data.memories)) {
        for (const m of data.memories) {
          await tryImport("memories", m.key || "unnamed", () => storage.saveMemory({ key: m.key, value: m.value, category: m.category }));
        }
      }

      const totalFailed = Object.values(failed).reduce((s, arr) => s + arr.length, 0);
      res.json({ success: totalFailed === 0, imported, failed: totalFailed > 0 ? failed : undefined, totalFailed });
    } catch (err: any) {
      log.error("[Import]", err?.message || "unknown error");
      res.status(500).json({ error: "Import failed" });
    }
  }));

  // ---- CSV Bank Import ----
  app.post("/api/import/bank-csv", asyncHandler(async (req, res) => {
    try {
      // Accept JSON { csv: "..." } or raw text/csv body
      let csv: string;
      if (typeof req.body === "string") {
        csv = req.body;
      } else if (req.body?.csv && typeof req.body.csv === "string") {
        csv = req.body.csv;
      } else if (req.rawBody && Buffer.isBuffer(req.rawBody)) {
        csv = (req.rawBody as Buffer).toString("utf-8");
      } else {
        return res.status(400).json({ error: "CSV data required — send as JSON { csv: '...' } or raw text/csv body" });
      }

      // Parse CSV lines
      const lines = csv.split("\n").map(l => l.trim()).filter(Boolean);
      if (lines.length < 2) {
        return res.status(400).json({ error: "CSV must have a header row and at least one data row" });
      }

      // Parse header — auto-detect column mapping
      const header = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/['"]/g, ""));
      const colMap: Record<string, number> = {};
      for (let i = 0; i < header.length; i++) {
        const h = header[i];
        if (!colMap.date && /date|posted|trans/.test(h)) colMap.date = i;
        if (!colMap.amount && /amount|debit|credit|sum|total/.test(h)) colMap.amount = i;
        if (!colMap.description && /desc|memo|narr|detail|merchant|payee|name/.test(h)) colMap.description = i;
        if (!colMap.category && /cat|type|class/.test(h)) colMap.category = i;
      }

      if (colMap.amount === undefined) {
        return res.status(400).json({ error: "Could not detect an amount column in the CSV header" });
      }

      // Canonical category set MUST match the POST /api/expenses allowlist.
      const ALLOWED_CATEGORIES = ["food", "transport", "health", "entertainment", "pet", "vehicle", "housing", "utilities", "general", "education", "shopping", "insurance", "travel", "subscription", "utility", "other"];

      // Deterministic fallback (used if AI is unavailable / times out).
      const CATEGORY_KEYWORDS: Record<string, string[]> = {
        "food": ["grocery", "restaurant", "uber eats", "doordash", "grubhub", "mcdonald", "starbucks", "coffee", "cafe", "pizza", "chipotle", "subway", "diner", "bakery", "food", "whole foods", "trader joe"],
        "transport": ["uber", "lyft", "gas", "fuel", "parking", "toll", "transit", "metro", "bus", "train"],
        "travel": ["airline", "flight", "hotel", "airbnb", "booking.com", "expedia"],
        "shopping": ["amazon", "walmart", "target", "costco", "best buy", "ebay", "shop", "store", "mall", "retail"],
        "entertainment": ["netflix", "spotify", "hulu", "disney", "movie", "theater", "concert", "game", "steam"],
        "health": ["pharmacy", "cvs", "walgreens", "doctor", "hospital", "medical", "dental", "gym", "fitness"],
        "utilities": ["electric", "water", "internet", "phone", "mobile", "comcast", "verizon", "att", "xfinity"],
        "housing": ["rent", "mortgage", "hoa"],
        "insurance": ["insurance", "geico", "progressive", "allstate", "state farm"],
        "subscription": ["subscription", "membership", "annual fee", "monthly fee"],
        "vehicle": ["auto", "mechanic", "oil change", "tire", "car wash", "dmv"],
        "pet": ["petco", "petsmart", "vet", "chewy"],
        "education": ["tuition", "udemy", "coursera", "school", "university", "books"],
      };

      const keywordCategory = (desc: string): string => {
        const lower = desc.toLowerCase();
        for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
          if (keywords.some(k => lower.includes(k))) return cat;
        }
        return "other";
      };

      // Parse a CSV row respecting quoted fields
      const parseRow = (line: string): string[] => {
        const fields: string[] = [];
        let current = "";
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (ch === '"') { inQuotes = !inQuotes; continue; }
          if (ch === "," && !inQuotes) { fields.push(current.trim()); current = ""; continue; }
          current += ch;
        }
        fields.push(current.trim());
        return fields;
      };

      let imported = 0;
      let skipped = 0;
      const errors: string[] = [];

      // ── AI BATCH CATEGORIZATION ──────────────────────────────────────────
      // Wave 1 #1: replace per-row keyword matching with a single AI call that
      // categorises ALL rows at once. Falls back to keywordCategory on timeout
      // / error so imports never block. Cheap: ~$0.001 per 50-row CSV.
      const aiCategoryByDesc = new Map<string, string>();
      try {
        const uniqueDescs: string[] = [];
        const seen = new Set<string>();
        for (let i = 1; i < lines.length; i++) {
          const fields = parseRow(lines[i]);
          const d = (fields[colMap.description ?? colMap.amount] || `Row ${i}`).trim().slice(0, 120);
          if (!seen.has(d)) { seen.add(d); uniqueDescs.push(d); }
          if (uniqueDescs.length >= 200) break; // cap so prompt stays cheap
        }
        if (uniqueDescs.length > 0) {
          const decision = await aiDecide<Record<string, string>>({
            task: "bank-csv-categorize",
            system: `You categorize bank transactions. Pick the BEST category for each description from this exact set: ${ALLOWED_CATEGORIES.join(", ")}.
Return ONLY a JSON object mapping each input description (string) to one category (string). No prose, no markdown.
Example: {"WHOLE FOODS 12345":"food","SHELL OIL 9876":"transport"}
If unsure, use "other". Use "subscription" for recurring services; "vehicle" for car maintenance; "transport" for fuel/rideshare.`,
            user: `Categorize these ${uniqueDescs.length} descriptions:\n${JSON.stringify(uniqueDescs)}`,
            timeoutMs: 8000,
            maxTokens: Math.min(2000, 40 + uniqueDescs.length * 25),
            maxPromptChars: 24000,
            fallback: () => {
              const out: Record<string, string> = {};
              for (const d of uniqueDescs) out[d] = keywordCategory(d);
              return out;
            },
            validate: (p: any) => p && typeof p === "object" && !Array.isArray(p),
          });
          for (const [k, v] of Object.entries(decision.value)) {
            const cat = (typeof v === "string" && ALLOWED_CATEGORIES.includes(v)) ? v : "other";
            aiCategoryByDesc.set(k, cat);
          }
          console.log(`[bank-csv-import] AI categorised ${aiCategoryByDesc.size}/${uniqueDescs.length} descs via ${decision.source} in ${decision.durationMs}ms`);
        }
      } catch (e: any) {
        console.error(`[bank-csv-import] AI batch categorise failed, using keyword fallback for all rows: ${e?.message || e}`);
      }

      for (let i = 1; i < lines.length; i++) {
        try {
          const fields = parseRow(lines[i]);
          const rawAmount = fields[colMap.amount] || "";
          const parsedAmount = parseFloat(rawAmount.replace(/[$,\s]/g, ""));
          // Preserve sign: negative = refund/credit, positive = expense
          const amount = parsedAmount;
          const isRefund = parsedAmount < 0;
          if (isNaN(amount) || amount === 0) { skipped++; continue; }

          const description = fields[colMap.description ?? colMap.amount] || `Row ${i}`;
          const date = colMap.date !== undefined ? fields[colMap.date] : getUserToday(getTimezone(req));
          const csvCategory = colMap.category !== undefined ? fields[colMap.category] : undefined;
          // Priority: explicit CSV column → AI batch decision → keyword fallback.
          const aiCat = aiCategoryByDesc.get(description.trim().slice(0, 120));
          let category = csvCategory || aiCat || keywordCategory(description);
          if (!ALLOWED_CATEGORIES.includes(category)) category = "other";

          // Normalize date to YYYY-MM-DD if possible
          let normalizedDate = date;
          const parsed = new Date(date);
          if (!isNaN(parsed.getTime())) {
            normalizedDate = parsed.toLocaleDateString('en-CA');
          }

          await storage.createExpense({
            amount,
            category,
            description: description.slice(0, 200),
            vendor: description.split(/\s{2,}|[-–]/).shift()?.trim().slice(0, 100) || undefined,
            date: normalizedDate,
            tags: ["bank-import"],
          });
          imported++;
        } catch (err: any) {
          errors.push(`Row ${i}: ${err.message || "unknown error"}`);
        }
      }

      res.json({ success: true, imported, skipped, errors: errors.slice(0, 10), totalRows: lines.length - 1 });
    } catch (err: any) {
      console.error("Bank CSV import error:", err);
      res.status(500).json({ error: "CSV import failed" });
    }
  }));

  // ---- Budgets (duplicate GET removed — canonical handler is above near line 1363) ----
  // Note: the legacy preferences-based PUT /api/budgets was removed (no client
  // callers). Canonical budget CRUD lives above (GET/POST/PATCH/DELETE /api/budgets).

  // ---- AI Digest ----
  app.get("/api/ai-digest", asyncHandler(async (req, res) => {
    try {
      const force = req.query.force === "true";

      // Check cache first (stored in preferences as ai_digest)
      if (!force) {
        const cached = await storage.getPreference("ai_digest");
        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            if (parsed.generatedAt) {
              const age = Date.now() - new Date(parsed.generatedAt).getTime();
              if (age < 3600000) { // 1 hour TTL
                return res.json(parsed);
              }
            }
          } catch (err) { console.error("[routes:ai-digest] cache parse failed:", err); }
        }
      }

      // Gather ALL data
      const [profiles, trackers, tasks, expenses, habits, obligations, journal, documents, memories] = await Promise.all([
        storage.getProfiles(),
        storage.getTrackers(),
        storage.getTasks(),
        storage.getExpenses(),
        storage.getHabits(),
        storage.getObligations(),
        storage.getJournalEntries(),
        storage.getDocuments(),
        storage.getMemories(),
      ]);

      // Build compact data snapshot
      const now = new Date();
      const snapTz = getTimezone(req);
      const weekAgo = new Date(now.getTime() - 7 * 86400000);
      const monthAgo = new Date(now.getTime() - 30 * 86400000);
      const todayStr = getUserToday(snapTz);
      const weekAgoStr = toLocalDateStr(weekAgo, snapTz);
      const monthAgoStr = toLocalDateStr(monthAgo, snapTz);

      // Tracker entries (last 30 per tracker)
      const trackerSnapshot = trackers.map(t => ({
        name: t.name,
        category: t.category,
        unit: t.unit,
        entries: (t.entries || []).slice(-30).map(e => ({
          date: e.timestamp.slice(0, 10),
          values: e.values,
          mood: e.mood,
        })),
      }));

      // Tasks this week
      const tasksThisWeek = tasks.filter(t => {
        const created = new Date(t.createdAt);
        return created >= weekAgo;
      });
      const tasksCompleted = tasks.filter(t => t.status === "done");

      // Expenses this week & month
      const expensesThisWeek = expenses.filter(e => e.date >= weekAgoStr);
      const expensesThisMonth = expenses.filter(e => e.date >= monthAgoStr);
      const weekExpenseTotal = expensesThisWeek.reduce((s, e) => s + e.amount, 0);
      const monthExpenseTotal = expensesThisMonth.reduce((s, e) => s + e.amount, 0);
      const categoryTotals: Record<string, number> = {};
      for (const e of expensesThisWeek) {
        categoryTotals[e.category] = (categoryTotals[e.category] || 0) + e.amount;
      }
      const topExpenseCategory = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1])[0]?.[0] || "none";

      // Habits this week
      const habitSnapshot = habits.map(h => ({
        name: h.name,
        currentStreak: h.currentStreak,
        longestStreak: h.longestStreak,
        checkinsThisWeek: (h.checkins || []).filter(c => c.date >= weekAgoStr).length,
        totalCheckins: (h.checkins || []).length,
      }));
      const habitsCheckedIn = habitSnapshot.reduce((s, h) => s + h.checkinsThisWeek, 0);
      const totalHabitDays = habits.length * 7;

      // Journal this week
      const journalThisWeek = journal.filter(j => j.date >= weekAgoStr);
      const moods = journalThisWeek.map(j => j.mood).filter(Boolean);
      const moodMap: Record<string, number> = { amazing: 5, good: 4, neutral: 3, bad: 2, awful: 1 };
      const avgMoodVal = moods.length > 0 ? moods.reduce((s, m) => s + (moodMap[m!] || 3), 0) / moods.length : 0;
      const avgMoodLabel = avgMoodVal >= 4.5 ? "amazing" : avgMoodVal >= 3.5 ? "good" : avgMoodVal >= 2.5 ? "neutral" : avgMoodVal >= 1.5 ? "bad" : avgMoodVal > 0 ? "awful" : "none";

      // Upcoming obligations
      const upcomingObligations = obligations.filter(o => {
        if (!o.nextDueDate) return false;
        return o.nextDueDate >= todayStr && o.nextDueDate <= toLocalDateStr(new Date(now.getTime() + 14 * 86400000), snapTz);
      }).map(o => ({ name: o.name, amount: o.amount, dueDate: o.nextDueDate, autopay: o.autopay }));

      // Document expiration warnings
      const expiringDocs = documents.filter(d => {
        if (!d.extractedData || typeof d.extractedData !== "object") return false;
        const fields = d.extractedData as Record<string, any>;
        for (const [key, value] of Object.entries(fields)) {
          if (typeof value !== "string") continue;
          if (/expir|valid.until|valid.through/i.test(key)) {
            try {
              const exp = new Date(value);
              const diff = (exp.getTime() - now.getTime()) / 86400000;
              if (diff >= -30 && diff <= 60) return true;
            } catch (err) { console.error("[routes:ai-digest] document expiration parse failed:", err); }
          }
        }
        return false;
      }).map(d => ({ name: d.name, type: d.type }));

      // Tracker entries count this week
      const trackerEntriesThisWeek = trackers.reduce((sum, t) =>
        sum + (t.entries || []).filter(e => e.timestamp.slice(0, 10) >= weekAgoStr).length, 0);

      // Build the prompt data
      const dataSnapshot = {
        trackers: trackerSnapshot,
        tasks: {
          createdThisWeek: tasksThisWeek.length,
          completedThisWeek: tasksCompleted.length,
          totalPending: tasks.filter(t => t.status !== "done").length,
          overdue: tasks.filter(t => t.status !== "done" && t.dueDate && t.dueDate < todayStr).length,
        },
        expenses: {
          weekTotal: weekExpenseTotal,
          monthTotal: monthExpenseTotal,
          weekByCategory: categoryTotals,
          topCategory: topExpenseCategory,
        },
        habits: habitSnapshot,
        journal: journalThisWeek.map(j => ({ date: j.date, mood: j.mood, highlights: j.highlights })),
        obligations: upcomingObligations,
        expiringDocuments: expiringDocs,
        profiles: profiles.map(p => ({ name: p.name, type: p.type })),
        memories: memories.slice(-10).map(m => ({ key: m.key, value: m.value })),
      };

      const systemPrompt = `You are the AI engine for Portol, a personal life management app. You analyze the user's data to produce a Weekly Digest — a structured personal report card.

Rules:
- Be specific with numbers. Say "You ran 12 miles this week, up from 8 last week" not "You've been active."
- Find cross-entity patterns: exercise vs sleep, spending vs mood, habits vs productivity.
- Give actionable, concise recommendations.
- Assign a 1-100 "life score" based on overall data health. 80+ = excellent, 60-80 = good, 40-60 = needs attention, below 40 = concerning.
- If data is sparse, note it but still provide useful insights from what's available.
- Return ONLY valid JSON matching the exact schema below. No markdown, no code fences.

JSON Schema:
{
  "headline": "string — catchy 5-10 word summary like 'Strong week — your best since February'",
  "score": "number 1-100",
  "sections": [
    {
      "title": "string — e.g. 'Health & Fitness'",
      "icon": "one of: heart, dollar, brain, flame, calendar, target",
      "insight": "string — specific data-backed observation",
      "recommendation": "string — actionable next step",
      "severity": "one of: positive, neutral, warning, critical"
    }
  ],
  "correlations": [
    {
      "insight": "string — cross-entity pattern like 'You sleep 45 min longer on days you exercise'",
      "entities": ["string", "string"]
    }
  ]
}

Generate 3-6 sections covering different life areas. Generate 1-3 correlations if patterns exist. If data is insufficient for correlations, return an empty array.`;

      const userPrompt = `Here is my Portol data snapshot for the week of ${weekAgoStr} to ${todayStr}:\n\n${JSON.stringify(dataSnapshot, null, 1)}\n\nGenerate my Weekly Digest JSON.`;

      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const response = await client.messages.create({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
        max_tokens: 2048,
        messages: [
          { role: "user", content: userPrompt },
        ],
        system: systemPrompt,
      });

      // Extract text from response
      const textBlock = response.content.find(b => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        throw new Error("No text response from Claude");
      }

      // Parse the JSON response - strip any markdown code fences if present
      let jsonStr = textBlock.text.trim();
      if (jsonStr.startsWith("```")) {
        jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
      }
      let digestData: any;
      try {
        digestData = JSON.parse(jsonStr);
      } catch {
        digestData = {};
      }

      // Build week summary
      const weekSummary = {
        tasksCompleted: tasksCompleted.length,
        tasksCreated: tasksThisWeek.length,
        habitsCheckedIn: habitsCheckedIn,
        totalHabitDays: totalHabitDays,
        expensesTotal: weekExpenseTotal,
        topExpenseCategory: topExpenseCategory,
        trackerEntries: trackerEntriesThisWeek,
        journalEntries: journalThisWeek.length,
        avgMood: avgMoodLabel,
        documentsUploaded: documents.filter(d => {
          try {
            const created = d.createdAt ? new Date(d.createdAt) : null;
            return created && created >= weekAgo;
          } catch { return false; }
        }).length,
      };

      const result = {
        headline: digestData.headline || "Your Weekly Report",
        score: typeof digestData.score === "number" ? digestData.score : 50,
        generatedAt: now.toISOString(),
        sections: Array.isArray(digestData.sections) ? digestData.sections : [],
        correlations: Array.isArray(digestData.correlations) ? digestData.correlations : [],
        weekSummary,
      };

      // Cache the result
      await storage.setPreference("ai_digest", JSON.stringify(result));

      res.json(result);
    } catch (err: any) {
      console.error("AI Digest error:", err);
      res.status(500).json({ error: "Failed to generate AI digest" });
    }
  }));

  // ── Wave 4: Cross-entity AI semantic search ───────────────────────
  // POST /api/search/ai
  // Body: { query: string, types?: string[], limit?: number }
  // No vector DB needed — AI picks the best matches from a compact catalogue
  // of all user entities. Drop-in upgrade path to pgvector later.
  app.post("/api/search/ai", asyncHandler(async (req, res) => {
    try {
      const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
      if (!query) return res.status(400).json({ error: "query is required" });
      if (query.length > 200) return res.status(400).json({ error: "query too long (max 200 chars)" });
      const limit = Math.min(Math.max(Number(req.body?.limit) || 10, 1), 25);
      const typesParam: string[] | undefined = Array.isArray(req.body?.types) ? req.body.types.filter((t: any) => typeof t === "string") : undefined;
      // Optional profile filter from request body OR query (clients can pass either).
      const _pIds: string[] = Array.isArray(req.body?.profileIds)
        ? req.body.profileIds.filter((p: any) => typeof p === "string")
        : ((req.query.profileIds as string | undefined)?.split(",").filter(Boolean) || []);

      // Build a compact catalogue — cheaper than full snapshots.
      let [profiles, expenses, obligations, documents, trackers, goals, events] = await Promise.all([
        storage.getProfiles(),
        storage.getExpenses(),
        storage.getObligations(),
        storage.getDocuments(),
        storage.getTrackers(),
        storage.getGoals(),
        storage.getEvents(),
      ]);
      if (_pIds.length > 0) {
        const inProfile = (lp: string[] | undefined | null) => (lp || []).some(id => _pIds.includes(id));
        profiles = profiles.filter((p: any) => _pIds.includes(p.id));
        expenses = expenses.filter((e: any) => inProfile(e.linkedProfiles || (e.linkedProfileId ? [e.linkedProfileId] : [])));
        obligations = obligations.filter((o: any) => inProfile(o.linkedProfiles));
        documents = documents.filter((d: any) => inProfile(d.linkedProfiles));
        trackers = trackers.filter((t: any) => inProfile(t.linkedProfiles));
        goals = goals.filter((g: any) => inProfile(g.linkedProfiles));
        events = events.filter((ev: any) => inProfile(ev.linkedProfiles));
      }

      type CatalogueItem = { idx: number; entity: "profile" | "expense" | "obligation" | "document" | "tracker" | "goal" | "event"; id: string; label: string };
      const catalogue: CatalogueItem[] = [];
      const idGen = () => catalogue.length;
      const want = (t: string) => !typesParam || typesParam.includes(t);

      if (want("profile")) for (const p of profiles as any[]) {
        const rel = p.relationship || p.role || "";
        const label = `${p.name} [${p.type}]${rel ? ` (${rel})` : ""}`;
        catalogue.push({ idx: idGen(), entity: "profile", id: p.id, label });
      }
      if (want("expense")) for (const e of expenses.slice(-200)) {
        const label = `${e.vendor || e.description?.slice(0, 60) || "expense"} — $${e.amount} [${e.category}] ${e.date}`;
        catalogue.push({ idx: idGen(), entity: "expense", id: e.id, label });
      }
      if (want("obligation")) for (const o of obligations) {
        const label = `${o.name} — $${o.amount}/${o.frequency} [${o.category || "other"}]`;
        catalogue.push({ idx: idGen(), entity: "obligation", id: o.id, label });
      }
      if (want("document")) for (const d of documents) {
        const label = `${d.name} [${d.type}]${d.expirationDate ? ` exp ${d.expirationDate}` : ""}`;
        catalogue.push({ idx: idGen(), entity: "document", id: d.id, label });
      }
      if (want("tracker")) for (const t of trackers) {
        const label = `${t.name} [${t.category || "general"}]${t.unit ? ` (${t.unit})` : ""}`;
        catalogue.push({ idx: idGen(), entity: "tracker", id: t.id, label });
      }
      if (want("goal")) for (const g of goals) {
        catalogue.push({ idx: idGen(), entity: "goal", id: g.id, label: `${g.title}` });
      }
      if (want("event")) for (const e of events.slice(-100)) {
        catalogue.push({ idx: idGen(), entity: "event", id: e.id, label: `${e.title} — ${e.date}` });
      }

      if (catalogue.length === 0) return res.json({ results: [], reason: "No entities to search." });

      // If catalogue is huge, chunk in a future iteration. For now cap at 800 items.
      const trimmed = catalogue.slice(0, 800);

      const decision = await aiDecide<{ matches: Array<{ idx: number; score: number; reason: string }> }>({
        task: "semantic-search",
        system: `You are a semantic search engine across a personal-data catalogue.
Return ONLY JSON: {"matches":[{"idx":<number>,"score":<0..1>,"reason":"<one short sentence>"}]}
Rank up to ${limit} most-relevant items. Be strict: only include items genuinely relevant. Empty array is fine.
Match on meaning, not just substring — "car bill" should match an auto-loan obligation; "pet vet visit" should match a dog profile's medical event.`,
        user: `Query: "${query}"\n\nCatalogue (idx, entity, label):\n${trimmed.map(c => `${c.idx} ${c.entity}: ${c.label}`).join("\n")}\n\nReturn JSON only.`,
        timeoutMs: 7000,
        maxTokens: 800,
        maxPromptChars: 60000,
        fallback: () => {
          // Deterministic substring fallback so the endpoint still answers.
          const q = query.toLowerCase();
          const matches = trimmed
            .filter(c => c.label.toLowerCase().includes(q))
            .slice(0, limit)
            .map(c => ({ idx: c.idx, score: 0.5, reason: "substring match" }));
          return { matches };
        },
        validate: (p: any) => p && Array.isArray(p.matches),
      });

      const results = decision.value.matches
        .filter(m => m && typeof m.idx === "number" && trimmed[m.idx])
        .map(m => ({
          entity: trimmed[m.idx].entity,
          id: trimmed[m.idx].id,
          label: trimmed[m.idx].label,
          score: typeof m.score === "number" ? m.score : 0,
          reason: m.reason || "",
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      res.json({ results, source: decision.source, totalScanned: trimmed.length });
    } catch (err: any) {
      log.error("[SemanticSearch]", err?.message || "unknown error");
      res.status(500).json({ error: "Semantic search failed", results: [] });
    }
  }));

  // ── Wave 3 #8: Proactive AI suggestions for the dashboard ───────────────
  // Returns 3-5 actionable suggestions based on a compact snapshot of the
  // user's current state — missing data, duplicates, overdue items,
  // categorization gaps, untracked recurring expenses, etc.
  // Cached for 4 hours to keep cost negligible (~$0.01/user/day).
  app.get("/api/dashboard/ai-suggestions", asyncHandler(async (req, res) => {
    try {
      const force = req.query.force === "true";
      // Make the active profile filter part of the cache key so suggestions
      // are scoped to the user's current view (Bob's suggestions != global).
      const _profileIdsParam = (req.query.profileIds as string | undefined) || (req.query.profileId as string | undefined) || "";
      const filterIds: string[] = _profileIdsParam ? _profileIdsParam.split(",").filter(Boolean) : [];
      const CACHE_KEY = filterIds.length > 0 ? `ai_suggestions:${filterIds.sort().join(",")}` : "ai_suggestions";
      // BUG-007/008: TTL was 4h, which made AI Summary / Action Required show
      // stale facts after the user added/deleted/edited data. Tighten to 30min
      // AND fingerprint the underlying snapshot — if the fingerprint changed,
      // we ignore the cache regardless of age. The fingerprint check is the
      // primary defence; TTL is the safety net for slow-moving data.
      const TTL_MS = 30 * 60 * 1000; // 30 minutes
      // Cached entry checked after the snapshot is built so we can compare
      // fingerprints. Stored separately and short-circuits AI call when valid.
      let cachedParsed: any = null;
      if (!force) {
        const cached = await storage.getPreference(CACHE_KEY);
        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            if (parsed.generatedAt && (Date.now() - new Date(parsed.generatedAt).getTime()) < TTL_MS) {
              cachedParsed = parsed;
            }
          } catch { /* ignore */ }
        }
      }

      let [profiles, expenses, obligations, documents, trackers, goals] = await Promise.all([
        storage.getProfiles(),
        storage.getExpenses(),
        storage.getObligations(),
        storage.getDocuments(),
        storage.getTrackers(),
        storage.getGoals(),
      ]);

      // Scope the snapshot to the active profile filter so AI advice is relevant.
      if (filterIds.length > 0) {
        const inProfile = (lp: string[] | undefined | null) => (lp || []).some(id => filterIds.includes(id));
        const inExpense = (e: any) => {
          const lp = e.linkedProfiles || (e.linkedProfileId ? [e.linkedProfileId] : []);
          return inProfile(lp);
        };
        expenses = expenses.filter(inExpense);
        obligations = obligations.filter((o: any) => inProfile(o.linkedProfiles));
        documents = documents.filter((d: any) => inProfile(d.linkedProfiles));
        trackers = trackers.filter((t: any) => inProfile(t.linkedProfiles));
        goals = goals.filter((g: any) => inProfile(g.linkedProfiles));
        profiles = profiles.filter((p: any) => filterIds.includes(p.id));
      }

      // Build a TIGHT snapshot — just enough for AI to spot issues.
      const snapshot: any = {
        profileCounts: profiles.reduce((acc: Record<string, number>, p: any) => {
          acc[p.type] = (acc[p.type] || 0) + 1; return acc;
        }, {}),
        recentExpenses: expenses.slice(-30).map((e: any) => ({ amount: e.amount, category: e.category, vendor: e.vendor || e.description?.slice(0, 40), date: e.date })),
        obligationCount: obligations.length,
        obligationsByCategory: obligations.reduce((acc: Record<string, number>, o: any) => {
          acc[o.category || "other"] = (acc[o.category || "other"] || 0) + 1; return acc;
        }, {}),
        docCount: documents.length,
        docsByType: documents.reduce((acc: Record<string, number>, d: any) => {
          acc[d.type || "other"] = (acc[d.type || "other"] || 0) + 1; return acc;
        }, {}),
        unlinkedDocCount: documents.filter((d: any) => !d.linkedProfiles || d.linkedProfiles.length === 0).length,
        otherCategoryExpenses: expenses.filter((e: any) => e.category === "other" || e.category === "general").length,
        trackerCount: trackers.length,
        emptyTrackerCount: trackers.filter((t: any) => !t.entries || t.entries.length === 0).length,
        goalCount: goals.length,
      };

      // BUG-007/008: cheap fingerprint of the snapshot. If it matches the
      // cached entry's fingerprint, the underlying data is unchanged so we
      // safely return the cached suggestions. Otherwise the cache is stale
      // (user added/deleted/edited something) and we regenerate.
      const snapshotFingerprint = (() => {
        try {
          const s = JSON.stringify(snapshot);
          let h = 0;
          for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
          return String(h);
        } catch { return String(Date.now()); }
      })();
      if (cachedParsed && cachedParsed.fingerprint === snapshotFingerprint) {
        return res.json(cachedParsed);
      }

      const decision = await aiDecide<{ suggestions: Array<{ title: string; body: string; action: string; priority: "high" | "medium" | "low" }> }>({
        task: "dashboard-ai-suggestions",
        system: `You are a personal-finance coach surfacing 3 to 5 actionable improvements based ONLY on the snapshot data provided.
Return ONLY JSON: {"suggestions":[{"title":"<8 words max>","body":"<one short sentence>","action":"<short verb phrase>","priority":"high"|"medium"|"low"}]}
STRICT RULES (BUG-007/008 — factual accuracy):
- Only state facts that are directly derivable from the snapshot counts/fields. Never invent counts, amounts, dates, vendors, or category names.
- If a count is 0 (e.g. unlinkedDocCount=0), do NOT suggest fixing that issue.
- Never reference data not present in the snapshot.
- If the snapshot is sparse, return fewer suggestions rather than fabricating ones.
Focus on:
- expenses categorised as "other"/"general" → re-categorize (only if otherCategoryExpenses > 0)
- documents not linked to any profile → link them (only if unlinkedDocCount > 0)
- recurring vendors in recentExpenses with no matching obligation → add as subscription
- empty trackers → archive or use (only if emptyTrackerCount > 0)
- duplicate-looking profile types
- missing essential profiles (self has no income/account)
No emojis. No prose outside the JSON.`,
        user: `Snapshot:\n${JSON.stringify(snapshot)}\n\nReturn JSON only.`,
        timeoutMs: 8000,
        model: "claude-haiku-4-5-20251001",
        maxTokens: 700,
        fallback: () => ({ suggestions: [] }),
        validate: (p: any) => p && Array.isArray(p.suggestions),
      });

      const result = {
        suggestions: decision.value.suggestions.slice(0, 5),
        generatedAt: new Date().toISOString(),
        source: decision.source,
        fingerprint: snapshotFingerprint,
      };
      try { await storage.setPreference(CACHE_KEY, JSON.stringify(result)); } catch { /* ignore */ }
      res.json(result);
    } catch (err: any) {
      console.error("AI Suggestions error:", err);
      res.status(500).json({ error: "Failed to generate AI suggestions", suggestions: [] });
    }
  }));

  // ---- Goals ----
  app.get("/api/goals", asyncHandler(async (req, res) => {
    try {
      let goals = await storage.getGoals();
      const profileIdsParam = req.query.profileIds as string | undefined;
      const profileId = req.query.profileId as string | undefined;
      const ids = profileIdsParam ? profileIdsParam.split(",").filter(Boolean) : (profileId ? [profileId] : []);
      if (ids.length > 0) {
        const allProfiles = await storage.getProfiles();
        const selfMatch = ids.some(id => allProfiles.find(p => p.id === id)?.type === "self");
        goals = goals.filter(g => {
          const lp = g.linkedProfiles || [];
          if (lp.length === 0) return selfMatch;
          return lp.some(id => ids.includes(id));
        });
      }
      res.json(paginate(goals, req, res));
    } catch (err: any) {
      console.error("Goals error:", err);
      res.status(500).json({ error: "Failed to get goals" });
    }
  }));

  app.get("/api/goals/:id", asyncHandler(async (req, res) => {
    try {
      const goal = await storage.getGoal(req.params.id);
      if (!goal) return res.status(404).json({ error: "Goal not found" });
      // S1 fix: storage layer filters by user_id; defense-in-depth ownership guard.
      if ((goal as any).userId && (goal as any).userId !== (req as AuthenticatedRequest).userId) {
        return res.status(404).json({ error: "Goal not found" });
      }
      res.json(goal);
    } catch (err: any) {
      console.error("Goal error:", err);
      res.status(500).json({ error: "Failed to get goal" });
    }
  }));

  app.post("/api/goals", asyncHandler(async (req, res) => {
    try {
      if (!req.body.title || typeof req.body.title !== "string" || !req.body.title.trim()) {
        return res.status(400).json({ error: "Goal title required" });
      }
      if (req.body.target !== null && req.body.target !== undefined) {
        if (typeof req.body.target !== "number" || req.body.target <= 0) {
          return res.status(400).json({ error: "Target must be greater than 0" });
        }
      }
      if (req.body.unit !== undefined && typeof req.body.unit !== "string") {
        return res.status(400).json({ error: "Unit must be a string" });
      }
      const parsed = insertGoalSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid request data" });
      const goal = await storage.createGoal(parsed.data);
      res.json(goal);
    } catch (err: any) {
      console.error("Create goal error:", err);
      res.status(500).json({ error: "Failed to create goal" });
    }
  }));

  app.patch("/api/goals/:id", asyncHandler(async (req, res) => {
    {
      const parsed = insertGoalSchema.partial().safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: `Validation failed: ${JSON.stringify(parsed.error.flatten())}` });
      req.body = { ...req.body, ...parsed.data };
    }
    if (req.body.title !== undefined) {
      if (typeof req.body.title !== "string" || !req.body.title.trim()) return res.status(400).json({ error: "Goal title must be a non-empty string" });
      req.body.title = sanitize(req.body.title);
    }
    if (req.body.target !== undefined && (typeof req.body.target !== "number" || req.body.target <= 0)) {
      return res.status(400).json({ error: "Target must be a positive number" });
    }
    if (req.body.current !== undefined && (typeof req.body.current !== "number" || req.body.current < 0)) {
      return res.status(400).json({ error: "Current progress cannot be negative" });
    }
    try {
      const goal = await storage.updateGoal(req.params.id, req.body);
      if (!goal) return res.status(404).json({ error: "Goal not found" });
      res.json(goal);
    } catch (err: any) {
      console.error("Update goal error:", err);
      res.status(500).json({ error: "Failed to update goal" });
    }
  }));

  app.delete("/api/goals/:id", asyncHandler(async (req, res) => {
    try {
      const deleted = await storage.deleteGoal(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Goal not found" });
      res.json({ success: true });
    } catch (err: any) {
      console.error("Delete goal error:", err);
      res.status(500).json({ error: "Failed to delete goal" });
    }
  }));

  // ---- Entity Links ----
  app.get("/api/entity-links/:type/:id", asyncHandler(async (req, res) => {
    try {
      const links = await storage.getEntityLinks(req.params.type, req.params.id);
      res.json(links);
    } catch (err: any) {
      console.error("Get entity links error:", err);
      res.status(500).json({ error: "Failed to get entity links" });
    }
  }));

  app.get("/api/entity-links/:type/:id/related", asyncHandler(async (req, res) => {
    try {
      const related = await storage.getRelatedEntities(req.params.type, req.params.id);
      res.json(related);
    } catch (err: any) {
      console.error("Get related entities error:", err);
      res.status(500).json({ error: "Failed to get related entities" });
    }
  }));

  app.post("/api/entity-links", asyncHandler(async (req, res) => {
    try {
      const parsed = insertEntityLinkSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid request data" });
      // Verify both endpoints of the link belong to this user — otherwise
      // an attacker can create cross-user links pointing at foreign UUIDs.
      const { sourceType, sourceId, targetType, targetId } = parsed.data as any;
      if (!KNOWN_ENTITY_TYPES.has(sourceType) || !KNOWN_ENTITY_TYPES.has(targetType)) {
        return res.status(400).json({ error: "Validation failed: unknown entity type" });
      }
      const [srcOwned, tgtOwned] = await Promise.all([
        verifyEntityOwnership(sourceType, sourceId),
        verifyEntityOwnership(targetType, targetId),
      ]);
      if (!srcOwned || !tgtOwned) return res.status(404).json({ error: "Resource not found" });
      const link = await storage.createEntityLink(parsed.data);
      res.json(link);
    } catch (err: any) {
      console.error("Create entity link error:", err);
      console.error("[entity-link]", err?.message || err);
      res.status(400).json({ error: "Failed to create entity link" });
    }
  }));

  app.delete("/api/entity-links/:id", asyncHandler(async (req, res) => {
    try {
      const deleted = await storage.deleteEntityLink(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Entity link not found" });
      res.json({ success: true });
    } catch (err: any) {
      console.error("Delete entity link error:", err);
      res.status(500).json({ error: "Failed to delete entity link" });
    }
  }));

  // ---- Income ----
  app.get("/api/incomes", asyncHandler(async (req, res) => {
    let incomes = await storage.getIncomes();
    // Support profile filtering: ?profileIds=x,y or ?profileId=x
    const fps = req.query.profileIds as string | undefined;
    const fp = req.query.profileId as string | undefined;
    const filterProfileIds = fps ? fps.split(",").filter(Boolean) : fp ? [fp] : [];
    if (filterProfileIds.length > 0) {
      // Bug: previous filter was `lp.length === 0 || lp.some(...)` which
      // leaks ALL orphan incomes (no linked_profiles) to any selected profile,
      // including brand-new non-self profiles that should see zero data.
      // Use the unified passesProfileFilter rule so orphans only fall through
      // when a self profile is in the selection.
      const allProfiles = await storage.getProfiles();
      const filterCtx = { selectedIds: filterProfileIds, allProfiles };
      incomes = incomes.filter((i: any) => passesProfileFilter(i.linkedProfiles || [], filterCtx));
    }
    res.json(incomes);
  }));

  // Helper: bust every cache key derived from income (cashflow / dashboard /
  // stats / enhanced). Without this, adding a paycheck wouldn't move the
  // "Income this month" or "Net cashflow" numbers until the 5-min server
  // cache expired, which made the dashboard look broken.
  const bustIncomeCaches = (uid: string) => {
    bustCache(`cashflow:${uid}`);
    bustCache(`stats:${uid}`);
    bustCache(`enhanced:`);
    bustCache(`enhanced:${uid}`);
    bustCache(`profile-detail:${uid}:`);
  };

  app.post("/api/incomes", asyncHandler(async (req, res) => {
    const uid = (req as AuthenticatedRequest).userId || req.ip || "anon";
    // Bug fix: this route used to call storage.createIncome(req.body) with no
    // validation at all. A POST { amount: "abc" } would NaN out every monthly
    // income computation. Validate amount + description + sanitize inputs.
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({ error: "Request body must be a JSON object" });
    }
    if (!req.body.description || typeof req.body.description !== "string" || !req.body.description.trim()) {
      return res.status(400).json({ error: "description is required" });
    }
    if (req.body.amount === undefined || req.body.amount === null) {
      return res.status(400).json({ error: "amount is required" });
    }
    const amt = typeof req.body.amount === "number" ? req.body.amount : Number(req.body.amount);
    if (!isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: "amount must be a finite positive number" });
    }
    req.body.amount = amt;
    req.body.description = sanitize(req.body.description);
    const income = await storage.createIncome(req.body);
    bustIncomeCaches(uid);
    res.status(201).json(income);
  }));

  app.patch("/api/incomes/:id", asyncHandler(async (req, res) => {
    const uid = (req as AuthenticatedRequest).userId || req.ip || "anon";
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({ error: "Request body must be a JSON object" });
    }
    if (req.body.amount !== undefined) {
      const amt = typeof req.body.amount === "number" ? req.body.amount : Number(req.body.amount);
      if (!isFinite(amt) || amt <= 0) {
        return res.status(400).json({ error: "amount must be a finite positive number" });
      }
      req.body.amount = amt;
    }
    if (req.body.description !== undefined) {
      if (typeof req.body.description !== "string" || !req.body.description.trim()) {
        return res.status(400).json({ error: "description must be a non-empty string" });
      }
      req.body.description = sanitize(req.body.description);
    }
    const income = await storage.updateIncome(req.params.id, req.body);
    if (!income) return res.status(404).json({ error: "Not found" });
    bustIncomeCaches(uid);
    res.json(income);
  }));

  app.delete("/api/incomes/:id", asyncHandler(async (req, res) => {
    const uid = (req as AuthenticatedRequest).userId || req.ip || "anon";
    const ok = await storage.deleteIncome(req.params.id);
    bustIncomeCaches(uid);
    res.json({ success: ok });
  }));

  // ---- Audit Log ----
  app.get("/api/audit-log", asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const { data, error } = await (storage as any).supabase
      .from("audit_log")
      .select("*")
      .eq("user_id", (req as AuthenticatedRequest).userId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) { console.error("[api]", error.message); return res.status(500).json({ error: "Failed to load data" }); }
    res.json(data || []);
  }));

  // POST audit-log: used by client errorReporter and other client-side logging.
  // Body: { action, entity_type, entity_id?, entity_name?, details?, source? }
  app.post("/api/audit-log", asyncHandler(async (req, res) => {
    try {
      const userId = (req as AuthenticatedRequest).userId;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });
      // Rate-limit per user to avoid runaway error storms filling the table.
      if (rateLimit(`audit-log-post:${userId}`, 120, 60_000)) {
        return res.status(429).json({ error: "Rate limited" });
      }
      const body = req.body || {};
      const action = typeof body.action === "string" ? body.action.slice(0, 100) : null;
      const entity_type = typeof body.entity_type === "string" ? body.entity_type.slice(0, 100) : null;
      if (!action || !entity_type) {
        return res.status(400).json({ error: "action and entity_type are required" });
      }
      const row: Record<string, any> = {
        user_id: userId,
        action,
        entity_type,
        entity_id: typeof body.entity_id === "string" ? body.entity_id.slice(0, 200) : null,
        entity_name: typeof body.entity_name === "string" ? body.entity_name.slice(0, 500) : null,
        details: body.details && typeof body.details === "object" ? body.details : {},
        source: typeof body.source === "string" ? body.source.slice(0, 100) : "manual",
      };
      const { data, error } = await (storage as any).supabase
        .from("audit_log")
        .insert(row)
        .select()
        .single();
      if (error) {
        console.error("[api] audit-log insert failed:", error.message);
        return res.status(500).json({ error: "Failed to write audit log" });
      }
      res.json(data);
    } catch (err: any) {
      console.error("[api] audit-log POST failed:", err?.message);
      res.status(500).json({ error: "Failed to write audit log" });
    }
  }));

  // ---- Delete All User Data ----
  app.delete("/api/data/all", asyncHandler(async (req, res) => {
    try {
      const deleteUid = (req as AuthenticatedRequest).userId || req.ip || 'anonymous';
      if (rateLimit(`delete-all:${deleteUid}`, 1, 3600000)) {
        return res.status(429).json({ error: "Account deletion rate limited. Try again in an hour." });
      }
      const { confirmation } = req.body || {};
      if (confirmation !== "DELETE") {
        return res.status(400).json({ error: "You must send confirmation: 'DELETE' to proceed." });
      }
      const result = await storage.deleteAllUserData();
      clearAllCache();
      res.json({ success: true, deleted: result.deleted });
    } catch (err: any) {
      console.error("[api] Delete all data failed:", err.message);
      res.status(500).json({ error: "Failed to delete all data" });
    }
  }));

  // ---- Preferences ----
  app.get("/api/preferences/:key", asyncHandler(async (req, res) => {
    try {
      const value = await storage.getPreference(req.params.key);
      if (value === null) return res.json({ value: null });
      res.json({ value });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to get preference" });
    }
  }));

  app.put("/api/preferences/:key", asyncHandler(async (req, res) => {
    try {
      const { value } = req.body;
      if (typeof value !== "string") return res.status(400).json({ error: "value (string) required" });
      // Block writes to sensitive / system-managed preference keys to prevent
      // clients from overwriting OAuth tokens or onboarding state.
      const key = req.params.key;
      const PREF_KEY_PREFIX_DENY = ["gcal_", "oauth_", "system_", "internal_"];
      const PREF_KEY_DENYLIST = new Set([
        "gcal_refresh_token", "gcal_access_token",
        "onboarding_completed", "ai_digest", "admin_override",
      ]);
      if (PREF_KEY_DENYLIST.has(key) || PREF_KEY_PREFIX_DENY.some(p => key.startsWith(p))) {
        return res.status(400).json({ error: "Validation failed: preference key is reserved" });
      }
      await storage.setPreference(key, value);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to set preference" });
    }
  }));

  // ---- Onboarding Status ----
  app.get("/api/onboarding-status", asyncHandler(async (req, res) => {
    // Check actual user data to determine onboarding status
    const completed = await storage.getPreference("onboarding_completed");
    if (completed === "true") {
      return res.json({ completed: true });
    }
    // PERF FIX: was 3 sequential round trips on the cold path that runs on
    // every fresh login. Parallelize so onboarding-check is one round-trip.
    const [profiles, trackers, tasks] = await Promise.all([
      storage.getProfiles(),
      storage.getTrackers(),
      storage.getTasks(),
    ]);
    const hasData = profiles.length > 1 || trackers.length > 0 || tasks.length > 0; // >1 because self profile is auto-created
    res.json({
      completed: hasData, // If they already have data, skip onboarding
      hasProfiles: profiles.length > 1,
      hasTrackers: trackers.length > 0,
      hasTasks: tasks.length > 0,
      profileCount: profiles.length,
      trackerCount: trackers.length,
      taskCount: tasks.length,
    });
  }));

  app.post("/api/onboarding/complete", asyncHandler(async (_req, res) => {
    try {
      await storage.setPreference("onboarding_completed", "true");
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to complete onboarding" });
    }
  }));

  // ---- Google Calendar Sync ----
  app.post("/api/calendar/sync", asyncHandler(async (req, res) => {
    try {
      // Determine date range — sync 2 months (1 month back, 1 month forward)
      const now = new Date();
      const startDate = new Date(now);
      startDate.setMonth(startDate.getMonth() - 1);
      const endDate = new Date(now);
      endDate.setMonth(endDate.getMonth() + 1);

      const startStr = startDate.toISOString().replace("Z", new Date().toTimeString().match(/[+-]\d{4}/)?.[0]?.replace(/(\d{2})(\d{2})/, "$1:$2") || "+00:00");
      const endStr = endDate.toISOString().replace("Z", new Date().toTimeString().match(/[+-]\d{4}/)?.[0]?.replace(/(\d{2})(\d{2})/, "$1:$2") || "+00:00");

      // Call Google Calendar via external-tool CLI
      const params = JSON.stringify({
        source_id: "gcal",
        tool_name: "search_calendar",
        arguments: {
          start_date: startStr,
          end_date: endStr,
          queries: [""],
        },
      });

      let gcalResult: any;
      try {
        const { stdout } = await execFileAsync("external-tool", ["call", params], {
          timeout: 30000,
          maxBuffer: 10_000_000,
          encoding: "utf-8",
        });
        gcalResult = JSON.parse(stdout);
      } catch (err: any) {
        console.error("Google Calendar fetch failed:", err.message);
        // promisified execFile signals a timeout via the SIGTERM signal.
        if (err?.signal === "SIGTERM" || err?.killed === true || err?.code === "ETIMEDOUT") {
          return res.status(504).json({ error: "Calendar sync timed out" });
        }
        return res.status(502).json({ error: "Failed to connect to Google Calendar. Please try again." });
      }

      const gcalEvents = gcalResult?.calendar_event_list?.events || [];
      if (gcalEvents.length === 0) {
        return res.json({ imported: 0, exported: 0, message: "No events found in Google Calendar for this period." });
      }

      // Get existing Portol events to avoid duplicates
      const existingEvents = await storage.getEvents();
      // PERF FIX: was sequential getPreference per existing event — sync would
      // serialize N Supabase round trips. Parallelize so the bulk lookup is
      // a single round-trip burst.
      const gcalMappings = new Set<string>();
      const mappingResults = await Promise.all(
        existingEvents.map(e => storage.getPreference(`gcal_map_${e.id}`).catch(() => null))
      );
      for (const mapped of mappingResults) {
        if (mapped) gcalMappings.add(mapped);
      }

      let imported = 0;
      const importedEvents: string[] = [];

      for (const gcEvent of gcalEvents) {
        // Skip if already imported (by Google event ID)
        const gEventId = gcEvent.event_id || "";
        if (gcalMappings.has(gEventId)) continue;

        // Also check for title+date duplicates
        const startParsed = new Date(gcEvent.start);
        const gcalTz = getTimezone(req);
        const eventDate = toLocalDateStr(startParsed, gcalTz);
        const isDuplicate = existingEvents.some(
          (e: any) => e.title === gcEvent.title && e.date === eventDate
        );
        if (isDuplicate) continue;

        // Map Google Calendar event → Portol event
        const startTime = gcEvent.is_all_day ? undefined : startParsed.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: gcalTz });
        const endParsed = gcEvent.end ? new Date(gcEvent.end) : null;
        const endTime = (gcEvent.is_all_day || !endParsed) ? undefined : endParsed.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: gcalTz });

        // Determine end date for multi-day events
        let endDateStr: string | undefined;
        if (endParsed) {
          const ed = toLocalDateStr(endParsed, gcalTz);
          if (ed !== eventDate) endDateStr = ed;
        }

        // Guess category from title/description
        let category: "personal" | "work" | "health" | "social" | "travel" | "finance" | "family" | "education" | "other" = "personal";
        const combined = ((gcEvent.title || "") + " " + (gcEvent.description || "")).toLowerCase();
        if (/meeting|standup|sprint|retro|1:1|sync|planning|review/.test(combined)) category = "work";
        else if (/doctor|dentist|medical|appointment|therapy|vet|checkup/.test(combined)) category = "health";
        else if (/birthday|party|dinner|lunch|brunch|wedding|anniversary/.test(combined)) category = "social";
        else if (/gym|workout|run|yoga|fitness|exercise|soccer|game/.test(combined)) category = "health";
        else if (/flight|hotel|trip|travel|vacation/.test(combined)) category = "travel";

        try {
          const created = await storage.createEvent({
            title: gcEvent.title || "Untitled Event",
            date: eventDate,
            time: startTime,
            endTime: endTime,
            endDate: endDateStr,
            allDay: gcEvent.is_all_day || false,
            description: gcEvent.description || undefined,
            location: gcEvent.location || undefined,
            category,
            recurrence: "none",
            source: "external",
            linkedProfiles: [],
            linkedDocuments: [],
            tags: ["google-calendar"],
          });

          // Store the Google event ID for dedup
          await storage.setPreference(`gcal_map_${created.id}`, gEventId);

          imported++;
          importedEvents.push(gcEvent.title || "Untitled");
        } catch (err: any) {
          console.error("Failed to import event:", gcEvent.title, err.message);
        }
      }

      // Record last sync time
      await storage.setPreference("gcal_last_sync", new Date().toISOString());

      res.json({
        imported,
        total: gcalEvents.length,
        importedEvents,
        message: imported > 0
          ? `Imported ${imported} new events from Google Calendar.`
          : "All Google Calendar events are already synced.",
      });
    } catch (err: any) {
      console.error("Calendar sync error:", err);
      res.status(500).json({ error: "Calendar sync failed" });
    }
  }));

  // Export a Portol event to Google Calendar
  app.post("/api/calendar/export/:id", asyncHandler(async (req, res) => {
    try {
      const event = await storage.getEvent(req.params.id);
      if (!event) return res.status(404).json({ error: "Event not found" });

      // Parse time like "6:00 AM" or "14:00"
      let startHour = 0, startMin = 0;
      const timeMatch = (event.time || "").match(/(\d+):(\d+)\s*(AM|PM)?/i);
      if (timeMatch) {
        startHour = parseInt(timeMatch[1]);
        startMin = parseInt(timeMatch[2]);
        if (timeMatch[3]?.toUpperCase() === "PM" && startHour !== 12) startHour += 12;
        if (timeMatch[3]?.toUpperCase() === "AM" && startHour === 12) startHour = 0;
      }

      const dateStr = event.date;
      const tzOffset = (() => { const o = new Date().getTimezoneOffset(); const h = String(Math.floor(Math.abs(o)/60)).padStart(2,"0"); const m = String(Math.abs(o)%60).padStart(2,"0"); return (o <= 0 ? "+" : "-") + h + ":" + m; })();
      const startDateTime = `${dateStr}T${String(startHour).padStart(2, "0")}:${String(startMin).padStart(2, "0")}:00${tzOffset}`;

      let endHour = startHour + 1, endMin = startMin;
      if (event.endTime) {
        const endMatch = event.endTime.match(/(\d+):(\d+)\s*(AM|PM)?/i);
        if (endMatch) {
          endHour = parseInt(endMatch[1]);
          endMin = parseInt(endMatch[2]);
          if (endMatch[3]?.toUpperCase() === "PM" && endHour !== 12) endHour += 12;
          if (endMatch[3]?.toUpperCase() === "AM" && endHour === 12) endHour = 0;
        }
      }
      const endDateTime = `${event.endDate || dateStr}T${String(endHour).padStart(2, "0")}:${String(endMin).padStart(2, "0")}:00${tzOffset}`;

      const params = JSON.stringify({
        source_id: "gcal",
        tool_name: "update_calendar",
        arguments: {
          create_actions: [{
            action: "create",
            title: event.title,
            description: event.description || "",
            start_date_time: startDateTime,
            end_date_time: endDateTime,
            attendees: [],
            meeting_provider: null,
            location: event.location || null,
          }],
          delete_actions: [],
          update_actions: [],
          user_prompt: null,
        },
      });

      let stdout: string;
      try {
        ({ stdout } = await execFileAsync("external-tool", ["call", params], {
          timeout: 30000,
          maxBuffer: 10_000_000,
          encoding: "utf-8",
        }));
      } catch (err: any) {
        if (err?.signal === "SIGTERM" || err?.killed === true || err?.code === "ETIMEDOUT") {
          return res.status(504).json({ error: "Calendar sync timed out" });
        }
        throw err;
      }
      let result: any;
      try {
        result = JSON.parse(stdout);
      } catch {
        result = {};
      }

      // Mark the event as synced
      await storage.updateEvent(event.id, { source: "external" } as Partial<CalendarEvent>);

      res.json({ exported: true, title: event.title, result });
    } catch (err: any) {
      console.error("Calendar export error:", err);
      res.status(500).json({ error: "Failed to export event to Google Calendar" });
    }
  }));

  // Get sync status
  app.get("/api/calendar/sync-status", asyncHandler(async (_req, res) => {
    try {
      // PERF FIX: was 3 sequential round trips.
      const [lastSync, events, gcalRefreshToken] = await Promise.all([
        storage.getPreference("gcal_last_sync"),
        storage.getEvents(),
        storage.getPreference("gcal_refresh_token"),
      ]);
      const gcalEvents = events.filter((e: any) => e.tags?.includes("google-calendar"));
      const gcalConfigured = !!gcalRefreshToken;
      res.json({
        connected: gcalConfigured,
        lastSync: gcalConfigured ? lastSync : null,
        importedCount: gcalEvents.length,
      });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to get sync status" });
    }
  }));

  // ---- Chat Artifacts ----
  app.get("/api/chat-artifacts", asyncHandler(async (req, res) => {
    const profileId = req.query.profileId as string | undefined;
    const { data, error } = await (storage as any).supabase
      .from('chat_artifacts')
      .select('*')
      .eq('user_id', (req as AuthenticatedRequest).userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    let results = data || [];
    if (profileId) {
      results = results.filter((a: any) => a.profile_id === profileId);
    }
    res.json(results);
  }));

  app.delete("/api/chat-artifacts/:id", asyncHandler(async (req, res) => {
    // Bug fix: previously this swallowed the Supabase error and returned 200
    // even when the delete failed (e.g. RLS denial, network blip). The frontend
    // then optimistically removed the row and the user thought it was gone.
    const uid = (req as AuthenticatedRequest).userId;
    const { data, error } = await (storage as any).supabase
      .from('chat_artifacts')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', uid)
      .select();
    if (error) {
      console.error("[api] chat-artifact delete failed:", error.message);
      return res.status(500).json({ error: "Failed to delete chat artifact" });
    }
    if (!data || data.length === 0) {
      return res.status(404).json({ error: "Chat artifact not found" });
    }
    res.json({ success: true });
  }));

  // ============================================================
  // LIABILITIES — Phase 1 endpoints
  // ============================================================

  // ---- Asset ↔ liability links ----
  app.get("/api/liabilities/:id/assets", asyncHandler(async (req, res) => {
    const rows = await storage.getLiabilityAssetLinks(req.params.id);
    res.json(rows);
  }));
  app.get("/api/assets/:id/liabilities", asyncHandler(async (req, res) => {
    const rows = await storage.getLiabilityAssetLinksForAsset(req.params.id);
    res.json(rows);
  }));
  app.post("/api/liability-asset-links", asyncHandler(async (req, res) => {
    const parsed = insertLiabilityAssetLinkSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    // Ownership: both profiles referenced must belong to the requester.
    const [liabOwned, assetOwned] = await Promise.all([
      storage.getProfile(parsed.data.liabilityProfileId),
      storage.getProfile(parsed.data.assetProfileId),
    ]);
    if (!liabOwned || !assetOwned) return res.status(404).json({ error: "Resource not found" });
    const row = await storage.createLiabilityAssetLink(parsed.data);
    res.json(row);
  }));
  app.patch("/api/liability-asset-links/:id", asyncHandler(async (req, res) => {
    const updated = await storage.updateLiabilityAssetLink(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  }));
  app.delete("/api/liability-asset-links/:id", asyncHandler(async (req, res) => {
    const ok = await storage.deleteLiabilityAssetLink(req.params.id);
    if (!ok) return res.status(404).json({ error: "Link not found" });
    res.json({ success: true });
  }));

  // ---- Party ↔ liability links ----
  app.get("/api/liabilities/:id/parties", asyncHandler(async (req, res) => {
    const rows = await storage.getLiabilityProfileLinks(req.params.id);
    // Enrich with linked party profile names + types so the UI can avoid "Unknown".
    const partyIds = Array.from(new Set((rows || []).map((r: any) => r.partyProfileId).filter(Boolean)));
    const partyById: Record<string, any> = {};
    await Promise.all(partyIds.map(async (pid: any) => {
      try { const p: any = await storage.getProfile(pid); if (p) partyById[pid] = { id: p.id, name: p.name, type: p.type }; } catch {}
    }));
    const enriched = (rows || []).map((r: any) => ({ ...r, party: partyById[r.partyProfileId] || null }));
    res.json(enriched);
  }));
  app.get("/api/parties/:id/liabilities", asyncHandler(async (req, res) => {
    // Direct liabilities (party is named on liability_profile_links) PLUS
    // propagated liabilities reached through assets the party owns. The
    // propagated set is what makes ownership feel "alive": if Jane owns
    // 50% of the Home and the Home secures a mortgage, Jane's profile
    // shows that mortgage with her allocated share. Each row carries a
    // `source` field so the UI can label the path.
    const partyId = req.params.id;
    const directRows: any[] = await storage.getLiabilityProfileLinksForParty(partyId);

    // Walk assets-owned -> liability_asset_links to find propagated liabilities.
    const assetLinks: any[] = await storage.getAssetPartyLinksForParty(partyId).catch(() => []);
    const propagated: any[] = [];
    for (const aLink of assetLinks || []) {
      const assetId = aLink.assetProfileId;
      if (!assetId) continue;
      const personPct = Number(aLink.ownershipPercentage ?? 0);
      if (!personPct) continue;
      const liabLinks: any[] = await storage.getLiabilityAssetLinksForAsset(assetId).catch(() => []);
      for (const lLink of liabLinks) {
        const assetPct = Number(lLink.ownershipPercentage ?? lLink.allocationPercentage ?? 100);
        const effectivePct = (personPct / 100) * (assetPct / 100) * 100;
        propagated.push({
          id: `propagated:${assetId}:${lLink.liabilityProfileId}`,
          liabilityProfileId: lLink.liabilityProfileId,
          partyProfileId: partyId,
          ownershipPercentage: effectivePct,
          role: "propagated",
          source: "via-asset",
          viaAssetId: assetId,
          viaAssetOwnership: personPct,
          assetAllocation: assetPct,
        });
      }
    }

    // Tag direct rows + enrich both with joined liability profile.
    const tagged = [
      ...(directRows || []).map((r: any) => ({ ...r, source: "direct" })),
      ...propagated,
    ];
    const liabIds = Array.from(new Set(tagged.map((r: any) => r.liabilityProfileId).filter(Boolean)));
    const liabById: Record<string, any> = {};
    await Promise.all(liabIds.map(async (lid: any) => {
      try {
        const p: any = await storage.getProfile(lid);
        if (p) {
          const bal = resolveLiabilityValue((p as any).fields);
          const mp = resolveMonthlyPayment((p as any).fields);
          liabById[lid] = { id: p.id, name: p.name, type: p.type, currentBalance: bal || null, monthlyPayment: mp || null };
        }
      } catch {}
    }));
    const enriched = tagged
      .filter((r: any) => r.liabilityProfileId && liabById[r.liabilityProfileId])
      .map((r: any) => ({ ...r, liability: liabById[r.liabilityProfileId] }));
    res.json(enriched);
  }));
  app.post("/api/liability-profile-links", asyncHandler(async (req, res) => {
    const parsed = insertLiabilityProfileLinkSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const [liabOwned, partyOwned] = await Promise.all([
      storage.getProfile(parsed.data.liabilityProfileId),
      storage.getProfile(parsed.data.partyProfileId),
    ]);
    if (!liabOwned || !partyOwned) return res.status(404).json({ error: "Resource not found" });
    const row = await storage.createLiabilityProfileLink(parsed.data);
    res.json(row);
  }));
  app.patch("/api/liability-profile-links/:id", asyncHandler(async (req, res) => {
    const updated = await storage.updateLiabilityProfileLink(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  }));
  app.delete("/api/liability-profile-links/:id", asyncHandler(async (req, res) => {
    const ok = await storage.deleteLiabilityProfileLink(req.params.id);
    if (!ok) return res.status(404).json({ error: "Link not found" });
    res.json({ success: true });
  }));

  // ---- Payments ----
  app.get("/api/liabilities/:id/payments", asyncHandler(async (req, res) => {
    const rows = await storage.getLiabilityPayments(req.params.id);
    res.json(rows);
  }));
  app.post("/api/liabilities/:id/payments", asyncHandler(async (req, res) => {
    // Ownership: the liability profile must belong to the requester.
    const liability = await storage.getProfile(req.params.id);
    if (!liability) return res.status(404).json({ error: "Resource not found" });
    const parsed = insertLiabilityPaymentSchema.safeParse({ ...req.body, liabilityProfileId: req.params.id });
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    // SINGLE SOURCE OF TRUTH: the server — not the client — owns the
    // principal/interest split AND the resulting balance. The client used to
    // compute these and ship them, but a field-name mismatch silently dropped
    // them to $0 and stale client balances caused drift. Compute them here from
    // the liability's own balance + APR so every reader (profile page, payment
    // history, dashboard totals, net worth, linked page) agrees.
    const balanceBefore = resolveLiabilityBalance(liability);
    const annualRate = resolveAnnualRate(liability.fields);
    const data = { ...parsed.data };
    if (balanceBefore > 0) {
      const split = allocatePayment(data.amount, balanceBefore, annualRate, data.fees ?? 0);
      data.principalPortion = split.principal;
      data.interestPortion = split.interest;
      data.fees = split.fees;
      data.remainingBalanceAfter = split.remainingBalanceAfter;
    } else {
      // No tracked balance: treat the whole payment as principal, no interest.
      data.principalPortion = data.amount;
      data.interestPortion = 0;
    }
    const row = await storage.createLiabilityPayment(data);

    // Persist the new balance back onto the liability so the rest of the app
    // reads it from one place. updateProfile deep-merges fields.
    if (balanceBefore > 0 && data.remainingBalanceAfter != null) {
      await storage.updateProfile(req.params.id, {
        fields: {
          ...(liability.fields || {}),
          currentBalance: data.remainingBalanceAfter,
          remainingBalance: data.remainingBalanceAfter,
          loanBalance: data.remainingBalanceAfter,
        },
      });
    }
    res.json(row);
  }));
  app.patch("/api/liability-payments/:id", asyncHandler(async (req, res) => {
    const row = await storage.updateLiabilityPayment(req.params.id, req.body || {});
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(row);
  }));
  app.delete("/api/liability-payments/:id", asyncHandler(async (req, res) => {
    const ok = await storage.deleteLiabilityPayment(req.params.id);
    if (!ok) return res.status(404).json({ error: "Payment not found" });
    res.json({ success: true });
  }));

  // ============================================================
  // RELATIONSHIPS — asset ↔ party links + history + move
  // ============================================================

  // Bulk GET: every asset-party link for the current user. Used by the Linked
  // tab and Dashboard to extend visibility from the legacy parent-profile rule
  // (Furniture belongs to Jane because Jane is its parent) to the co-ownership
  // rule (Furniture is ALSO Lexi's because asset_party_links shows Lexi 50%).
  // Cheap query, fully scoped by user_id by storage layer.
  app.get("/api/asset-party-links", asyncHandler(async (_req, res) => {
    const rows = await storage.getAssetPartyLinks();
    res.json(rows || []);
  }));

  // Bulk GET: every liability-party link for the current user. Same
  // motivation — a liability co-owned by Bob and Jane must surface under
  // BOTH profile filters, not just the parent.
  app.get("/api/liability-profile-links", asyncHandler(async (_req, res) => {
    const rows = await storage.getLiabilityProfileLinks();
    res.json(rows || []);
  }));

  app.get("/api/assets/:id/parties", asyncHandler(async (req, res) => {
    const rows = await storage.getAssetPartyLinks(req.params.id);
    // Enrich each link with the linked party profile's name + type so the
    // client doesn't have to make N extra requests (and can stop showing "Unknown").
    const partyIds = Array.from(new Set((rows || []).map((r: any) => r.partyProfileId).filter(Boolean)));
    const partyById: Record<string, any> = {};
    await Promise.all(partyIds.map(async (pid: any) => {
      try { const p: any = await storage.getProfile(pid); if (p) partyById[pid] = { id: p.id, name: p.name, type: p.type }; } catch {}
    }));
    const enriched = (rows || []).map((r: any) => ({ ...r, party: partyById[r.partyProfileId] || null }));
    res.json(enriched);
  }));
  app.get("/api/parties/:id/assets", asyncHandler(async (req, res) => {
    // Enrich each ownership row with the joined asset profile so the client
    // (LinkedAssetsTab / Belongings) can render real names, types, and
    // current values without an N+1 fetch. Orphan rows (asset profile was
    // deleted) are filtered out server-side so stale links can never produce
    // ghost "Asset / Asset" cards on the profile page.
    const rows = await storage.getAssetPartyLinksForParty(req.params.id);
    const assetIds = Array.from(new Set((rows || []).map((r: any) => r.assetProfileId).filter(Boolean)));
    const assetById: Record<string, any> = {};
    await Promise.all(assetIds.map(async (aid: any) => {
      try {
        const p: any = await storage.getProfile(aid);
        if (p) {
          const v = resolveAssetValue((p as any).fields);
          assetById[aid] = { id: p.id, name: p.name, type: p.type, currentValue: v || null };
        }
      } catch {}
    }));
    const enriched = (rows || [])
      .filter((r: any) => r.assetProfileId && assetById[r.assetProfileId])
      .map((r: any) => ({ ...r, asset: assetById[r.assetProfileId] }));
    res.json(enriched);
  }));
  app.post("/api/asset-party-links", asyncHandler(async (req, res) => {
    const parsed = insertAssetPartyLinkSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const [assetOwned, partyOwned] = await Promise.all([
      storage.getProfile(parsed.data.assetProfileId),
      storage.getProfile(parsed.data.partyProfileId),
    ]);
    if (!assetOwned || !partyOwned) return res.status(404).json({ error: "Resource not found" });
    const row = await storage.createAssetPartyLink(parsed.data);
    res.json(row);
  }));
  app.patch("/api/asset-party-links/:id", asyncHandler(async (req, res) => {
    const updated = await storage.updateAssetPartyLink(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  }));
  app.delete("/api/asset-party-links/:id", asyncHandler(async (req, res) => {
    const ok = await storage.deleteAssetPartyLink(req.params.id);
    if (!ok) return res.status(404).json({ error: "Link not found" });
    res.json({ success: true });
  }));
  // Atomic, validated ownership write — the single source of truth used by the
  // redesigned ownership editor. Body: { owners: [{ partyProfileId, ownershipPercentage }] }
  // An empty array clears ownership (asset reverts to Self-100%).
  app.put("/api/profiles/:id/owners", asyncHandler(async (req, res) => {
    const asset = await storage.getProfile(req.params.id);
    if (!asset) return res.status(404).json({ error: "Profile not found" });
    const owners = Array.isArray(req.body?.owners) ? req.body.owners : [];
    // Validate referenced parties exist (and aren't the asset itself).
    for (const o of owners) {
      if (!o?.partyProfileId || o.partyProfileId === req.params.id) {
        return res.status(400).json({ error: "Invalid owner reference" });
      }
      const party = await storage.getProfile(o.partyProfileId);
      if (!party) return res.status(404).json({ error: "Owner profile not found" });
    }
    try {
      const links = await storage.setAssetOwners(req.params.id, owners);
      res.json({ ownerProfileId: req.params.id, owners: links });
    } catch (e: any) {
      res.status(400).json({ error: e?.message || "Failed to set owners" });
    }
  }));

  // Atomic, validated LIABILITY ownership write — the liability analogue of
  // PUT /api/profiles/:id/owners. Body: { owners: [{ partyProfileId, ownershipPercentage }] }
  // An empty array clears ownership (liability reverts to Self-100%).
  // This is the ONLY supported way to mutate liability ownership; the
  // per-row POST /api/liability-profile-links endpoint trips the DB >100
  // guard the moment a co-owner is added on top of an existing 100% link.
  app.put("/api/profiles/:id/liability-owners", asyncHandler(async (req, res) => {
    const liability = await storage.getProfile(req.params.id);
    if (!liability) return res.status(404).json({ error: "Profile not found" });
    const owners = Array.isArray(req.body?.owners) ? req.body.owners : [];
    for (const o of owners) {
      if (!o?.partyProfileId || o.partyProfileId === req.params.id) {
        return res.status(400).json({ error: "Invalid owner reference" });
      }
      const party = await storage.getProfile(o.partyProfileId);
      if (!party) return res.status(404).json({ error: "Owner profile not found" });
    }
    try {
      const links = await storage.setLiabilityOwners(req.params.id, owners);
      res.json({ liabilityProfileId: req.params.id, owners: links });
    } catch (e: any) {
      res.status(400).json({ error: e?.message || "Failed to set owners" });
    }
  }));

  // Ownership history
  app.get("/api/ownership-history", asyncHandler(async (req, res) => {
    const subjectId = (req.query.subjectId as string) || undefined;
    const counterpartyId = (req.query.counterpartyId as string) || undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 200;
    const rows = await storage.getOwnershipHistory({ subjectId, counterpartyId, limit });
    res.json(rows);
  }));
  app.delete("/api/ownership-history/:id", asyncHandler(async (req, res) => {
    const ok = await storage.deleteOwnershipHistoryEntry(req.params.id);
    if (!ok) return res.status(404).json({ error: "History entry not found" });
    res.json({ success: true });
  }));

  // Atomic move: move a liability_asset_link to a different asset (preserves link id and history chain)
  app.post("/api/relationships/move-liability", asyncHandler(async (req, res) => {
    const { linkId, toAssetId, note } = req.body || {};
    if (!linkId || !toAssetId) return res.status(400).json({ error: "linkId and toAssetId required" });
    // Ownership: the destination asset profile must belong to the requester.
    const dest = await storage.getProfile(toAssetId);
    if (!dest) return res.status(404).json({ error: "Resource not found" });
    const updated = await storage.updateLiabilityAssetLink(linkId, { assetProfileId: toAssetId } as any);
    if (!updated) return res.status(404).json({ error: "Link not found" });
    if (note) {
      try {
        await storage.recordOwnershipHistory({
          linkKind: "liability_asset", linkId,
          subjectId: updated.liabilityProfileId, counterpartyId: updated.assetProfileId,
          action: "move", fieldChanged: "asset_profile_id", oldValue: null, newValue: toAssetId,
          changedBy: "user", note,
        });
      } catch (err) { console.error("[routes:move-liability] failed to record ownership history:", err); }
    }
    res.json(updated);
  }));

  // Aggregate "relationships graph" for a profile — 1 or 2 hops
  app.get("/api/relationships/graph/:id", asyncHandler(async (req, res) => {
    const id = req.params.id;
    const hops = Math.max(1, Math.min(2, Number(req.query.hops) || 1));
    const visited = new Set<string>([id]);
    const nodes: any[] = [];
    const edges: any[] = [];

    const getProfile = async (pid: string) => {
      try {
        const p = await storage.getProfile?.(pid);
        return p || null;
      } catch { return null; }
    };

    const expand = async (pid: string, depth: number) => {
      if (depth > hops) return;
      const prof: any = await getProfile(pid);
      if (prof && !nodes.find(n => n.id === pid)) {
        nodes.push({ id: pid, name: prof.name, type: prof.type, typeKey: prof.type_key || prof.typeKey });
      }
      // collect links from all 3 link tables involving this profile
      const [liabAssets, liabPartiesAsLiab, liabPartiesAsParty, assetParties, assetPartiesAsParty, liabAssetsAsAsset] = await Promise.all([
        storage.getLiabilityAssetLinks(pid).catch(() => []),
        storage.getLiabilityProfileLinks(pid).catch(() => []),
        storage.getLiabilityProfileLinksForParty(pid).catch(() => []),
        storage.getAssetPartyLinks(pid).catch(() => []),
        storage.getAssetPartyLinksForParty(pid).catch(() => []),
        storage.getLiabilityAssetLinksForAsset(pid).catch(() => []),
      ]);
      const pushEdge = (kind: string, fromId: string, toId: string, role: string, pct: number, linkId: string) => {
        edges.push({ kind, from: fromId, to: toId, role, ownershipPercentage: pct, linkId });
      };
      for (const l of liabAssets) {
        pushEdge("liability_asset", l.liabilityProfileId, l.assetProfileId, l.role, l.ownershipPercentage, l.id);
        if (!visited.has(l.assetProfileId)) { visited.add(l.assetProfileId); await expand(l.assetProfileId, depth + 1); }
      }
      for (const l of liabAssetsAsAsset) {
        pushEdge("liability_asset", l.liabilityProfileId, l.assetProfileId, l.role, l.ownershipPercentage, l.id);
        if (!visited.has(l.liabilityProfileId)) { visited.add(l.liabilityProfileId); await expand(l.liabilityProfileId, depth + 1); }
      }
      for (const l of liabPartiesAsLiab) {
        pushEdge("liability_party", l.liabilityProfileId, l.partyProfileId, l.role, l.ownershipPercentage, l.id);
        if (!visited.has(l.partyProfileId)) { visited.add(l.partyProfileId); await expand(l.partyProfileId, depth + 1); }
      }
      for (const l of liabPartiesAsParty) {
        pushEdge("liability_party", l.liabilityProfileId, l.partyProfileId, l.role, l.ownershipPercentage, l.id);
        if (!visited.has(l.liabilityProfileId)) { visited.add(l.liabilityProfileId); await expand(l.liabilityProfileId, depth + 1); }
      }
      for (const l of assetParties) {
        pushEdge("asset_party", l.assetProfileId, l.partyProfileId, l.role, l.ownershipPercentage, l.id);
        if (!visited.has(l.partyProfileId)) { visited.add(l.partyProfileId); await expand(l.partyProfileId, depth + 1); }
      }
      for (const l of assetPartiesAsParty) {
        pushEdge("asset_party", l.assetProfileId, l.partyProfileId, l.role, l.ownershipPercentage, l.id);
        if (!visited.has(l.assetProfileId)) { visited.add(l.assetProfileId); await expand(l.assetProfileId, depth + 1); }
      }
    };

    await expand(id, 0);
    // dedupe edges
    const seen = new Set<string>();
    const uniqEdges = edges.filter(e => {
      const k = `${e.kind}:${e.linkId}`;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    res.json({ rootId: id, nodes, edges: uniqEdges });
  }));

  // ============================================================
  // Universal Captures (PR Y) — inbox for any data type
  // ============================================================
  app.get("/api/captures", asyncHandler(async (req, res) => {
    if (!storage.getCaptures) return res.json([]);
    const status = req.query.status ? String(req.query.status) : undefined;
    const ownerProfileId = req.query.ownerProfileId ? String(req.query.ownerProfileId) : undefined;
    const limit = req.query.limit ? Math.min(500, Number(req.query.limit)) : 100;
    const captures = await storage.getCaptures({ status, ownerProfileId, limit });
    res.json(captures);
  }));

  app.post("/api/captures", asyncHandler(async (req, res) => {
    if (!storage.createCapture) return res.status(501).json({ error: "Captures not supported by this storage backend" });
    const { insertCaptureSchema } = await import("@shared/schema");
    const parsed = insertCaptureSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: "Invalid capture", details: parsed.error.flatten() });
    // Default ownerProfileId to self when missing/null.
    let ownerProfileId = parsed.data.ownerProfileId ?? null;
    if (!ownerProfileId) {
      const self = await storage.getSelfProfile?.();
      if (self) ownerProfileId = self.id;
    }
    const capture = await storage.createCapture({ ...parsed.data, ownerProfileId });
    res.json(capture);
  }));

  app.get("/api/captures/:id", asyncHandler(async (req, res) => {
    if (!storage.getCapture) return res.status(404).json({ error: "Not found" });
    const c = await storage.getCapture(req.params.id);
    if (!c) return res.status(404).json({ error: "Not found" });
    res.json(c);
  }));

  app.patch("/api/captures/:id", asyncHandler(async (req, res) => {
    if (!storage.updateCapture) return res.status(501).json({ error: "Captures not supported" });
    const updated = await storage.updateCapture(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  }));

  app.delete("/api/captures/:id", asyncHandler(async (req, res) => {
    if (!storage.deleteCapture) return res.status(501).json({ error: "Captures not supported" });
    const ok = await storage.deleteCapture(req.params.id);
    if (!ok) return res.status(404).json({ error: "Not found" });
    res.json({ deleted: true });
  }));

  // Global async error handler — catches unhandled promise rejections from route handlers
  app.use((err: any, _req: any, res: any, _next: any) => {
    console.error(`[API Error]`, err?.message || err);
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message || "Internal server error" });
    }
  });

  return httpServer;
}

