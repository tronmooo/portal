import express, { type Express, type Request } from "express";
import { canonicalExpenseCategory, canonicalObligationCategory, EXPENSE_CATEGORIES } from "@shared/category-canon";
import { createServer, type Server } from "http";
import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { execFile } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);
import { getUserToday, getUserCurrentMonth, toLocalDateStr, parseLocalDate, parseUserDateTime, DEFAULT_TIMEZONE } from "@shared/timezone";
import { completeHabitOccurrence } from "./habit-completion";
import { canonicalTimelineWindow } from "@shared/calendar-window";
import { passesProfileFilter } from "@shared/profile-filter";
import { detectMoodFromText } from "@shared/mood-detect";
import { computeKeyFindings } from "@shared/tracker-insights";
import { ownedAssetIds } from "@shared/cost-of-ownership";
import { buildOwnerIndex, itemVisibleForSelection, type OwnershipRecord } from "@shared/ownership-model";
import { ASSET_PROFILE_TYPES, LIABILITY_PROFILE_TYPES, resolveLiabilityBalance } from "@shared/asset-value";
import { summarizeAccounts, isAccountProfile } from "@shared/finance-accounts";
import { allocatePayment, resolveAnnualRate } from "@shared/liability-calc";
import { isRecurringBill } from "@shared/liability-types";
import { advanceLiabilityDueDate, readDueDate } from "@shared/liability-recurrence";
import { generateSchedule, liabilityAmount, liabilityFrequency } from "@shared/liability-schedule";
import { isRecurringBill as isRecurringBillType } from "@shared/liability-types";
import { selfIdsFrom } from "@shared/scope";
import { validateFinanceImport } from "@shared/finance-import-schema";
import { findBlockingDuplicateProfile } from "@shared/profile-dedup";
import { buildImportPrompt, planImport, applyImport, undoImport } from "./finance-import";
import { registerCacheBuster } from "./cache-bus";
import { registerFinanceRoutes } from "./finance-routes";
import { HIDDEN_TRACKER_CATEGORIES } from "@shared/hidden-tracker-categories";
import { normalizeDateString } from "@shared/extraction-normalize";
import { canonicalizeProfileFields, looselyEqual } from "@shared/profile-field-canon";
import { normalizeEntityDateFields, classifyDateField, normalizeFieldKey, bareDateOf, rulesFromAll, rulesFromSeries, dedupeRules, type DateRule } from "@shared/date-rules";
import { seriesFromAll } from "@shared/calendar-adapters";
import { fieldIdentity, PROFILE_FIELD_GROUPS, cleanupStoredProfileFields, mergeFieldWrite, fieldValuePersisted, removeDocumentContributedFields } from "@shared/profile-field-identity";

/** Extract user timezone from request header, with fallback */
function getTimezone(req: Request): string {
  return (req.headers['x-timezone'] as string) || DEFAULT_TIMEZONE;
}

/** The caller's active profile selection (the scope chip they can see). */
function activeProfileIds(req: Request): string[] {
  return parseActiveProfileIds(req.headers[ACTIVE_PROFILE_HEADER] as string | undefined);
}

/**
 * Enforce the profile-isolation invariant on a create body: a record created
 * while exactly one profile is in scope belongs to that profile.
 *
 * Mutates `body` in place (routes hand their `req.body` straight to Zod) and
 * returns it. Only fills in an owner the request left blank — an explicitly
 * chosen owner always wins. See shared/active-scope.ts for the reasoning.
 *
 * `field` is the entity's owner column: `linkedProfiles` (array) on expenses /
 * incomes / obligations / tasks / events.
 */
function applyActiveProfileScope(
  req: Request,
  body: any,
  field: "linkedProfiles" | "profileId" = "linkedProfiles",
): any {
  if (!body || typeof body !== "object") return body;
  const active = activeProfileIds(req);
  if (active.length === 0) return body;
  if (field === "profileId") {
    if (typeof body.profileId === "string" && body.profileId) return body;
    const owner = resolveCreateOwnerIds([], active);
    if (owner.length === 1) body.profileId = owner[0];
    return body;
  }
  const explicit = Array.isArray(body.linkedProfiles) ? body.linkedProfiles.filter(Boolean) : [];
  const owners = resolveCreateOwnerIds(explicit, active);
  if (owners.length > 0) body.linkedProfiles = owners;
  return body;
}

// Augment Express Request with auth middleware userId
interface AuthenticatedRequest extends Request {
  userId?: string;
}
import { storage } from "./storage";
import { resolveAssetValue, resolveLiabilityValue, resolveMonthlyPayment } from "./supabase-storage";
import { computeAiSensitiveStripKeys, deepStripKeys } from "./ai-summary-sanitizer";
import { buildNotifications } from "./notification-service";
import {
  createNote, updateNote, deleteNote, listNotes,
  upsertJournalEntry, syncDateRulesForEntity,
} from "./content-service";
import {
  beginMutationContext, runMutation, mutationsHeaderValue, noteWriteMutations,
  WRITE_MUTATIONS_HEADER,
} from "./mutation-outcome";
import { createExpenseRecord } from "./actions/expense-service";
import { prepareTrackerEntryValues, logPreparedEntry } from "./actions/tracker-entry-service";
import { createEventRecord } from "./actions/event-service";
import { inferExpenseCategory } from "@shared/expense-canon";

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
  // Obligations retired (2026-07): a liability IS its own bill now — there is no
  // separate obligation to sync, and `linked_obligation_id` was dropped. No-op.
  if (profileId) return;
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
import type { TextTransformCommand } from "./ai-engine";
import type { SmartFillSource, FillFieldInput } from "./smart-fill";

// ── [PERF 2026-07-31 cold-start] Lazy AI module graph ───────────────────────
// ai-engine (923KB of TS) + smart-fill + ai-decide + weekly-review +
// anthropic-client all transitively pull @anthropic-ai/sdk. Importing them
// statically put the ENTIRE AI stack in the read function's cold-start parse/
// evaluate path — api/index.js (which serves /api/dashboard-bootstrap,
// /api/stats, the calendar…) booted the same bytes as the AI function, so the
// Phase-5.2 function split never reduced cold cost. These proxies keep the
// exact names and call signatures of the static imports they replace (so call
// sites are untouched) but load the module graph on FIRST AI USE only —
// esbuild code-splitting (script/build-vercel.ts `splitting: true`) then
// carves the AI stack into chunks the read path never evaluates.
// Sync-return exceptions (getActionLog, getAnthropicClient) become async and
// their few call sites await them.
type AiEngineMod = typeof import("./ai-engine");
const aiEngineMod = (): Promise<AiEngineMod> => import("./ai-engine");

/** Projection identity for a chat action — the id that links a Capture to the
 *  typed row the action produced. `documentId` MUST be in the fallback chain:
 *  the doc-open fast path emits `{ type: "retrieve", data: { documentId } }`
 *  and nothing else, and its absence made projections empty for every document
 *  open — which flipped the capture block into its blocking branch and put a
 *  2-second classifier wait on the fastest reply in the app. */
export function projectionIdOf(a: any): string {
  return String(a?.data?.id || a?.id || a?.data?.documentId || a?.data?.trackerName || a?.data?.name || "");
}

// Cold-start marker for the [chat-timing] log line: true for the first chat
// turn this instance serves, false after — lets production logs separate
// cold-start latency from steady-state latency at a glance.
let chatServedOnce = false;
const processMessage: AiEngineMod["processMessage"] =
  ((...a: any[]) => aiEngineMod().then((m: any) => m.processMessage(...a))) as any;
const processFileUpload: AiEngineMod["processFileUpload"] =
  ((...a: any[]) => aiEngineMod().then((m: any) => m.processFileUpload(...a))) as any;
const transformText: AiEngineMod["transformText"] =
  ((...a: any[]) => aiEngineMod().then((m: any) => m.transformText(...a))) as any;
const extractReceipt: AiEngineMod["extractReceipt"] =
  ((...a: any[]) => aiEngineMod().then((m: any) => m.extractReceipt(...a))) as any;
const estimateAssetValue: AiEngineMod["estimateAssetValue"] =
  ((...a: any[]) => aiEngineMod().then((m: any) => m.estimateAssetValue(...a))) as any;
const classifyCapture: AiEngineMod["classifyCapture"] =
  ((...a: any[]) => aiEngineMod().then((m: any) => m.classifyCapture(...a))) as any;
const reextractDocument: AiEngineMod["reextractDocument"] =
  ((...a: any[]) => aiEngineMod().then((m: any) => m.reextractDocument(...a))) as any;
// getActionLog is synchronous in ai-engine; the lazy proxy is necessarily
// async — its single call site awaits it.
const getActionLog = (async (...a: any[]) =>
  (aiEngineMod().then((m: any) => m.getActionLog(...a)))) as
  (...a: Parameters<AiEngineMod["getActionLog"]>) => Promise<ReturnType<AiEngineMod["getActionLog"]>>;

type SmartFillMod = typeof import("./smart-fill");
const smartFillMod = (): Promise<SmartFillMod> => import("./smart-fill");
const analyzeSmartFill: SmartFillMod["analyzeSmartFill"] =
  ((...a: any[]) => smartFillMod().then((m: any) => m.analyzeSmartFill(...a))) as any;
const renderFilledPdf: SmartFillMod["renderFilledPdf"] =
  ((...a: any[]) => smartFillMod().then((m: any) => m.renderFilledPdf(...a))) as any;

type AiDecideMod = typeof import("./ai-decide");
const aiDecideMod = (): Promise<AiDecideMod> => import("./ai-decide");
const aiDecide: AiDecideMod["aiDecide"] =
  ((...a: any[]) => aiDecideMod().then((m: any) => m.aiDecide(...a))) as any;
const aiPickIndex: AiDecideMod["aiPickIndex"] =
  ((...a: any[]) => aiDecideMod().then((m: any) => m.aiPickIndex(...a))) as any;

// ── Wave 2 #6: AI-suggested obligation auto-sync for subscriptions/insurance ──
// Mirrors syncLiabilityObligation but for non-liability recurring-bill profiles.
// Uses AI to decide if the profile's fields warrant a recurring obligation
// (e.g. monthly subscription with a price) so we don't create junk obligations
// for one-off purchases or already-paid items.
async function syncAiSuggestedObligation(profileId: string): Promise<void> {
  // Obligations retired: subscription/utility profiles no longer spawn a backing
  // obligation. Recurring-bill liabilities carry their own recurrence. No-op.
  if (profileId) return;
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
// weekly-review + anthropic-client pull @anthropic-ai/sdk — lazy, same-name
// proxies as the ai-engine block above. (The bare `Anthropic` default import
// that used to sit here was entirely unused.) getAnthropicClient is sync in
// its module; the proxy is async and its call sites await it.
type WeeklyReviewMod = typeof import("./weekly-review");
const weeklyReviewMod = (): Promise<WeeklyReviewMod> => import("./weekly-review");
const generateWeeklyReview: WeeklyReviewMod["generateWeeklyReview"] =
  ((...a: any[]) => weeklyReviewMod().then((m: any) => m.generateWeeklyReview(...a))) as any;
const detectAnomalies: WeeklyReviewMod["detectAnomalies"] =
  ((...a: any[]) => weeklyReviewMod().then((m: any) => m.detectAnomalies(...a))) as any;
type AnthropicClientMod = typeof import("./anthropic-client");
const getAnthropicClient = (async () =>
  (await import("./anthropic-client")).getAnthropicClient()) as
  () => Promise<ReturnType<AnthropicClientMod["getAnthropicClient"]>>;
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
import { validateTransactionAmount } from "@shared/quick-add";
import { ACTIVE_PROFILE_HEADER, parseActiveProfileIds, resolveCreateOwnerIds } from "@shared/active-scope";
import { generateSmartInsights } from "./insights-engine";
import { requireAdmin, resolveUserFromRequest } from "./auth";

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
// on instance A does NOT bust it on instance B.
//
// HISTORY: that staleness ("deleted items still show up") originally forced
// the cache OFF on Vercel entirely — which silently made EVERY dashboard/
// stats/bootstrap request a full ~10-20-query Supabase aggregation in prod
// (profile switches took 3-6s; user report 2026-07-16 "why does everything
// take so long"). The cross-instance coherence problem has since been solved
// properly by migration 010: every per-user cache key embeds the user's DATA
// VERSION via cacheUserKey() (bumped by the write middleware on any write,
// resolved per-GET below), so a write on ANY instance changes the key every
// other instance computes within ~2s — stale entries stop being addressable.
// With that in place the cache is safe (and essential) in production.
// Emergency escape hatch: set DISABLE_RESPONSE_CACHE=1.
const CACHE_ENABLED = !process.env.DISABLE_RESPONSE_CACHE;
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
/**
 * Bump the user's data version and WAIT for it.
 *
 * The fire-and-forget bump (used by the write middleware, where a pre-handler
 * bump already covers the request) is not enough for AI chat: the chat reply is
 * the client's cue to refetch, so if the bump is still in flight when the reply
 * lands, the refetch computes the PRE-write cache key and is served pre-write
 * data — which React Query then stores as fresh for a full staleTime. That is
 * the "AI said it saved it, the page doesn't show it until I refresh" bug.
 * Awaiting this before sending the reply makes the response a read-your-writes
 * barrier.
 *
 * Returns the new version so it can be handed to the client as a token (see
 * DATA_VERSION_HEADER below); undefined if the storage can't report one, in
 * which case callers fall back to today's behavior.
 */
export async function bumpDataVersionNow(uid: string): Promise<number | undefined> {
  versionMemo.delete(uid);
  try {
    const raw = await (storage as any).bumpDataVersion?.();
    const v = Number(raw);
    if (Number.isFinite(v) && v > 0) {
      versionMemo.set(uid, { v, at: Date.now() });
      return v;
    }
  } catch { /* the next GET resolves the version from the DB */ }
  return undefined;
}

/**
 * Read-your-writes token. A client that has just been told "saved" sends the
 * data version it was given on every subsequent GET; this instance then uses
 * max(its own memo, the client's token) to build the cache key.
 *
 * Awaiting the bump (above) alone does NOT close the window: the response cache
 * is per-instance and each instance memoizes the version for VERSION_MEMO_MS,
 * so a GET landing on a DIFFERENT warm instance within ~2s still computes the
 * pre-write key. The token makes that instance compute the post-write key
 * regardless of what its own memo says.
 */
export const DATA_VERSION_HEADER = "x-data-version";
// A client token can only ever move the key FORWARD, and only within a sane
// distance of the version we know about — so a buggy or hostile value costs
// that one user some cache misses and nothing else. Keys are per-user, so no
// other account can be affected.
const MAX_VERSION_LOOKAHEAD = 1000;
export function resolveDataVersion(memoVersion: number, headerValue: unknown): number {
  const raw = Number(Array.isArray(headerValue) ? headerValue[0] : headerValue);
  if (!Number.isFinite(raw) || raw <= memoVersion) return memoVersion;
  return Math.min(Math.floor(raw), memoVersion + MAX_VERSION_LOOKAHEAD);
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

// ── Shared (cross-instance) response cache — Postgres-backed ───────────────
// The Map above is per serverless instance: N warm instances = N cold caches,
// and Vercel sprays one app-open's requests across instances, so the KeepAlive
// warmth of instance A never helped the request that landed on instance B.
// For the handful of EXPENSIVE aggregation keys below, misses fall through to
// one indexed read of the `response_cache` table (~10-50ms) instead of a
// ~15-query recompute (1-5s cold). Writes are fire-and-forget upserts.
//
// Correctness: only version-stamped keys (containing "@v") are eligible — a
// write bumps the user's data version, so every stale row simply stops being
// addressable (same scheme the in-memory cache already relies on across
// instances). Rows are best-effort garbage: expired entries are deleted on the
// user's next write and swept by the daily cron.
//
// Rollout: on by default, SHARED_RESPONSE_CACHE=0 disables; degrades to
// memory-only automatically when the table doesn't exist yet (first deploy
// before the migration runs).
// PERF (2026-08-17): expenses/trackers/obligations/incomes added — the
// Finance and Assets tabs GATE their whole page on /api/expenses and
// /api/trackers, which were the only hot keys still per-instance. The KPI
// pills (stats:/enhanced:) were shared and fast while the tab-gating keys
// recomputed cold on whichever instance caught them — the visible asymmetry
// behind "pills load, tab spins". Keys are version-stamped (@v), so a write
// invalidates shared rows exactly like the in-memory tier.
const SHARED_CACHE_PREFIXES = ["bootstrap:", "stats:", "enhanced:", "caltimeline:", "expenses:", "trackers:", "obligations:", "incomes:"];
let sharedCacheBroken = false; // latched when the table is missing/unreachable
const SHARED_CACHE_ENABLED = () =>
  CACHE_ENABLED && !sharedCacheBroken &&
  process.env.SHARED_RESPONSE_CACHE !== "0" && process.env.SHARED_RESPONSE_CACHE !== "false";
function sharedCacheEligible(key: string): boolean {
  return SHARED_CACHE_ENABLED() && key.includes("@v") &&
    SHARED_CACHE_PREFIXES.some((p) => key.startsWith(p));
}
function latchSharedCacheError(err: any): void {
  // 42P01 = undefined_table. Anything else is transient — keep trying.
  const code = err?.code || err?.details?.code;
  if (code === "42P01" || /response_cache.*does not exist/i.test(String(err?.message || ""))) {
    sharedCacheBroken = true;
    console.warn("[shared-cache] response_cache table missing — falling back to per-instance cache. Run migrations/20260731_response_cache.sql.");
  }
}
/** In-memory hit, else one Postgres read for the whitelisted expensive keys. */
async function getCachedShared(key: string): Promise<any | null> {
  const mem = getCached(key);
  if (mem !== null) return mem;
  if (!sharedCacheEligible(key)) return null;
  try {
    const hit = await (storage as any).getResponseCache?.(key);
    if (hit !== null && hit !== undefined) {
      // Hydrate this instance briefly so repeat hits skip even the one read.
      responseCache.set(key, { data: hit, expiresAt: Date.now() + 15_000 });
      return hit;
    }
  } catch (err) {
    latchSharedCacheError(err);
  }
  return null;
}
// Expired entries are otherwise only dropped when something reads or busts
// their exact key — and version-stamped keys are never read again after a
// write, so they would sit in memory holding whole tables (the `bootstrap-raw:`
// and `insights-data:` snapshots are the heavy ones). Sweep them on a write,
// throttled so a busy instance pays it at most once a minute.
const CACHE_SWEEP_INTERVAL_MS = 60_000;
let lastCacheSweepAt = 0;
function sweepExpiredCache(now: number): void {
  if (now - lastCacheSweepAt < CACHE_SWEEP_INTERVAL_MS) return;
  lastCacheSweepAt = now;
  for (const [key, entry] of responseCache) {
    if (now >= entry.expiresAt) responseCache.delete(key);
  }
}
function setCache(key: string, data: any, ttlMs: number = 10000): void {
  if (!CACHE_ENABLED) return;
  const now = Date.now();
  sweepExpiredCache(now);
  responseCache.set(key, { data, expiresAt: now + ttlMs });
  if (sharedCacheEligible(key)) {
    // Fire-and-forget: never block the response on the cache write. If the
    // instance freezes before it lands, the next instance just recomputes.
    try {
      Promise.resolve((storage as any).setResponseCache?.(key, data, ttlMs))
        .catch((err: any) => latchSharedCacheError(err));
    } catch { /* ignore */ }
  }
}
// Clear ALL cached responses — call after any data mutation
function clearAllCache(): void {
  responseCache.clear();
}

// Every per-user TTL cache-key prefix (non-version-stamped). Version-stamped
// keys self-invalidate via the DB data-version bump, so they are NOT listed
// here. Kept in sync with the write-bust middleware's inline list; INCLUDES
// bootstrap/profile-bootstrap which that list omits (they were only ever
// cleared by the global wipe this scoped bust replaces).
const USER_CACHE_PREFIXES = [
  "stats:", "enhanced:", "bootstrap:", "bootstrap-raw:", "profile-bootstrap:", "profile-detail:",
  "profiles:", "trackers:", "tasks:", "expenses:", "events:", "habits:",
  "obligations:", "journal:", "documents:", "goals:", "insights:",
  "insights-data:", "activity:", "ai-digest:", "artifacts:", "notifications:",
  "cashflow:", "calendar:",
  // The calendar timeline's key prefix is "caltimeline:", not "calendar:", so
  // it matched nothing in this list and no write ever busted it on the writing
  // instance. Version-stamped keys made that survivable (a write bumps the
  // version and the stale entry stops being addressable) but only after the
  // 2s version memo expires — the "it took a while for the deletion to show
  // up" window. Same-instance busting closes it immediately.
  "caltimeline:",
  // Same gap as caltimeline above: these three are cached by their GET routes
  // but were missing here, so only the per-route inline busts (now removed)
  // covered them — and only on their own routes. Listed so every write closes
  // their 2s memo window too. (aisummary:/profile_ai_ are deliberately absent:
  // long-TTL AI summaries that must survive ordinary writes.)
  "paychecks:", "incomes:", "profiles-lite:",
];

// Scoped cache-bust: drop only the MUTATING user's cached responses instead of
// wiping every user's cache on the warm instance (the old clearAllCache did the
// latter, so one write cold-started the 60s stats/enhanced/bootstrap caches for
// everyone). Per-user only — all cached data is per-user, so there is nothing
// shared to invalidate across users.
const sharedCacheCleanupAt = new Map<string, number>();
function bustUserCaches(uid: string): void {
  for (const prefix of USER_CACHE_PREFIXES) bustCache(`${prefix}${uid}`);
  // Piggyback shared-cache hygiene on writes: version-stamped rows go stale by
  // key, so this only needs to DELETE EXPIRED rows, throttled to once/min per
  // user per instance. Fire-and-forget — a write must never wait on cleanup.
  if (SHARED_CACHE_ENABLED()) {
    const last = sharedCacheCleanupAt.get(uid) || 0;
    if (Date.now() - last > 60_000) {
      sharedCacheCleanupAt.set(uid, Date.now());
      if (sharedCacheCleanupAt.size > 5000) sharedCacheCleanupAt.clear();
      try {
        Promise.resolve((storage as any).cleanupResponseCache?.()).catch(() => {});
      } catch { /* ignore */ }
    }
  }
}
// Let AI tools (refresh_dashboard) bust this module-private cache without a
// circular routes↔ai-engine import — see server/cache-bus.ts.
registerCacheBuster(bustUserCaches);

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

// Read-only POST endpoints: they use POST for a request body (AI generators,
// analyzers, error beacons) but never WRITE user data, so they must NOT bust the
// per-user response cache. Busting on these (e.g. every /api/ai/summary scope
// switch) needlessly cold-started the 60s stats/enhanced/bootstrap caches — the
// exact "app feels slow after using AI" symptom. Verified read-only by handler
// inspection (2026-07-17): none call storage.create/update/delete/insert.
// NOTE: any POST that DOES mutate (smart-fill/render, weekly-review/generate,
// finance-import/commit, chat, upload, …) is intentionally absent so it still busts.
const READONLY_POST_PATHS = new Set<string>([
  "/api/ai/summary",
  "/api/ai-transform",
  "/api/receipt-extract",
  "/api/client-errors",
  "/api/smart-fill/analyze",
  "/api/wellness/insights",
  "/api/finance-import/prompt",
  "/api/finance-import/preview",
]);
function isReadOnlyPost(req: any): boolean {
  return req.method === "POST" && READONLY_POST_PATHS.has(req.path);
}

// Pure predicate (exported for tests): does a request mutate user data and thus
// need the per-user response cache busted? True for every non-idempotent method
// and the AI-tool mutators (chat/upload), EXCEPT the read-only POST allowlist.
export function shouldBustCaches(method: string, path: string): boolean {
  const req = { method, path };
  const isMutation = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  const isAiMutator = path === "/api/chat" || path.startsWith("/api/upload") || path === "/api/chat/confirm-extraction";
  return (isMutation || isAiMutator) && !isReadOnlyPost(req);
}

// Middleware: clear server cache on ANY mutation (POST/PATCH/PUT/DELETE)
// This ensures deleted documents, updated profiles, etc. are immediately reflected.
//
// Bug fix: previously this only fired on res.on('finish'), which races with the
// client's onSuccess invalidateAll() that fires GET /api/profiles immediately —
// the GET could return stale cache before 'finish' cleared it. Now we ALSO bust
// caches synchronously BEFORE handing control to the route for chat/upload paths
// that mutate data via internal AI tool calls (not just direct REST writes).
// ── Read-your-writes barrier for the AI-adjacent write routes ──────────────
// Like /api/chat (which does this inline), these endpoints write via internal
// AI tool calls and their RESPONSE is what tells the client to refetch. The
// generic write middleware bumps the data version pre-handler (before the
// writes land) and again on 'finish' (after the response is on the wire), so
// neither bump is ordered against the client's refetch — it could be served a
// pre-write cache entry and store it as fresh for a full staleTime.
//
// This wraps res.json so a successful response is not sent until the version
// bump has completed, and carries the new version back as the client's
// read-your-writes token.
const AI_WRITE_BARRIER_PATHS = new Set([
  "/api/upload",
  "/api/upload/batch",
  "/api/chat/confirm-extraction",
  "/api/smart-fill/render",
]);

/**
 * Read-your-writes barrier for EVERY write, not just the AI ones.
 *
 * The response to a write is what tells the client to refetch. If the data
 * version has not been bumped by the time that response is on the wire, the
 * refetch computes the PRE-write cache key, and any instance holding an entry
 * under that key answers with pre-write data — the deleted row comes back, the
 * new row is missing, and React Query stores that answer as fresh for a full
 * staleTime. Chat has been ordered correctly for a while; ordinary writes made
 * from the interface — every add, edit and delete — were not, which is why they
 * still lagged and why a delete took time to propagate across screens.
 *
 * The bump is not extra work: the write middleware already issued one on
 * 'finish'. This moves it before the response and awaits it, and hands the new
 * version back as `X-Data-Version` so other instances (whose own memo may still
 * be pre-write for up to VERSION_MEMO_MS) compute the post-write key too.
 *
 * A header rather than a body field, deliberately: it works for every route
 * regardless of what shape its response has, including deletes that return no
 * JSON at all.
 */
function writeBarrierMiddleware(req: any, res: any, next: any) {
  const method = String(req.method || "").toUpperCase();
  const isWrite = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  const isAiWrite = method === "POST" && AI_WRITE_BARRIER_PATHS.has(req.path);
  if (!isWrite && !isAiWrite) return next();
  // Read-only POST generators must not pay for a barrier they do not need.
  if (isReadOnlyPost(req)) return next();
  const uid = (req as AuthenticatedRequest).userId;
  if (!uid) return next();
  // /api/chat runs the barrier inline (it must land before the SSE `final`
  // frame, which never goes through res.json).
  if (req.path === "/api/chat") return next();

  let barrierDone = false;
  const settle = (send: () => void, body: any) => {
    if (barrierDone || res.statusCode >= 400) { send(); return; }
    barrierDone = true;
    // Handlers that ran their write through runMutation (server/
    // mutation-outcome.ts) recorded an authoritative change manifest; carry it
    // to the client so write-sync patches caches from server truth instead of
    // inferring from the request shape.
    try {
      const manifest = mutationsHeaderValue(res.locals?.writeMutations);
      if (manifest) res.setHeader(WRITE_MUTATIONS_HEADER, manifest);
    } catch { /* the manifest is an optimization — never block the response */ }
    bustUserCaches(uid);
    Promise.resolve(bumpDataVersionNow(uid))
      .then((v) => {
        if (v === undefined) return;
        try { res.setHeader(DATA_VERSION_HEADER, String(v)); } catch { /* headers already sent */ }
        // The AI write routes also carry it in the body, which their clients
        // already read; keep that contract.
        if (isAiWrite && body && typeof body === "object" && !Array.isArray(body)) {
          try { (body as any).dataVersion = v; } catch { /* frozen body */ }
        }
      })
      .catch(() => { /* fall through: the client keeps its old behavior */ })
      .finally(send);
  };

  const sendJson = res.json.bind(res);
  res.json = (body: any) => {
    settle(() => sendJson(body), body);
    return res;
  };
  const sendStatus = res.sendStatus.bind(res);
  res.sendStatus = (code: number) => {
    settle(() => sendStatus(code), null);
    return res;
  };
  next();
}

function cacheBustMiddleware(req: any, res: any, next: any) {
  // Read-only POST generators/analyzers never write data — skip the bust so an
  // AI summary or receipt scan can't cold-start every other user-scoped cache.
  if (shouldBustCaches(req.method, req.path)) {
    // Bust BEFORE the handler runs as well as on finish. The pre-handler bust
    // prevents a GET racing mid-handler from re-caching pre-write data; the
    // finish bust catches long writes (AI chat) that mutate during the handler.
    //
    // PERF (2026-07): scope the bust to the MUTATING user instead of
    // clearAllCache()'s global wipe — a single write used to cold-start the 60s
    // stats/enhanced/bootstrap caches for every user on the warm instance. All
    // cached data is per-user, so there is nothing shared to clear. authMiddleware
    // runs before this (index.ts), so req.userId is populated on /api writes; the
    // rare no-user case (unauthenticated mutating path) falls back to a full clear.
    //
    // PERF (2026-08-17): /api/chat busts only when the turn actually MUTATED —
    // the handler sets res.locals.chatMutated after inspecting the turn's
    // actions. A read-only turn ("open my drivers license") used to cold-start
    // every user-scoped cache pre-handler AND on finish, twice per message.
    const uid = (req as any).userId as string | undefined;
    const chatGated = req.path === "/api/chat";
    if (!chatGated) {
      if (uid) bustUserCaches(uid); else clearAllCache();
    }
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 400) {
        if (chatGated && !(res as any).locals?.chatMutated) return;
        if (uid) bustUserCaches(uid); else clearAllCache();
      }
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
  const p = fn().finally(() => {
    inFlight.delete(key);
    clearTimeout(watchdog);
  });
  inFlight.set(key, p);
  // Watchdog (stuck-skeleton fix, 2026-07-16): the map is module-scoped and
  // survives across requests on a warm instance. If fn() hangs without ever
  // settling (an upstream Supabase call with no timeout), .finally never runs
  // and EVERY subsequent identical request is handed the same dead promise
  // until the instance recycles. Evict the key after 30s so later requests
  // start a fresh attempt — the original caller still just waits on p.
  const watchdog = setTimeout(() => {
    if (inFlight.get(key) === p) inFlight.delete(key);
  }, 30_000);
  // Don't let the watchdog keep a serverless instance alive.
  (watchdog as any).unref?.();
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
/**
 * True when `sanitize()` would actually REMOVE something from `input` — as
 * opposed to merely trimming whitespace, which is not worth telling anyone
 * about.
 *
 * QA report 2026-07-29 (EDGE-003) confirmed a `<script>` payload is safely
 * neutralised, and then noted the real problem: the user was never told their
 * text had been altered. Silently changing what someone typed and reporting
 * success is its own kind of wrong answer — they'd find the missing characters
 * later with no explanation. Routes pass this to the response so the UI can say
 * so plainly.
 */
export function wasSanitized(input: string): boolean {
  return typeof input === "string" && sanitize(input) !== input.trim().slice(0, 10000);
}

/** The one message the UI shows when input was altered for safety. */
export const SANITIZE_NOTICE = "Some unsafe formatting was removed from your text.";

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
  // [P2] passesProfileFilter only reads id + type (shared/profile-filter.ts),
  // so the cold path can use the lite projection and skip the heavy jsonb
  // columns of a full profiles select. The warm path reuses whatever the
  // /api/profiles cache holds (full rows — a superset, equally valid here).
  const allProfiles: Array<{ id: string; type?: string }> =
    getCached(`profiles:${uid}`) ||
    await ((storage as any).getProfilesLite?.() ?? storage.getProfiles());
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
  app.use(writeBarrierMiddleware);

  // PERF observability (2026-07-08): log any API request that takes >1s so
  // slow endpoints are visible in production logs (Vercel function logs)
  // without extra tooling. Deliberately warn-only and threshold-gated — this
  // must never add per-request noise or overhead on the fast path.
  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on("finish", () => {
      const ms = Date.now() - t0;
      if (ms > 1000) log.warn(`[slow-request] ${req.method} ${req.path} → ${res.statusCode} in ${ms}ms`);
    });
    next();
  });

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
    // X-Timezone / X-Active-Profile / X-Data-Version are sent by the web client
    // on every request (see client/src/lib/queryClient.ts); the Capacitor shell
    // talks to this API cross-origin, so they must be allowed through preflight
    // or those requests fail before the handler ever runs.
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-User-Id, X-Timezone, X-Active-Profile-Ids, X-Data-Version");
    // The client READS X-Data-Version off write responses to build its
    // read-your-writes token; without this it is invisible to cross-origin
    // callers (the Capacitor shell) and those writes silently lose the barrier.
    res.setHeader("Access-Control-Expose-Headers", "X-Data-Version, X-Total-Count");
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

  // Version endpoint — frontend polls this to detect new deploys.
  // `sha` identifies the deployed commit (Vercel injects VERCEL_GIT_COMMIT_SHA)
  // so tooling can poll for a specific push to go live; `version` is only the
  // instance boot time and changes on every cold start.
  const BUILD_VERSION = Date.now().toString(36);
  app.get("/api/version", (req, res) => {
    res.json({ version: BUILD_VERSION, sha: process.env.VERCEL_GIT_COMMIT_SHA || null });
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
    // /api/warmup is PUBLIC (auth is skipped for it) so the client can pay the
    // serverless cold-start before the user has a session. The old handler
    // unconditionally called storage.getStats()/getDashboardEnhanced()/
    // getProfiles(); when unauthenticated those ran against the global
    // "anonymous" storage singleton and hit Postgres with user_id = "anonymous",
    // producing the production error `invalid input syntax for type uuid:
    // "anonymous"`. (The old `uid !== "anon"` guard was dead code — cacheUserKey
    // returns `nouser-<random>` for anonymous requests, never "anon".)
    //
    // New behavior:
    //   - Anonymous warmup: return early. The serverless function is already
    //     warm by virtue of having executed; we do NOT touch the DB.
    //   - Authed warmup: resolve the real user from the bearer token (reusing
    //     the 60s token cache — no extra GoTrue round-trip), then pre-populate
    //     the per-user response cache for the SAVED profile scope the client
    //     sends via ?profileIds= (falling back to the aggregate). This warms
    //     exactly the keys the dashboard will read on first paint.
    // [PERF 2026-07-31] The warm work used to run AFTER res.json() — on Vercel
    // that races the instance freeze and silently loses the work. The client
    // fires warmup fire-and-forget and never reads the body, so the response's
    // latency is irrelevant — AWAIT the work instead so it is guaranteed to
    // land. With the shared response cache (Phase 3), the stats/enhanced
    // entries written here are then readable by WHICHEVER instance serves the
    // real bootstrap seconds later — the user's own pre-mount ping becomes the
    // cross-instance warmer. Warm repeats hit getCached and return instantly.
    const authed = await resolveUserFromRequest(req);
    if (!authed) return res.json({ ok: true, ts: Date.now() }); // anonymous → no DB work, no uuid error

    const profileIdsParam = req.query.profileIds as string | undefined;
    const profileId = req.query.profileId as string | undefined;
    const filterIds = profileIdsParam
      ? profileIdsParam.split(",").filter(Boolean)
      : (profileId ? [profileId] : undefined);
    const filterKey = filterIds?.join(",") || "all";

    const { createScopedStorage, requestStorageContext } = await import("./storage");
    const scoped = createScopedStorage(authed.userId);
    await requestStorageContext.run(scoped, async () => {
      try {
        // Version-stamp the cache keys exactly like cacheUserKey() does for a
        // GET, so a warmed entry is addressable by the real request that follows
        // and can never serve a stale (pre-write) version.
        const v = await currentDataVersion(authed.userId);
        const uid = `${authed.userId}@v${v}`;
        const ckStats = `stats:${uid}:${filterKey}`;
        const ckEnh = `enhanced:${uid}:${filterKey}`;
        const ckProf = `profiles:${uid}`;
        try { (scoped as any).enableRequestMemo?.(); } catch {}
        // getCachedShared: skip the recompute when ANY instance already holds
        // a live entry, not just this one.
        if (!(await getCachedShared(ckStats))) {
          try { setCache(ckStats, await scoped.getStats(undefined, filterIds), 60 * 1000); } catch {}
        }
        if (!(await getCachedShared(ckEnh))) {
          try { setCache(ckEnh, await scoped.getDashboardEnhanced(undefined, filterIds), 60 * 1000); } catch {}
        }
        if (!getCached(ckProf)) {
          try { setCache(ckProf, await scoped.getProfiles(), 60 * 1000); } catch {}
        }
        try { (scoped as any).disableRequestMemo?.(); } catch {}
      } catch { /* best-effort warm */ }
    });
    res.json({ ok: true, ts: Date.now() });
  }));

  // Resolve the per-user data version for GET requests (memoized 2s per
  // instance) so cacheUserKey() produces version-stamped keys. Fail open to
  // "no version" — same-instance busting still applies, and correctness is
  // restored on the next successful resolve.
  app.use("/api", (req, _res, next) => {
    if (req.method !== "GET") return next();
    const uid = (req as AuthenticatedRequest).userId;
    if (!uid) return next();
    // max(this instance's memo, the client's read-your-writes token) — see
    // resolveDataVersion. A client that was just told "saved" carries the
    // post-write version, so it can never be served this instance's pre-write
    // cache entry even while the 2s memo is still stale.
    const token = req.headers[DATA_VERSION_HEADER];
    currentDataVersion(uid)
      .then((v) => { (req as any).__dataVersion = resolveDataVersion(v, token); next(); })
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
      // Cross-instance staleness: bump the per-user DB data version so
      // version-stamped cache keys on every OTHER instance go stale within ~2s.
      //
      // NOTE: same-instance responseCache busting is intentionally NOT done here.
      // cacheBustMiddleware (registered above) already scoped-busts a SUPERSET of
      // these prefixes — pre-handler and on 'finish' — with the correct
      // read-only-POST allowlist. Duplicating that loop here was pure redundant
      // work on every write (and wrongly busted the read-only POST paths that
      // cacheBustMiddleware deliberately skips). The version bump below is B's
      // own responsibility (cacheBustMiddleware never bumps the version).
      if (uid !== "anon") {
        // Fire-and-forget here: a pre-handler bump already covers this
        // request, so nothing is waiting on the result. AI chat needs the
        // awaited form instead — see bumpDataVersionNow's doc comment.
        const bumpVersion = () => { void bumpDataVersionNow(uid); };
        // PERF (2026-08-17): a chat turn only invalidates when it actually
        // MUTATED something. The unconditional bump made every "open my
        // license" globally cold-start all version-stamped caches (bootstrap/
        // stats/enhanced/expenses/trackers — including the shared Postgres
        // rows), so the dashboard was never warm for a user who chats. The
        // chat handler sets res.locals.chatMutated after inspecting the
        // turn's actions; only a mutating turn bumps, and only on finish
        // (the version scheme guarantees a mid-handler GET that caches
        // pre-write data becomes unaddressable once the finish bump lands).
        if (req.path === "/chat") {
          res.once("finish", () => {
            // The chat handler awaits its own bump before responding (see
            // `chatVersionBumped`), which is what lets the client invalidate
            // exactly once. This hook is the fallback for a turn that mutated
            // but bailed out before reaching that code.
            if ((res as any).locals?.chatMutated && !(res as any).locals?.chatVersionBumped) bumpVersion();
          });
        } else {
          // Pre-handler bump covers fast writes; the finish bump covers long
          // writes whose DB writes land DURING the handler, so a GET racing
          // mid-handler can't leave stale version-stamped data behind.
          // Pre-handler bump covers fast writes. The post-write bump that used
          // to run on 'finish' now runs BEFORE the response, awaited, in
          // writeBarrierMiddleware — a bump after the response is on the wire
          // is too late to help the refetch that response triggers.
          bumpVersion();
        }
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

  // Pre-warm for the AI lambda. /api/chat/* routes to a SEPARATE Vercel
  // function (api/ai.js — see vercel.json rewrites) that /api/warmup never
  // touches, so before this route existed the first chat message of every
  // session paid the AI function's full cold start: container boot + ~2MB base
  // bundle + ~1MB ai-engine/Anthropic-SDK chunk graph. The client fires this
  // fire-and-forget on app open (client/src/lib/warmup.ts). PUBLIC like
  // /api/warmup (auth.ts skip list) and touches no user data — the await on
  // the module import is deliberate: on Vercel, work started after the
  // response can be frozen mid-flight, so we hold the (unread) response until
  // the chunk graph is actually parsed.
  app.get("/api/chat/warmup", asyncHandler(async (_req, res) => {
    try { await aiEngineMod(); } catch { /* warmup is best-effort */ }
    res.json({ ok: true, ts: Date.now() });
  }));

  app.post("/api/chat", asyncHandler(async (req, res) => {
    const userId = (req as AuthenticatedRequest).userId || req.ip || 'anonymous';
    if (rateLimit(`chat:${userId}`, 20)) {
      return res.status(429).json({ error: "Too many requests. Please wait a moment." });
    }
    // ── Streaming opt-in (P0: chat had NO streaming) ──────────────────────
    // Clients that send `Accept: text/event-stream` or `?stream=1` get an SSE
    // response: an immediate `ack` frame, incremental `round` /
    // `assistant_delta` / `tool_start` / `tool_result` frames from the AI
    // engine, keepalive comments every 15s (so proxies don't kill long tool
    // runs), then a `final` frame carrying the EXACT JSON body the buffered
    // path returns. Clients that don't opt in (old iOS Capacitor builds) get
    // the original buffered JSON response — that path is byte-identical to
    // before. `sse` stays null until validation passes, so all early-exit
    // errors below remain plain JSON with real status codes (the streaming
    // client feature-detects the content type before reading frames).
    const wantsStream =
      String(req.headers["accept"] || "").includes("text/event-stream") ||
      String((req.query as any)?.stream || "") === "1";
    type SseHandle = { send: (event: string, data: unknown) => void; end: () => void };
    let sse: SseHandle | null = null;
    const beginSse = (): SseHandle => {
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      // Disable proxy/nginx buffering so frames flush immediately.
      res.setHeader("X-Accel-Buffering", "no");
      (res as any).flushHeaders?.();
      const write = (chunk: string) => { if (!res.writableEnded) res.write(chunk); };
      const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const heartbeat = setInterval(() => write(`: keepalive\n\n`), 15_000);
      (heartbeat as any).unref?.();
      res.on("close", () => clearInterval(heartbeat));
      const handle: SseHandle = {
        send,
        end: () => { clearInterval(heartbeat); if (!res.writableEnded) res.end(); },
      };
      // First-token target ≤800ms: the ack ships before any AI work starts.
      send("ack", { ok: true });
      return handle;
    };
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

      // Build identity + turn clock: X-Portol-Rev confirms from the device
      // which deploy served the reply; the [chat-timing] log below shows where
      // the milliseconds went. Set before beginSse() flushes headers.
      res.setHeader("X-Portol-Rev", String(process.env.VERCEL_GIT_COMMIT_SHA || "dev").slice(0, 7));
      const tTurnStart = Date.now();
      const coldTurn = !chatServedOnce;
      chatServedOnce = true;

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

      // Validation passed — switch to SSE mode now (headers flush, ack frame,
      // heartbeat timer) before any AI latency accrues.
      if (wantsStream) sse = beginSse();

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
      // Opt-in routing diagnostics: clients never send this, but a probe can pass
      // { debug: true } to see which provider served the reply (meta.attempts).
      const debug = req.body?.debug === true;
      // Capture classifier, OFF the reply's critical path (perf fix): it still
      // starts in parallel, but the route no longer blocks the reply on a full
      // Haiku round-trip. When the engine routed the message (projections exist
      // below) we take whatever the classifier has settled; only an unrouted
      // message earns a bounded 2s wait — the one case where its
      // clarifyingQuestion can improve the reply. The capture write stays
      // before the response on purpose: a serverless instance may freeze the
      // moment the response ends, and captures must never be lost.
      let settledClassification: Awaited<ReturnType<typeof classifyCapture>> | null = null;
      const classifierPromise: Promise<Awaited<ReturnType<typeof classifyCapture>> | null> =
        classifierContextPromise
          .then(ctx => classifyCapture(cleanMessage, ctx))
          .then(c => { settledClassification = c; return c; })
          .catch(err => {
            console.warn("[classifyCapture] swallowed error:", (err as Error).message);
            return null;
          });
      // Turn identity (chat hallucination remediation, item 7): the client's
      // optimistic message id rides along so every action/operation the engine
      // emits can be traced back to the message that caused it. The engine
      // mints the turn id itself — a replayed or duplicated client id must
      // never merge two turns' action cards.
      const sourceMessageId = typeof req.body?.sourceMessageId === "string" && req.body.sourceMessageId.length <= 128
        ? req.body.sourceMessageId
        : undefined;
      const tEngineStart = Date.now();
      const result = await (processMessage as any)(cleanMessage, Array.isArray(history) ? history : undefined, userId, {
        profileFilterIds,
        debug,
        sourceMessageId,
        // Forward engine progress frames (round / assistant_delta /
        // tool_start / tool_result) straight onto the SSE stream.
        ...(sse ? { onEvent: (ev: any) => { try { sse!.send(ev.type, ev); } catch { /* stream may be gone */ } } } : {}),
      });
      const tEngine = Date.now() - tEngineStart;
      if (idem) setIdem(userId, idem, { status: "done", result, expires: Date.now() + IDEM_TTL_MS });

      // Projections computed up front — they feed the capture bookkeeping AND
      // decide whether the reply can ship before it (routed turns can).
      const actions: any[] = Array.isArray((result as any)?.actions) ? (result as any).actions : [];
      const projections = actions
        .filter(a => a && a.type)
        .map(a => ({
          kind: String(a.type),
          id: projectionIdOf(a),
          at: new Date().toISOString(),
        }))
        .filter(p => p.id);

      // Did this turn actually change anything? Read-only turns (document
      // opens, navigation, dashboard scoping, pure Q&A) must NOT invalidate
      // caches or bump the data version — that's what kept the dashboard
      // permanently cold for anyone using chat. The cacheBust and
      // version-bump middlewares read this flag on 'finish'.
      const READ_ONLY_ACTION_TYPES = new Set(["retrieve", "navigate", "set_dashboard_scope"]);
      // The engine's own change manifest is the authoritative signal — it is
      // built from what the TOOLS actually wrote. The action-type check stays
      // as a union term: previously it was the ONLY term, so a write whose tool
      // had no action-type mapping busted nothing at all, server-side, and the
      // stale response cache outlived the write.
      const mutations: any[] = Array.isArray((result as any)?.mutations) ? (result as any).mutations : [];
      const turnMutated = mutations.length > 0
        || actions.some(a => a?.type && !READ_ONLY_ACTION_TYPES.has(String(a.type)));
      res.locals.chatMutated = turnMutated;
      // Bug fix: chat may have created/updated profiles, trackers, expenses etc. via
      // internal AI tool calls. Bust the response cache BEFORE sending the response so
      // the client's onSuccess invalidate-and-refetch sees fresh DB state, not stale
      // cache — scoped to the mutating user, and only when something mutated.
      let tBump = 0;
      if (turnMutated) {
        bustUserCaches(userId);
        // Read-your-writes barrier: the reply is what tells the client to
        // refetch, so the version bump must be DONE before the reply is on the
        // wire. Handing the new version back lets the client stamp its refetches
        // with it (DATA_VERSION_HEADER), which closes the same window on other
        // warm instances too. Best-effort: an unavailable counter leaves
        // dataVersion undefined and the client behaves as it did before.
        const tBumpStart = Date.now();
        const v = await bumpDataVersionNow(userId);
        tBump = Date.now() - tBumpStart;
        if (v !== undefined) (result as any).dataVersion = v;
        // The finish-hook in the write middleware bumps again unless it
        // is told the barrier above already did it — see chatVersionBumped.
        res.locals.chatVersionBumped = true;
      }
      // Stage timings for the whole pipeline (engine + cache barrier), so the
      // remaining latency can be measured per stage instead of guessed at.
      try {
        (result as any).meta = {
          ...((result as any).meta || {}),
          timings: { ...(((result as any).meta || {}).timings || {}), engineMs: tEngine, bumpMs: tBump },
        };
      } catch { /* telemetry must never break a reply */ }
      // Hoist a dashboard-scope directive (from set_dashboard_scope) to the top
      // level so the chat client can apply the profile filter without digging
      // through the results array. The engine can't touch the browser filter
      // store, so the client does it on receipt.
      try {
        const rs: any[] = Array.isArray((result as any)?.results) ? (result as any).results : [];
        const scoped = rs.find((r) => r && typeof r === "object" && (r as any).scope);
        if (scoped) (result as any).scope = (scoped as any).scope;
      } catch { /* non-fatal */ }

      // PERF (2026-08-17 latency teardown): a ROUTED turn — the engine produced
      // projections or a document preview — ships its `final` frame NOW, before
      // capture bookkeeping. The capture write still completes before the
      // stream CLOSES (sse.end() below), so the serverless-freeze guarantee
      // ("captures must never be lost") is preserved; only the user-visible
      // wait stops paying for it. Unrouted turns keep the old order because
      // the classifier's clarifyingQuestion may still amend the reply.
      const routed = projections.length > 0
        || !!(result as any)?.documentPreview
        || ((result as any)?.documentPreviews?.length ?? 0) > 0;
      let finalSent = false;
      if (sse && routed) {
        sse.send("final", result);
        finalSent = true;
      }

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
      let tClassifierWait = 0;
      let tCapture = 0;
      try {
        if (storage.createCapture) {
          // Classifier result without blocking the reply on it: routed
          // messages take whatever has already settled (Haiku usually
          // finishes well inside a full agent turn); only an unrouted
          // message waits, bounded to 2s, because its clarifyingQuestion may
          // be appended to the reply below. On timeout the heuristic
          // fallbacks in this block handle classification=null as before.
          const tClassifierStart = Date.now();
          const classification = projections.length > 0
            ? settledClassification
            : await Promise.race([
                classifierPromise,
                new Promise<null>(resolve => setTimeout(() => resolve(null), 2000)),
              ]);
          tClassifierWait = Date.now() - tClassifierStart;

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

          const tCaptureStart = Date.now();
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
          tCapture = Date.now() - tCaptureStart;

          // Surface the clarifying question in the chat reply when the
          // classifier is unsure AND nothing was routed. We only append
          // (never replace) so the AI's own response stays intact. Skipped
          // when the final frame already shipped (routed turns) — the reply
          // is on the wire and routed turns never carried the question anyway.
          if (
            !finalSent &&
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

      // Production latency accounting — one line per turn in the function logs.
      console.log(`[chat-timing] engine=${tEngine}ms classifierWait=${tClassifierWait}ms capture=${tCapture}ms bump=${tBump}ms mutations=${mutations.length} total=${Date.now() - tTurnStart}ms cold=${coldTurn} routed=${routed}`);

      if (sse) {
        // Streaming finalization: the `final` frame carries the EXACT object
        // the buffered path would have sent via res.json — the client's
        // completion handling is identical either way. Routed turns already
        // shipped it above, before capture bookkeeping.
        if (!finalSent) sse.send("final", result);
        sse.end();
        return;
      }
      res.json(result);
    } catch (err: any) {
      const msg = err?.message || "unknown error";
      log.error("[Chat]", msg);
      // Provide actionable error messages based on error type. In SSE mode
      // headers are already sent (200), so errors are delivered as an `error`
      // frame carrying the same status + body the buffered path returns.
      const fail = (status: number, body: { error: string; reply: string }) => {
        if (sse) { sse.send("error", { status, ...body }); sse.end(); return; }
        res.status(status).json(body);
      };
      const status = err?.status || err?.error?.status || 500;
      if (status === 529 || status === 503 || msg.includes('overloaded')) {
        return fail(503, { error: "The AI is temporarily busy. Please try again in a few seconds.", reply: "I'm a bit overloaded right now. Could you try again in a moment?" });
      }
      if (status === 429) {
        return fail(429, { error: "Rate limit reached. Please wait a moment.", reply: "I need a short break. Please try again in about 30 seconds." });
      }
      if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) {
        return fail(504, { error: "Request timed out.", reply: "That took too long. Could you try a simpler question, or try again?" });
      }
      // S3 fix: never leak internal error details to clients. Log to stderr instead.
      // Previously we surfaced `detail: <raw msg>` outside production, which exposed
      // SDK errors / stack traces / DB column names if NODE_ENV was misconfigured.
      fail(500, { error: "Failed to process message", reply: "Something went wrong. Please try again." });
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

  // ---- Cron: daily maintenance ----
  // Vercel serverless has no always-on background, so a scheduled GET drives
  // the app's one recurring housekeeping job. Gated by CRON_SECRET.
  //
  // This used to be "fire due reminders": it walked every user's pending
  // reminder rows, created a `Reminder: <title>` TASK as the in-app marker, and
  // stamped fired_at. Reminders were retired on 2026-08-09 — a timed task IS
  // the thing the user sees now, so there is nothing to convert into a task any
  // more, and nothing to stamp. What remains is the response-cache sweep the
  // job always carried alongside it.
  //
  // The ROUTE NAME is deliberately unchanged: it is wired into vercel.json's
  // `crons` block, and a schedule pointing at a 404 fails silently. A second
  // path is registered under the honest name for anything configured later.
  const cronDailyMaintenance: any = asyncHandler(async (req: any, res: any) => {
    const secret = process.env.CRON_SECRET;
    // Accept the Bearer header as well as ?key=. Vercel Cron authenticates with
    // `Authorization: Bearer $CRON_SECRET` and cannot append a query string, so
    // a ?key=-only check made this endpoint unreachable from a schedule.
    // ?key= is kept so the job can still be triggered by hand.
    const provided = String(
      req.query.key || (req.headers.authorization || "").replace("Bearer ", "")
    ).trim();
    if (!secret || !provided || !safeEqual(provided, secret)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      // Expired rows are already unreadable — this just keeps the table from
      // growing without bound.
      let swept = 0;
      try { swept = (await (storage as any).sweepResponseCache?.()) || 0; } catch { /* best-effort */ }
      res.json({ swept });
    } catch (err: any) {
      log.error("[Cron Daily Maintenance]", err?.message || err);
      res.status(500).json({ error: "Cron failed" });
    }
  });
  app.get("/api/cron/daily-maintenance", cronDailyMaintenance);
  // Legacy path — still what vercel.json schedules.
  app.get("/api/cron/fire-due-reminders", cronDailyMaintenance);

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

  // ---- Cron: recurring-liability due scan (replaces the obligation engine) ----
  // Global cross-user job. For every recurring-bill liability whose next due
  // date falls within the reminder window: autopay bills are auto-logged (a
  // liability_payments row is written and the due date rolls forward), and
  // non-autopay bills get a one-time "Bill due" TASK at the due date (deduped by
  // title + date) so the user sees it on the dashboard and can check it off.
  // This is the liability-native replacement for materializeOccurrences.
  const REMINDER_WINDOW_DAYS = 3;
  const cronLiabilityDueScan: any = asyncHandler(async (req: any, res: any) => {
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

      let autopaid = 0;
      let reminded = 0;
      for (const u of users) {
        try {
          const scoped = createScopedStorage(u.id);
          await new Promise<void>((resolve) => {
            requestStorageContext.run(scoped, async () => {
              try {
                const todayISO = getUserToday(DEFAULT_TIMEZONE);
                const windowEnd = toLocalDateStr(new Date(Date.now() + REMINDER_WINDOW_DAYS * 86400000), DEFAULT_TIMEZONE);
                const profiles = await scoped.getProfiles();
                const bills = profiles.filter((p: any) => isRecurringBill(p.type_key ?? p.typeKey));
                const existingTasks = await scoped.getTasks().catch(() => [] as any[]);
                for (const bill of bills) {
                  const f: any = bill.fields || {};
                  const due = readDueDate(f);
                  if (!due || due > windowEnd) continue; // not due within the window
                  const amount = Number(f.monthlyAmount ?? f.monthly_amount ?? f.amount ?? f.cost ?? 0) || 0;
                  const autopay = f.autopay === true || f.autoPay === true || String(f.autopay ?? "").toLowerCase() === "true";
                  if (autopay && amount > 0) {
                    // Auto-log the payment and roll the due date forward.
                    try {
                      await scoped.createLiabilityPayment({
                        liabilityProfileId: bill.id,
                        paymentDate: todayISO,
                        amount,
                        principalPortion: amount,
                        interestPortion: 0,
                        paymentType: "standard",
                        notes: "Autopay",
                      } as any);
                      const nextDue = advanceLiabilityDueDate(f, todayISO);
                      await scoped.updateProfile(bill.id, {
                        fields: { ...f, dueDate: nextDue, nextDueDate: nextDue, lastPaidDate: todayISO, status: "upcoming" },
                      });
                      autopaid++;
                    } catch { /* per-bill best effort */ }
                  } else {
                    // Non-autopay: surface a timed TASK at the due date, deduped
                    // on title + date. A task is checkable and lands on the
                    // calendar at its hour; the reminder rows this used to write
                    // were neither.
                    const title = `Bill due: ${bill.name}`;
                    const dup = (existingTasks || []).some((t: any) =>
                      t.title === title && String(t.dueDate || "").slice(0, 10) === due && t.status !== "done");
                    if (!dup) {
                      try {
                        await scoped.createTask({
                          title,
                          priority: "high",
                          dueDate: due,
                          dueTime: "09:00",
                          linkedProfiles: [bill.id],
                        } as any);
                        reminded++;
                      } catch { /* best effort */ }
                    }
                  }
                }
              } catch { /* per-user failure shouldn't abort the run */ }
              resolve();
            });
          });
        } catch { /* skip user */ }
      }
      res.json({ autopaid, reminded });
    } catch (err: any) {
      log.error("[Cron Liability Due Scan]", err?.message || err);
      res.status(500).json({ error: "Cron failed" });
    }
  });
  app.get("/api/cron/liability-due-scan", cronLiabilityDueScan);
  app.post("/api/cron/liability-due-scan", cronLiabilityDueScan);

  // ---- Activity Feed ----
  app.get("/api/activity", asyncHandler(async (req, res) => {
    const actUserId = (req as AuthenticatedRequest).userId || undefined;
    const count = 10;
    // Durable AI action ledger first (survives restarts); legacy in-memory
    // map as fallback so the feed never goes blank on a ledger error.
    try {
      const rows = await storage.listAiActionLog({ limit: count, includeUndone: true });
      if (rows.length > 0) {
        return res.json(rows.map(r => ({
          timestamp: r.createdAt, action: r.tool, type: r.actionType,
          entityName: r.entityName || "", entityId: r.entityId || undefined,
        })));
      }
    } catch { /* fall through to legacy map */ }
    res.json(await getActionLog(count, actUserId));
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
      const { filterMode, filterIds, scopeLabel, force } = req.body as {
        filterMode?: "all" | "selected" | "everyone";
        filterIds?: string[];
        scopeLabel?: string;
        force?: boolean;
      };
      const ids = Array.isArray(filterIds) ? filterIds.filter((s) => typeof s === "string") : [];
      const useFilter = filterMode === "selected" && ids.length > 0;

      // Today bounds in user's TZ
      const tz = getTimezone(req);
      const todayISO = new Date().toLocaleDateString("en-CA", { timeZone: tz });

      // PERF (2026-07-17 live drive): every scope switch regenerated the
      // briefing via a fresh LLM call — 5-7s of skeleton lines that made an
      // otherwise-instant dashboard feel slow. The briefing is a DAILY digest:
      // cache it per user+scope+day (4h TTL, NOT data-version-stamped — the
      // manual Refresh button passes force:true to regenerate on demand), so
      // returning to a scope you've already seen today renders it instantly.
      const briefingKey = `aisummary:${userId}:${useFilter ? ids.slice().sort().join(",") : "everyone"}:${todayISO}`;
      if (!force) {
        const cachedBriefing = getCached(briefingKey);
        if (cachedBriefing) return res.json(cachedBriefing);
      }

      const enhanced: any = await storage.getDashboardEnhanced(undefined, useFilter ? ids : undefined);
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

      const anthropicClient = await getAnthropicClient();
      const resp = await anthropicClient.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      });
      const text = resp.content[0]?.type === "text" ? (resp.content[0] as any).text.trim() : "";
      const payload = {
        summary: text || "No summary available.",
        scope: ctx.scope,
        scopedIds: useFilter ? ids : null,
        generatedAt: new Date().toISOString(),
      };
      if (text) setCache(briefingKey, payload, 4 * 60 * 60 * 1000);
      res.json(payload);
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

      // Helper: unwrap {value, confidence} objects into plain values.
      // Declared BEFORE the AI profile-pick below — it used to sit after it,
      // so the pick's `unwrap(f.value)` hit the const temporal dead zone and
      // the whole AI profile-pick silently fell back to the self profile.
      const unwrap = (v: any) => (v && typeof v === 'object' && 'value' in v) ? v.value : v;

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
      // Fields the routing layer deliberately kept off the profile (document
      // metadata / junk). Surfaced in the response so a "saved" that actually
      // skipped something is visible instead of silent.
      const skippedFields: string[] = [];

      // ═══ INTELLIGENT DATA ROUTING ═══
      // Each extracted field gets routed to the correct destination based on what it IS.
      // The document always keeps ALL data as the source of truth.

      // Step 0: ALWAYS save all confirmed fields to the document's extractedData (source of truth)
      //
      // What Step 2 needs to know: which fields actually LANDED, and what kind
      // of document this is. Both are known here, so they are recorded rather
      // than re-fetched — that second `getDocument` downloaded the file binary
      // again just to read a type and a name.
      let docContextForDates = "";
      const persistedFieldValues = new Map<string, any>();
      const profileSavedKeys = new Set<string>();
      if (confirmedFields && confirmedFields.length > 0) {
        try {
          const doc = await storage.getDocument(extractionId);
          if (doc) {
            docContextForDates = `${doc.type ?? ""} ${doc.name ?? ""}`;
            const updatedData: Record<string, any> = { ...(doc.extractedData || {}) };
            for (const field of confirmedFields) {
              updatedData[field.key] = unwrap(field.value);
            }
            // The document is the source of truth for its own dates, so its
            // dates must be stored the ONE way every reader can parse. A
            // licence prints "07/18/2034"; stored verbatim it was a string the
            // calendar, Upcoming and Important Dates could all see and none
            // could understand. See shared/date-rules.
            const normalizedDoc = normalizeEntityDateFields(updatedData, { contextKey: docContextForDates });
            await storage.updateDocument(extractionId, { extractedData: normalizedDoc.fields });
            // Record what LANDED, and under the value that landed — Step 2 has
            // to know not just that the field saved but that a rule can be
            // derived from it.
            for (const field of confirmedFields) {
              persistedFieldValues.set(normalizeFieldKey(field.key), normalizedDoc.fields[field.key]);
            }
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

        // The review checklist IS the routing decision. Every field the user
        // ticked gets written to the profile — no AI second-guessing. An
        // earlier "field-destination-route" AI pass used to reclassify ticked
        // fields as "doc_only"/"skip" and silently drop them (bug report
        // 2026-07-27: an oil-change receipt's service date, oil type, amount,
        // and provider never reached the chosen vehicle while the response
        // claimed success). The only exception is the tiny static
        // DOC_ONLY_FIELDS list of pure file metadata, and even those skips are
        // named in the response instead of hidden.
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
          if (DOC_ONLY_FIELDS.has(key)) { skippedFields.push(key); continue; }

          // ONE spelling. This used to write `dateOfBirth` AND `birthday`, and
          // the twin sweep below then nulled one of them anyway — so the pair
          // bought nothing and cost plenty: the write verification counted the
          // retired half as a lost field, and which spelling survived decided
          // the Date Rule's id, so an extracted birthday and a typed one
          // produced rules with different ids for the same fact.
          //
          // Every reader accepts either spelling (profile-detail reads
          // `birthday || dateOfBirth || dob`), and the rule engine classifies
          // all of them, so the canonical one is enough.
          if (key === 'dateOfBirth' || key === 'dob') {
            profileFields['dateOfBirth'] = coerceValue(key, val);
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
          try {
            const profile = await storage.getProfile(resolvedProfileId);
            if (profile) {
              const existingFields: Record<string, any> = profile.fields || {};

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

              // Fold alias spellings to the canonical key (currentMileage →
              // mileage, value → currentValue…) so a receipt's key naming
              // can't mint a second copy of a field the profile already has.
              const canonical = canonicalizeProfileFields(profileFields, existingFields).fields;

              // Merge onto the profile. The confirmed value replaces every
              // other spelling of the same field, EXCEPT a spelling this same
              // payload is also writing — a license card sends "address" and
              // "streetAddress" (and "State" and "issuing State") for one
              // field each, and the sweep used to null the first of the pair
              // right after writing it. Replaced odometer readings are kept in
              // _mileageHistory rather than lost. See mergeFieldWrite.
              const mergeResult = mergeFieldWrite(existingFields, canonical);
              const merged: Record<string, any> = mergeResult.fields;
              const incoming = mergeResult.written;
              if (mergeResult.replacedMileage.length > 0) {
                const history = Array.isArray(existingFields._mileageHistory) ? existingFields._mileageHistory : [];
                merged._mileageHistory = [
                  ...history,
                  ...mergeResult.replacedMileage.map((m) => ({ value: m.value, from: m.from, replacedAt: new Date().toISOString() })),
                ];
              }

              // PROVENANCE: remember which document saved which fields (and the
              // values it saved), so deleting the document can remove exactly
              // the data it contributed — and nothing the user edited since.
              // Underscore-prefixed = reserved metadata, never rendered.
              const priorSources = (existingFields._docFields && typeof existingFields._docFields === "object")
                ? existingFields._docFields : {};
              merged._docFields = {
                ...priorSources,
                [extractionId]: Object.fromEntries(
                  Object.entries(incoming).filter(([k]) => !k.startsWith("_"))
                ),
              };

              await storage.updateProfile(resolvedProfileId, { fields: merged });

              // Verify the write actually landed before claiming success —
              // re-read the profile and check every confirmed field. Any field
              // that didn't persist is named individually in `failures`
              // instead of the whole save being reported as done.
              const after = await storage.getProfile(resolvedProfileId);
              const afterFields: Record<string, any> = (after as any)?.fields || {};
              const confirmedKeys = Object.keys(incoming).filter((k) => !k.startsWith("_"));
              // Verify on IDENTITY, not on the literal key: a value written as
              // `streetAddress` has landed when the profile holds it under
              // `address` (or inside `personal.address`). The old exact-key
              // check reported a perfectly good save as
              // "fields did not persist to <name>: address, issuing State".
              const unsavedKeys = confirmedKeys.filter((k) => !fieldValuePersisted(afterFields, k, incoming[k]));
              // Count the fields the user will SEE — one per FIELD, not one per
              // spelling. A licence sends "address" and "streetAddress" for one
              // field, and "Saved 2 fields" for one address is its own small lie.
              const seenIdentities = new Set<string>();
              const savedKeys = confirmedKeys.filter((k) => {
                if (unsavedKeys.includes(k)) return false;
                const identity = fieldIdentity(k);
                if (seenIdentities.has(identity)) return false;
                seenIdentities.add(identity);
                return true;
              });
              if (unsavedKeys.length > 0) {
                failures.push(`fields did not persist to ${profile.name}: ${unsavedKeys.join(", ")}`);
              }
              if (savedKeys.length > 0) {
                saved.push(`Saved ${savedKeys.length} field${savedKeys.length === 1 ? "" : "s"} to ${profile.name}`);
              }
              // What Step 2 needs: the fields that reached the PROFILE. A
              // document does not derive a birthday, so suppressing that
              // event on "a profile id existed" alone lost the date whenever
              // the profile write failed.
              // By field IDENTITY, not by spelling: a field confirmed as `dob`
              // is routed to `dateOfBirth`, so comparing the raw key never
              // matched — and a standalone birthday event was written and
              // tagged `date-rule-uncovered`, which exempts it from the shadow
              // pass, leaving a permanent duplicate of the derived rule.
              for (const k of savedKeys) profileSavedKeys.add(fieldIdentity(k));
              log.info(`[confirm-extraction] Routed ${savedKeys.length}/${confirmedKeys.length} fields to profile ${profile.name}${unsavedKeys.length > 0 ? ` (FAILED: ${unsavedKeys.join(", ")})` : ""}`);

              // Link the document to the profile
              try {
                await storage.linkProfileTo(resolvedProfileId, "document", extractionId);
                await storage.propagateDocumentToAncestors(extractionId, resolvedProfileId);
              } catch { /* may already be linked */ }
            } else {
              // A profile id was resolved but the profile can't be loaded
              // (deleted mid-flight?) — the fields did NOT reach any profile.
              failures.push(`profile ${resolvedProfileId} not found — ${Object.keys(profileFields).length} confirmed field(s) were saved to the document only`);
            }
          } catch (pErr: any) {
            console.error("Failed to save fields to profile:", pErr?.message);
            failures.push(`profile fields: ${pErr?.message || "unknown error"}`);
          }
        } else if (!resolvedProfileId && Object.keys(profileFields).length > 0) {
          // The user ticked fields but no destination profile could be
          // resolved (none selected, no AI match, no self profile). Say so —
          // the fields are on the document, NOT on any profile.
          failures.push(`no profile selected — ${Object.keys(profileFields).length} confirmed field(s) were saved to the document only`);
        }
      }

      // 2. Dates the source entity does NOT already own
      //
      // Every date that classifies as a Date Rule (shared/date-rules) — a DOB,
      // an expiration, a renewal, a payment date — is now DERIVED from the
      // field the step above just saved. Writing a standalone calendar event
      // for it as well was the app's second date system: the event was a copy
      // that drifted when the field was edited and survived as an orphan when
      // the document was deleted. The entity owns the date; the calendar is a
      // view of it.
      //
      // A date the classifier does NOT recognise (a one-off "House Viewing"
      // printed on an invitation) has no source field to be derived from, so
      // it still becomes a real event — that is the only case left.
      if (createCalendarEvents && createCalendarEvents.length > 0) {
        // A date is only DERIVED if its field actually PERSISTED.
        //
        // `createCalendarEvents` arrives independently of `confirmedFields`, so
        // a date ticked for the calendar alone has no field behind it — and if
        // Step 0's write threw, neither does one that was ticked. Suppressing
        // the event in either case loses the date entirely while the response
        // still reports success, so the set below is the fields that landed.
        for (const event of createCalendarEvents) {
          try {
            // A rule must be DERIVABLE, not merely plausible. A value the date
            // engine rejects — a range, a sentence, a timestamp — still
            // classifies as actionable from its field NAME, so suppressing on
            // classification alone left the date on no surface at all while
            // the response reported success.
            const key = normalizeFieldKey(event.field);
            const cls = classifyDateField(event.field, docContextForDates);
            // A document does not derive a BIRTHDAY — that belongs to the
            // person, and only the profile write above can carry it. With no
            // profile to route to, the field saved to the document and derived
            // nowhere, so suppressing the event left the date on no surface
            // while the response reported success.
            const derivedByTheDocument = cls.ruleType !== "birthday" && cls.ruleType !== "anniversary";
            const derivedByTheProfile = profileSavedKeys.has(fieldIdentity(event.field))
              && (cls.ruleType === "birthday" || cls.ruleType === "anniversary");
            const covered = persistedFieldValues.has(key)
              && !!bareDateOf(persistedFieldValues.get(key))
              && cls.actionable
              && (derivedByTheDocument || derivedByTheProfile);
            if (covered) {
              log.info(`[confirm-extraction] "${event.field}" is owned by its record — derived as a Date Rule, no standalone event`);
              continue;
            }
            // Parse date from the field value. Uses the shared parser so
            // printed forms like "6/4/2029" (single-digit month/day) and
            // "Jun 4, 2029" normalize correctly instead of being dropped.
            const dateStr = normalizeDateString(event.date);
            if (!dateStr) continue;
            // (The `canonicalDateCoverage` gate that used to sit here has been
            // folded into the `covered` test above. Both answered "would the
            // record already put this date on the calendar?", and running two
            // of them meant the weaker one could veto a date the stronger one
            // had deliberately allowed: it asked only whether a profile or
            // document EXISTS, where the check above asks whether the field
            // actually persisted and whether a rule can be derived from the
            // value that landed. A date ticked for the calendar alone was
            // dropped by the second gate and reported as saved.)
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
              // `date-rule-uncovered` says: this event is NOT a copy of a date
              // the record owns — it is the only home the date has. The shadow
              // pass (shared/calendar-adapters) suppresses extraction events
              // that duplicate a derived rule, matching on document and day,
              // and without this marker an uncovered date landing on the same
              // day as a derived one would be suppressed with them.
              tags: ["document-extraction", "date-rule-uncovered"],
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
          // OWNERSHIP MODEL (shared/cost-of-ownership.ts): the expense belongs
          // to the ASSET — one row, one link. The owner sees it through the
          // ownedAssetIds widening on /api/expenses and the dashboard, so it
          // counts toward the owner exactly once and is never double-linked.
          // Fall back to self only when no asset was resolved.
          let expenseLinks: string[] = resolvedProfileId ? [resolvedProfileId] : [];
          if (expenseLinks.length === 0) {
            const selfForExpense = (await storage.getProfiles()).find((p: any) => p.type === 'self');
            if (selfForExpense) expenseLinks = [selfForExpense.id];
          }
          // Canonical pipeline, wrapped in the door-agnostic contract: the
          // extraction door dedupes by date+amount (one document must never
          // yield two expenses — auto-created at upload, or a replayed
          // confirmation) and now also gets read-back verification, an undo
          // ledger row (source "extraction"), and a change manifest.
          const mctxExp = beginMutationContext(storage, "extraction");
          const expOutcome = await runMutation(mctxExp, {
            tool: "create_expense",
            input: { description: exp.description, amount: exp.amount, category: exp.category, date: exp.date },
            execute: () => createExpenseRecord(storage, {
              description: exp.description,
              amount: exp.amount,
              category: exp.category,
              vendor: exp.vendor,
              date: exp.date,
              tags: [],
              linkedProfiles: expenseLinks,
            }, {
              lockUser: (req as AuthenticatedRequest).userId || "extraction",
              dedupByDateAmount: true,
              dedupWindowMs: 0,
            }),
          });
          if (!expOutcome.ok) {
            throw new Error(expOutcome.error || "expense creation failed");
          }
          const expenseId = expOutcome.entity?.id;
          if (expOutcome.deduped) {
            saved.push(`Expense already exists — skipped duplicate`);
          } else {
            saved.push(`Created expense: $${Number(exp.amount).toFixed(2)} ${exp.description}`);
          }
          noteWriteMutations(res, expOutcome.mutations);
          // Link document to the (possibly pre-existing) expense
          if (expenseId) {
            try { await storage.linkProfileTo(expenseId, "document", extractionId); } catch {}
          }
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
            category: canonicalObligationCategory(obl.category || 'general'),
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
        // Fields deliberately kept on the document only (metadata/junk) —
        // named so a partial save is visible instead of silently claimed.
        skipped: skippedFields,
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
    const cached = await getCachedShared(cacheKey);
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
    const cached = await getCachedShared(cacheKey);
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
    // Shared cache: an instance that never computed this bootstrap can still
    // serve it in one indexed read if ANY instance (or the warmup ping)
    // computed it in the last 30s — the cold-open killer was every instance
    // recomputing the same aggregation.
    const cached = await getCachedShared(cacheKey);
    if (cached) return res.json(cached);

    // PERF (profile-switch, 2026-08-05): the raw tables this handler reads are
    // fetched UNFILTERED and filtered in JS (see `sharedFetches` in getStats /
    // getDashboardEnhanced), so they are IDENTICAL for every profile scope —
    // only the filtering differs. Yet the response cache is keyed by scope, so
    // picking a second person re-ran the whole ~18-query Supabase fan-out from
    // scratch (measured 1.5-4.6s per switch, PERF_PLAN_LAUNCH_2026-07-16 §B1).
    //
    // Cache the resolved reads once per user instead, and prime the next
    // scope's request memo with them: switching people then costs the JS
    // aggregation only. Same pattern (and same freshness guarantee) as the
    // `insights-data:` cache below — the key is version-stamped via
    // cacheUserKey, so any write makes it unaddressable, and the TTL matches
    // the bootstrap payload's own 30s staleness ceiling.
    const rawCacheKey = `bootstrap-raw:${userId}:${month}`;
    const rawSnapshot = getCached(rawCacheKey);

    const data = await dedupe(cacheKey, async () => {
      // PERF: enable per-request memoization on the scoped storage so that
      // getStats() + getDashboardEnhanced() + the lightweight Promise.all
      // share a single Supabase fetch per table (profiles/expenses/trackers/
      // tasks/events/obligations/etc) instead of refetching each one 2-3x.
      // Safe because storage is request-scoped via createScopedStorage and
      // memo is opt-in (default OFF).
      try { (storage as any).enableRequestMemo?.(); } catch {}
      // Reuse the previous scope's reads when they're still addressable.
      if (rawSnapshot) {
        try { (storage as any).primeRequestMemo?.(rawSnapshot); } catch {}
      }

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
      const cachedStats = await getCachedShared(statsCacheKey);
      const cachedEnhanced = await getCachedShared(enhancedCacheKey);

      // [PERF 2026-07-17, user report "every tile shows loading on scope switch"]
      // The Events tile is gated on /api/calendar/timeline and the AI Executive
      // Brief also reads /api/notifications — neither was in the bootstrap
      // payload, so scope switches left both cold and the tiles stuck on
      // "loading" until those separate GETs landed (12s+ on weak mobile). Both
      // are added to the bootstrap fan-out here; the request memo makes the
      // added storage reads free (getCalendarTimeline reuses events/tasks/
      // obligations already fetched above; buildNotifications reuses docs/
      // tasks/obligations/habits).
      // [PERF 2026-07-31] Window comes from the shared canonical helper so the
      // seeded client cache key is bit-identical to what the calendar page,
      // month grid and Executive briefing actually query — previously each
      // used a different window and NONE ever hit this seed (calendar
      // cold-fetched on every open).
      const bootstrapTz = getTimezone(req);
      const bootstrapWindow = canonicalTimelineWindow(getUserToday(bootstrapTz));
      const bootstrapStart = bootstrapWindow.start;
      const bootstrapEnd = bootstrapWindow.end;
      // [PERF 2026-08-05] The hero trend line reads /api/net-worth/history on
      // its own, ungated — so every profile switch fired it in parallel with
      // this bootstrap. It's one indexed read, so folding it in here costs
      // nothing and removes a round trip from the switch. Mirrors GET
      // /api/net-worth/history exactly: per-profile series only when exactly
      // one profile is selected, otherwise the account aggregate.
      const nwProfileId = filterIds && filterIds.length === 1 ? filterIds[0] : undefined;
      const [stats, profiles, incomes, expensesForBudget, budgets, obligationsAll, assetPartyLinks, liabilityProfileLinks,
        tasksAll, habitsAll, goalsAll, journalAll, eventsAll, documentsAll, trackersAll,
        calendarTimelineAll, notificationsAll, netWorthHistory] = await Promise.all([
        cachedStats ?? dedupe(statsCacheKey, async () => {
          // sharedFetches: this same request fetches every table unfiltered
          // for the seed payloads + buildNotifications below — let getStats
          // share those memoized fetches instead of re-fetching each table
          // with a scoped memo key (was ~2× the round trips per bootstrap).
          const s = await storage.getStats(undefined, filterIds, { sharedFetches: true });
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
        // [PERF 2026-07-16, user report "tiles stuck on loading"] The Executive
        // briefing + Upcoming section fired ~14 MORE GETs (tasks/habits/goals/
        // journal/events/documents/trackers/reminders) in parallel with this
        // bootstrap — on a weak mobile link those requests fight the bootstrap
        // download and several stall out. Nearly all of these tables are ALREADY
        // fetched inside getStats/getDashboardEnhanced under the request memo,
        // so returning them here is free — one round trip instead of fifteen.
        storage.getTasks(),
        storage.getHabits(),
        (storage as any).getGoals ? (storage as any).getGoals() : Promise.resolve([] as any[]),
        (storage as any).getJournalEntries ? (storage as any).getJournalEntries() : Promise.resolve([] as any[]),
        storage.getEvents(),
        storage.getDocuments(),
        storage.getTrackers(),
        // [PERF 2026-07-17] Events tile and AI Brief seeds (see comment above).
        storage.getCalendarTimeline
          ? storage.getCalendarTimeline(bootstrapStart, bootstrapEnd, filterIds).catch(() => [] as any[])
          : Promise.resolve([] as any[]),
        buildNotifications(storage, bootstrapTz).catch(() => [] as any[]),
        typeof (storage as any).getNetWorthHistory === "function"
          ? (storage as any).getNetWorthHistory(nwProfileId, 120).catch(() => [] as any[])
          : Promise.resolve([] as any[]),
      ]);

      const enhanced = cachedEnhanced ?? await dedupe(enhancedCacheKey, async () => {
        // sharedFetches — same memo-collapse as the getStats call above.
        const e = await storage.getDashboardEnhanced(undefined, filterIds, { sharedFetches: true });
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
        // [PERF 2026-07-16] Briefing/Upcoming seed datasets — each filtered with
        // the SAME canonical rule its GET endpoint applies (passesProfileFilter
        // over linkedProfiles), so seeding a profile-scoped cache key can never
        // leak another profile's rows.
        tasks: scopeByLinkedProfiles(tasksAll),
        habits: scopeByLinkedProfiles(habitsAll),
        goals: scopeByLinkedProfiles(goalsAll),
        journal: scopeByLinkedProfiles(journalAll),
        events: scopeByLinkedProfiles(eventsAll),
        documents: scopeByLinkedProfiles(documentsAll),
        // Mirror GET /api/trackers exactly: hidden categories stripped, then
        // the canonical orphan rule (filterByProfileScope) — NOT the plain
        // linkedProfiles rule — so the seeded key matches a real fetch.
        trackers: await (async () => {
          let t = (trackersAll || []).filter((x: any) => !HIDDEN_TRACKER_CATEGORIES.has(String(x.category || "").toLowerCase().trim()));
          if (filterIds && filterIds.length > 0) t = await filterByProfileScope(t, filterIds, userId);
          return t;
        })(),
        // [PERF 2026-07-17] Calendar timeline for the Events tile — already
        // scoped by getCalendarTimeline(profileIds), so no extra filtering.
        // Shape mirrors GET /api/calendar/timeline exactly.
        calendarTimeline: {
          start: bootstrapStart,
          end: bootstrapEnd,
          items: calendarTimelineAll || [],
        },
        // Notifications payload for the AI Executive Brief. Filtered here so
        // the seeded key matches GET /api/notifications for a scope switch.
        notifications: (!filterIds || filterIds.length === 0)
          ? (notificationsAll || [])
          : (notificationsAll || []).filter((n: any) => {
              if (!n?.entityType || !n?.entityId) return true;
              if (n.entityType === "profile") return filterIds.includes(n.entityId);
              const collection: any[] =
                n.entityType === "document" ? (documentsAll as any[])
                : n.entityType === "task" ? (tasksAll as any[])
                : n.entityType === "obligation" ? (obligationsAll as any[])
                : n.entityType === "habit" ? (habitsAll as any[])
                : [];
              const entity = collection.find((x: any) => x?.id === n.entityId);
              if (!entity) return true;
              return passesProfileFilter(entity.linkedProfiles, { selectedIds: filterIds, allProfiles: profiles });
            }),
        // Hero trend-line series (see nwProfileId above). Already scoped by the
        // storage call, so no extra filtering.
        netWorthHistory: Array.isArray(netWorthHistory) ? netWorthHistory : [],
        month,
        filterIds: filterIds || [],
      };

      function scopeByLinkedProfiles<T extends { linkedProfiles?: string[] }>(rows: T[]): T[] {
        if (!filterIds || filterIds.length === 0) return rows || [];
        return (rows || []).filter((x: any) =>
          passesProfileFilter(x.linkedProfiles, { selectedIds: filterIds!, allProfiles: profiles })
        );
      }
    });

    // [P2] 30s TTL (was 60s). cacheBustMiddleware busts this synchronously on
    // any same-instance mutation, and version-stamped keys (cacheUserKey)
    // handle cross-instance writes — but both are best-effort under
    // serverless, so the TTL is the hard staleness ceiling. The QA spec
    // accepts 30s of bootstrap staleness; 60s exceeded that budget whenever
    // the busting paths didn't reach a warm instance.
    setCache(cacheKey, data, 30 * 1000);
    // Publish this request's raw reads for the NEXT scope (see rawCacheKey
    // above). Only on a miss — refreshing the TTL on every hit would let one
    // long browsing session extend the snapshot indefinitely past the 30s
    // staleness ceiling. An empty snapshot means `dedupe` handed us another
    // request's in-flight result and this storage never read anything, so
    // there is nothing worth publishing (and nothing to clobber).
    if (!rawSnapshot) {
      try {
        const snap = await (storage as any).snapshotRequestMemo?.();
        if (snap && Object.keys(snap).length > 0) setCache(rawCacheKey, snap, 30 * 1000);
      } catch { /* best-effort warm — never fail the response over it */ }
    }
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

  // ---- Wellness AI Deep Dive (on-demand narrative) ----
  // The Wellness tab computes deterministic findings on every load for free.
  // This endpoint is called ONLY when the user taps "AI Deep Dive": it turns the
  // same deterministic findings into a short, human narrative via Haiku, and
  // falls back to a plain summary of those findings if the model is unavailable —
  // so it never fails or blocks. Profile-scoped like every other read.
  app.post("/api/wellness/insights", asyncHandler(async (req, res) => {
    try {
      const idsRaw = (req.body?.profileIds ?? req.query.profileIds) as string | string[] | undefined;
      const ids = Array.isArray(idsRaw)
        ? idsRaw.filter((x) => typeof x === "string" && x)
        : (typeof idsRaw === "string" ? idsRaw.split(",").filter(Boolean) : []);
      const [trackers, habits, obligations, profiles] = await Promise.all([
        storage.getTrackers(), storage.getHabits(), storage.getObligations(), storage.getProfiles(),
      ]);
      const filterActive = ids.length > 0;
      const filterCtx = { selectedIds: ids, allProfiles: profiles };
      const scoped = <T extends { linkedProfiles?: string[] }>(rows: T[]) =>
        !filterActive ? rows : rows.filter((r) => passesProfileFilter((r as any).linkedProfiles, filterCtx));
      const findings = computeKeyFindings({
        trackers: scoped(trackers as any) as any,
        obligations: scoped(obligations as any) as any,
        habits: scoped(habits as any) as any,
      } as any);
      const healthFindings = findings.filter((f: any) => /tracker_|habit_/.test(String(f.kind))).slice(0, 12);
      // Deterministic fallback narrative — a plain readout of the findings.
      const fallbackNarrative = healthFindings.length === 0
        ? "Not enough logged yet to spot trends. Keep logging your trackers and check back in a few days."
        : healthFindings.slice(0, 5).map((f: any) => f.detail ? `${f.title} — ${f.detail}` : f.title).join(" ");
      if (healthFindings.length === 0) {
        return res.json({ narrative: fallbackNarrative, findingsCount: 0 });
      }
      const summary = healthFindings
        .map((f: any) => `- [${f.severity}/${f.direction}] ${f.title}${f.detail ? `: ${f.detail}` : ""}`)
        .join("\n");
      const decision = await aiDecide<{ narrative: string }>({
        task: "wellness-deep-dive",
        system: `You are a supportive health coach. You are given DETERMINISTIC findings computed from the user's own health tracker data. Write a short, warm, plain-language wellness summary (2-4 sentences) that ties the findings together and gives ONE concrete, encouraging suggestion. Do NOT invent numbers or metrics not present in the findings. Do NOT give medical diagnoses. Return ONLY JSON: {"narrative": "<text>"}`,
        user: `Findings:\n${summary}\n\nReturn JSON only: {"narrative": "<2-4 sentence summary>"}`,
        timeoutMs: 6000,
        maxTokens: 320,
        fallback: () => ({ narrative: fallbackNarrative }),
        validate: (x: any) => x && typeof x === "object" && typeof x.narrative === "string" && x.narrative.length > 0,
      });
      res.json({ narrative: decision.value.narrative, findingsCount: healthFindings.length });
    } catch (err: any) {
      log.error("[WellnessInsights]", err?.message || "unknown error");
      res.status(500).json({ error: "Failed to generate wellness insights" });
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
    // PERF 2026-07-08: per-request memo (same treatment as /api/stats) so
    // getProfileDetail's internal fanout shares one fetch per table —
    // getProfiles + asset/liability link tables were each fetched 2-3x per call.
    try { (storage as any).enableRequestMemo?.(); } catch {}
    const detail = await storage.getProfileDetail(req.params.id);
    try { (storage as any).disableRequestMemo?.(); } catch {}
    if (!detail) return res.status(404).json({ error: "Not found" });
    // S1 fix: storage layer filters by user_id; defense-in-depth ownership guard.
    if ((detail as any).userId && (detail as any).userId !== (req as AuthenticatedRequest).userId) {
      return res.status(404).json({ error: "Not found" });
    }
    // SELF-HEALING FIELD CLEANUP: years of extraction runs left profiles
    // storing the same fact under several spellings (mileage + currentMileage
    // + vehicles.mileage). Collapse agreeing twins to ONE canonical field on
    // read — the response carries the cleaned shape immediately, and the
    // write-back converges storage in the background (only fires when
    // something was actually redundant; differing values are never dropped).
    try {
      const cleanup = cleanupStoredProfileFields((detail as any).fields);
      if (cleanup.changed) {
        (detail as any).fields = cleanup.fields;
        log.info(`[profile-cleanup] ${req.params.id} collapsed ${cleanup.removed.length} redundant field(s): ${cleanup.removed.join(", ")}`);
        // Top-level removals need explicit null markers so the storage merge
        // layer deletes them; rewritten nested groups replace wholesale.
        const patch: Record<string, any> = { ...cleanup.fields };
        for (const path of cleanup.removed) {
          if (!path.includes(".") ) patch[path] = null;
        }
        storage.updateProfile(req.params.id, { fields: patch } as any).catch((e: any) =>
          console.error(`[profile-cleanup] write-back failed for ${req.params.id}: ${e?.message || e}`)
        );
      }
    } catch (cleanErr: any) {
      console.error(`[profile-cleanup] skipped: ${cleanErr?.message || cleanErr}`);
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
      // PERF 2026-07-08: per-request memo so the Promise.all below and
      // getProfileDetail's internal fanout share ONE fetch per table.
      // Without it, getProfiles ran twice (once inside getProfileDetail,
      // once here) and the ownership link tables were fetched up to 4x.
      try { (storage as any).enableRequestMemo?.(); } catch {}
      // PROFILE DETAIL has its own internal Promise.all batches (junction-table
      // lookups + entity fetch) — see supabase-storage.ts:getProfileDetail.
      // We run it in parallel with the lightweight pieces.
      const [detail, allProfiles, assetPartyLinks, liabilityProfileLinks] = await Promise.all([
        storage.getProfileDetail(profileId),
        storage.getProfiles(),
        storage.getAssetPartyLinks ? storage.getAssetPartyLinks().catch(() => [] as any[]) : Promise.resolve([] as any[]),
        storage.getLiabilityProfileLinks ? storage.getLiabilityProfileLinks().catch(() => [] as any[]) : Promise.resolve([] as any[]),
      ]);
      if (!detail) {
        try { (storage as any).disableRequestMemo?.(); } catch {}
        return null;
      }
      // S1: ownership guard — storage filters by user_id but be defensive.
      if ((detail as any).userId && (detail as any).userId !== userId) {
        try { (storage as any).disableRequestMemo?.(); } catch {}
        return null;
      }

      // PERF 2026-07-08: type-specific extras so the liability/asset profile
      // pages don't fire 4-5 follow-up serverless invocations after the
      // bootstrap lands. Party enrichment reuses the already-fetched
      // allProfiles list — zero extra round-trips for it.
      const profileType = String((detail as any).type || "");
      const enrichParties = (rows: any[]) => (rows || []).map((r: any) => {
        const p = allProfiles.find(x => x.id === r.partyProfileId);
        return { ...r, party: p ? { id: p.id, name: p.name, type: p.type } : null };
      });

      // Mirrors client/src/pages/profile-detail.tsx isAssetProfile — the set of
      // types whose page reads ["/api/assets", id, "parties"].
      const ASSET_PAGE_TYPES = new Set(["vehicle", "asset", "subscription", "loan", "investment", "property", "insurance", "medical", "account"]);
      let assetParties: any[] | undefined;
      if (ASSET_PAGE_TYPES.has(profileType)) {
        assetParties = enrichParties((assetPartyLinks as any[]).filter((l: any) => l?.assetProfileId === profileId));
      }

      let liabilityExtras: any;
      if (profileType === "liability" || profileType === "loan") {
        // Same self-heal as GET /api/liabilities/:id/parties: older bills that
        // predate the auto-ownership hook have no owner link — backfill once.
        let partyRows = (liabilityProfileLinks as any[]).filter((l: any) => l?.liabilityProfileId === profileId);
        if (partyRows.length === 0 && (storage as any).ensureLiabilityOwnerLink) {
          try {
            await (storage as any).ensureLiabilityOwnerLink(profileId);
            partyRows = await storage.getLiabilityProfileLinks(profileId);
          } catch { /* best-effort — page still renders without owner rows */ }
        }
        const [payments, schedule, assetLinks] = await Promise.all([
          (storage as any).getLiabilityPayments
            ? (storage as any).getLiabilityPayments(profileId).catch(() => [] as any[])
            : Promise.resolve([] as any[]),
          (storage as any).getLiabilitySchedule
            ? (storage as any).getLiabilitySchedule(profileId, 12).catch(() => null)
            : Promise.resolve(null),
          (storage as any).getLiabilityAssetLinks
            ? (storage as any).getLiabilityAssetLinks(profileId).catch(() => [] as any[])
            : Promise.resolve([] as any[]),
        ]);
        liabilityExtras = {
          payments,
          // schedule is null for non-recurring liabilities (the standalone
          // endpoint 404s there); the client only seeds it when present.
          schedule: schedule || null,
          parties: enrichParties(partyRows),
          assets: assetLinks,
        };
      }
      try { (storage as any).disableRequestMemo?.(); } catch {}

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
        ...(assetParties !== undefined ? { assetParties } : {}),
        ...(liabilityExtras !== undefined ? { liabilityExtras } : {}),
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
    if (!req.body.name || typeof req.body.name !== "string" || !req.body.name.trim()) {
      return res.status(400).json({ error: "Profile name is required" });
    }
    if (!req.body.type || typeof req.body.type !== "string" || !req.body.type.trim()) {
      return res.status(400).json({ error: "Profile type is required" });
    }
    req.body.name = sanitize(req.body.name);
    // Manual entry follows the exact same rule as extraction and chat: a date
    // typed as "7/18/2034" is stored as 2034-07-18, so the Date Rule engine
    // (shared/date-rules) derives the same rule whichever door the date came
    // in by. No screen-specific shortcut.
    if (req.body.fields && typeof req.body.fields === "object") {
      req.body.fields = normalizeEntityDateFields(req.body.fields as Record<string, any>).fields;
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
    // Duplicate detection policy (product decision 2026-06): duplicates are
    // ALLOWED for assets, vehicles, properties, subscriptions, loans, accounts,
    // investments, pets — everything except PEOPLE. You can legitimately own two
    // "Samsung TV"s or nest a "Tv" under a laptop. The only profiles that must
    // not duplicate are people, and ONLY on an EXACT full-name match (first +
    // last). No fuzzy/AI matching — it produced false positives like "Tv" ≈
    // "Samsung TV" that blocked valid creates.
    const existing = await storage.getProfiles();
    if (!req.body.skipDupCheck) {
      const dup = findBlockingDuplicateProfile({ name: req.body.name, type: req.body.type }, existing);
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

    // Auto-ownership now lives in a single place: storage.createProfile resolves
    // the owning party from the parent chain (resolveAutoOwner) and links it at
    // 100%. A second hook here force-linked Self, producing a competing 100% link
    // that the SUM>100 DB trigger then split 50/50 — see
    // docs/dashboard-scope-contract.md. Keeping one writer keeps SUM == 100.

    // Obligations retired (2026-07): a liability IS the bill now — the single
    // source of truth. We no longer create a separate backing obligation for a
    // liability's monthly payment, nor AI-suggest one for subscription/utility
    // profiles. Recurring-bill liabilities carry their own recurrence in fields.

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
    // `fieldPathsToDelete` removes EXACTLY those paths — no identity sweep. The
    // calendar's "remove this date" uses it, because clearing one date must not
    // take a same-named date in another group with it.
    const fieldPathsToDeleteRaw: any = (req.body && typeof req.body === "object") ? req.body.fieldPathsToDelete : undefined;
    const fieldPathsToDelete: string[] | undefined = Array.isArray(fieldPathsToDeleteRaw)
      ? fieldPathsToDeleteRaw.filter((k: any) => typeof k === "string" && k.length > 0)
      : undefined;
    const fieldsToDeleteRaw: any = (req.body && typeof req.body === "object") ? req.body.fieldsToDelete : undefined;
    const fieldsToDelete: string[] | undefined = Array.isArray(fieldsToDeleteRaw)
      ? fieldsToDeleteRaw.filter((k: any) => typeof k === "string" && k.length > 0)
      : undefined;
    {
      const parsed = insertProfileSchema.partial().safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: `Validation failed: ${JSON.stringify(parsed.error.flatten())}` });
      req.body = { ...req.body, ...parsed.data };
      if (fieldPathsToDelete && fieldPathsToDelete.length > 0) {
        (req.body as any).fieldPathsToDelete = fieldPathsToDelete;
      } else {
        delete (req.body as any).fieldPathsToDelete;
      }
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
    // Manual entry follows the exact same rule as extraction and chat: a date
    // typed as "7/18/2034" is stored as 2034-07-18, so the Date Rule engine
    // (shared/date-rules) derives the same rule whichever door the date came
    // in by. No screen-specific shortcut.
    if (req.body.fields && typeof req.body.fields === "object") {
      req.body.fields = normalizeEntityDateFields(req.body.fields as Record<string, any>).fields;
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
    // Invalidate the cached AI summary so it regenerates on next read. Stored
    // as a preference (profile_ai_<id>) with a 2h TTL — without this, edits to
    // fields like mileage / currentValue won't be reflected in the AI summary
    // for up to two hours. Empty string is treated as a cache miss in the
    // ai-summary read path (Boolean("") === false).
    try { await storage.setPreference(`profile_ai_${req.params.id}`, ""); } catch (err) { console.warn("[routes:patch-profile] failed to clear ai-summary cache:", err); }
    // Obligations retired: a liability is its own bill; no backing-obligation sync.
    res.json(updated);
  }));
  app.delete("/api/profiles/:id", asyncHandler(async (req, res) => {
    const existing = await storage.getProfile(req.params.id);
    if (!existing) return res.status(404).json({ error: "Profile not found" });
    const ok = await storage.deleteProfile(req.params.id);
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
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[profile-link]", err?.message || err);
      res.status(500).json({ error: "Link failed" });
    }
  }));

  app.post("/api/profiles/:id/unlink", asyncHandler(async (req, res) => {
    const { entityType, entityId } = req.body;
    await storage.unlinkProfileFrom(req.params.id, entityType, entityId);
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
    res.json({ avatar: avatarUrl, profile: updated });
  }));

  // Remove a profile photo (clears the avatar URL; storage object is left in
  // place so undo/restore is possible from the dashboard later).
  app.delete("/api/profiles/:id/photo", asyncHandler(async (req, res) => {
    const uid = (req as AuthenticatedRequest).userId;
    if (!uid) return res.status(401).json({ error: "Unauthorized" });
    const updated = await storage.updateProfile(req.params.id, { avatar: null as any });
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
      const client = await getAnthropicClient();

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

      let typePrompt = typePrompts[detail.type] || "Summarize this profile's key information, linked entities, and any action items.";
      // A recurring bill is NOT an amortizing loan — never describe APR, payoff
      // timeline, or total interest for it (that fabricates loan terms the row
      // doesn't have). Summarize the actual recurring schedule from fields only.
      if (detail.type === "liability" && isRecurringBillType((detail as any).type_key ?? (detail as any).typeKey)) {
        const rf: any = detail.fields || {};
        const remaining = rf.count != null ? `${rf.count} total payment(s) configured` : "open-ended (no fixed end)";
        typePrompt = `This is a RECURRING BILL / subscription, not a loan. Summarize ONLY from the stored fields: amount $${rf.monthlyAmount ?? rf.amount ?? 0} per ${rf.frequency ?? "month"}, next due ${rf.dueDate ?? rf.nextDueDate ?? "unknown"}, ${remaining}${rf.reminderLeadDays != null ? `, reminder ${rf.reminderLeadDays} day(s) before each due date` : ", no reminder set"}${rf.autopay ? ", autopay on" : ""}. Do NOT mention APR, interest, payoff date, amortization, or a principal balance — this bill has none. Do NOT invent a reminder schedule, payment count, or end date that is not in the fields above.`;
      }

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

      const client = await getAnthropicClient();
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
  // - Loads the COMPLETE asset record (fields + related expenses/documents/
  //   notes/timeline + the AI summary) and runs estimateAssetValue
  //   (live web search + AI) over all of it. Prior valuation outputs are
  //   stripped from the prompt inside the engine so the model never anchors
  //   on its own previous answer — meaningfully different details produce a
  //   different estimate.
  // - Always computed fresh: this endpoint has no result cache, and it busts
  //   the AI summary cache after persisting so no stale value survives.
  // - Persists the result onto the profile (currentValue, valuationMethod,
  //   valuationConfidence, valuationRange, valuationLow/High,
  //   valuationFactors, valuationMissingInfo, valuationDate, previousValue)
  // - Returns the new valuation so the client can show it without refetching
  app.post("/api/profiles/:id/lookup-value", asyncHandler(async (req, res) => {
    try {
      const { id } = req.params;
      const detail = await storage.getProfileDetail(id);
      if (!detail) return res.status(404).json({ error: "Profile not found" });

      const valuableTypes = ["vehicle", "asset", "property", "investment"];
      if (!valuableTypes.includes(detail.type)) {
        return res.status(400).json({ error: `Cannot estimate value for type '${detail.type}'` });
      }

      // Include the existing AI summary (if any) as context — it often
      // condenses maintenance gaps, mileage, and status the user cares about.
      let aiSummaryText: string | null = null;
      try {
        const cachedSummary = await storage.getPreference(`profile_ai_${id}`);
        if (cachedSummary) aiSummaryText = JSON.parse(cachedSummary)?.summary || null;
      } catch { /* summary is optional context */ }

      const valuation = await estimateAssetValue(
        { type: detail.type, name: detail.name, fields: detail.fields || {} },
        {
          notes: (detail as any).notes,
          aiSummary: aiSummaryText,
          expenses: (detail.relatedExpenses || []).map(e => ({
            description: e.description, amount: e.amount, category: e.category, date: e.date,
          })),
          documents: (detail.relatedDocuments || []).map(d => ({
            name: d.name, type: d.type, extractedData: d.extractedData as any,
          })),
          timeline: (detail.timeline || []).slice(-10).map(t => ({
            type: t.type, title: t.title, timestamp: t.timestamp,
          })),
        },
      );

      if (!valuation) {
        return res.status(422).json({
          error: "Could not determine a current market value from search results.",
          method: "no data",
        });
      }
      // Phase 8: accept estimatedValue === 0 as a valid "no data" placeholder.
      // We persist with low confidence so the user can edit manually instead of
      // hitting a hard 422 error. The AI fallback path always returns a record.

      const oldValue = (detail.fields as any)?.currentValue
                    ?? (detail.fields as any)?.purchasePrice
                    ?? 0;

      // Specs the live search found on the item's own listing/record pages
      // (sqft, bed/bath count, lot size, mileage…) auto-fill EMPTY profile
      // fields — never overwriting anything the user entered — so the next
      // estimate is tighter without the user re-typing public data.
      const specFills: Record<string, any> = {};
      for (const [k, v] of Object.entries(valuation.specs || {})) {
        const existing = (detail.fields as any)?.[k];
        if (existing === undefined || existing === null || String(existing).trim() === "") specFills[k] = v;
      }

      // DATA IS NOT DELETED — we merge into existing fields and preserve
      // previousValue so the user can compare against the prior estimate.
      const updatedFields = {
        ...(detail.fields || {}),
        ...specFills,
        currentValue: valuation.estimatedValue,
        valuationMethod: valuation.method,
        valuationConfidence: valuation.confidence,
        valuationRange: valuation.details,
        valuationLow: valuation.lowValue || undefined,
        valuationHigh: valuation.highValue || undefined,
        valuationFactors: valuation.factorsConsidered,
        valuationMissingInfo: valuation.missingInfo,
        valuationDate: valuation.valuationDate,
        ...(valuation.sources && valuation.sources.length ? { valuationSources: valuation.sources.join(", ") } : {}),
        previousValue: oldValue,
      };
      await storage.updateProfile(id, { fields: updatedFields });

      // Bust the AI summary cache so the next render reflects the new value.
      try { await storage.setPreference(`profile_ai_${id}`, ""); } catch { /* ignore */ }

      res.json({
        previousValue: Number(oldValue) || 0,
        currentValue: valuation.estimatedValue,
        low: valuation.lowValue || null,
        high: valuation.highValue || null,
        confidence: valuation.confidence,
        method: valuation.method,
        range: valuation.details,
        factorsConsidered: valuation.factorsConsidered,
        missingInfo: valuation.missingInfo,
        valuationDate: valuation.valuationDate,
        // Specs auto-filled from the live search (empty fields only).
        filledSpecs: specFills,
        sources: valuation.sources || [],
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
    // paginateFull, NOT paginate: the client computes AGGREGATES over this list
    // — the hub's WELLNESS score (computeHealthScore) and the Trackers tab's
    // group counts and streaks — exactly like the Finance page sums expenses.
    // paginate()'s 100-row default cap silently truncated the set those numbers
    // are computed from, so the same scope scored differently depending on
    // whether the cache had been filled by /api/dashboard-bootstrap (which seeds
    // the WHOLE list under the same key) or by a real fetch of this endpoint.
    // With 108 trackers that read as "WELLNESS — on one load, 76 on the next"
    // (QA report 2026-08-05). Explicit ?limit=/?offset= still pages.
    res.json(paginateFull(items, req, res));
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
    res.json(updated);
  }));
  app.post("/api/trackers/:id/entries", asyncHandler(async (req, res) => {
    const { values } = req.body;
    if (!values || typeof values !== "object") {
      return res.status(400).json({ error: "Values required" });
    }
    const tracker = await storage.getTracker(req.params.id);
    if (!tracker) return res.status(404).json({ error: "Tracker not found" });
    // Canonical pipeline (server/actions/tracker-entry-service.ts): the value
    // guards this handler used to carry inline (BUG-T02/T03/T04 coercion,
    // empty-entry, signs, sanity bounds) now live in
    // shared/tracker-entry-guards.ts and run for EVERY door, plus the
    // normalization chat entries always had — a UI-logged "99°F" stores as 99
    // exactly like a chat-logged one. The write stage adds the duplicate
    // window (short here: double-submit protection only), the habit
    // auto-checkin (structural, in storage), and linked-goal progress —
    // which manual entries previously never advanced.
    const prepared = await prepareTrackerEntryValues(storage, tracker as any, values);
    if (prepared.error) {
      return res.status(400).json({
        error: prepared.error,
        ...(prepared.field ? { field: prepared.field } : {}),
        ...(prepared.received ? { received: prepared.received } : {}),
      });
    }
    let entryRow: any = null;
    const mctx = beginMutationContext(storage, "rest");
    const outcome = await runMutation(mctx, {
      tool: "log_tracker_entry",
      input: { trackerId: req.params.id, values: prepared.values },
      execute: async () => {
        entryRow = await logPreparedEntry(storage, tracker as any, {
          values: prepared.values,
          profileId: typeof req.body.profileId === "string" ? req.body.profileId : undefined,
          timestamp: typeof req.body.timestamp === "string" ? req.body.timestamp : undefined,
          notes: typeof req.body.notes === "string" ? req.body.notes : undefined,
          mood: req.body.mood,
          tags: Array.isArray(req.body.tags) ? req.body.tags : undefined,
        }, { dedupWindowMs: 15_000 });
        return entryRow;
      },
    });
    if (!outcome.ok) {
      const status = outcome.error === "Tracker not found" ? 404
        : /validation|must be|required/i.test(outcome.error || "") ? 400 : 500;
      return res.status(status).json({ error: outcome.error });
    }
    noteWriteMutations(res, outcome.mutations);
    res.status(outcome.deduped ? 200 : 201).json(entryRow);
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
    res.json(updated);
  }));
  app.delete("/api/trackers/:id/entries/:entryId", asyncHandler(async (req, res) => {
    const deleted = await storage.deleteTrackerEntry(req.params.id, req.params.entryId);
    if (!deleted) return res.status(404).json({ error: "Entry not found" });
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
  // ---- Notes ----
  //
  // MANUAL CREATION USES THE SAME SERVICE AS AI CHAT. Both doors call
  // server/content-service, so dedup, profile linking and the "notes own no
  // Date Rule" rule behave identically whether a note came from the composer,
  // from chat, or from a future import.
  app.get("/api/notes", asyncHandler(async (req, res) => {
    const profileId = typeof req.query.profileId === "string" ? req.query.profileId : undefined;
    const query = typeof req.query.q === "string" ? req.query.q : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(await listNotes(storage, { profileId, query, limit }));
  }));
  app.post("/api/notes", asyncHandler(async (req, res) => {
    if (!req.body?.content || typeof req.body.content !== "string" || !req.body.content.trim()) {
      return res.status(400).json({ error: "Note content is required" });
    }
    const content = sanitize(req.body.content);
    const title = req.body.title ? sanitize(String(req.body.title)) : undefined;
    // Honour the active-profile scope header the same way every other create
    // does, so a note made while a profile is selected belongs to that profile.
    const scoped: Record<string, any> = {};
    applyActiveProfileScope(req, scoped);
    const profileId = req.body.profileId
      || (Array.isArray(scoped.linkedProfiles) ? scoped.linkedProfiles[0] : undefined)
      || null;
    // runMutation is the same post-write contract the chat door runs: the
    // note gets read-back verification, an undo-ledger row (source "rest"),
    // and a change manifest carried to the client on X-Write-Mutations. The
    // response body keeps its exact pre-existing shape.
    let noteRow: any = null;
    let wasDeduped = false;
    const mctx = beginMutationContext(storage, "rest");
    const outcome = await runMutation(mctx, {
      tool: "create_note",
      input: { content, title, profileId },
      execute: async () => {
        const result = await createNote(storage, {
          content, title, profileId,
          tags: Array.isArray(req.body.tags) ? req.body.tags.map(String) : [],
          source: "manual",
        });
        noteRow = result.note;
        wasDeduped = !!result.deduped;
        return { ...result.note, ...(wasDeduped ? { deduped: true } : {}) };
      },
    });
    if (!outcome.ok) return res.status(500).json({ error: outcome.error });
    noteWriteMutations(res, outcome.mutations);
    res.status(wasDeduped ? 200 : 201).json({ ...noteRow, deduped: wasDeduped });
  }));
  app.patch("/api/notes/:id", asyncHandler(async (req, res) => {
    const changes: Record<string, any> = {};
    if (typeof req.body?.title === "string") changes.title = sanitize(req.body.title);
    if (typeof req.body?.content === "string") changes.content = sanitize(req.body.content);
    if (typeof req.body?.append === "string") changes.append = sanitize(req.body.append);
    if (Array.isArray(req.body?.tags)) changes.tags = req.body.tags.map(String);
    let updatedRow: any = null;
    const mctx = beginMutationContext(storage, "rest");
    const outcome = await runMutation(mctx, {
      tool: "update_note",
      input: { id: req.params.id, ...changes },
      execute: async () => {
        updatedRow = await updateNote(storage, req.params.id, changes);
        return updatedRow || { error: "Note not found" };
      },
    });
    if (!outcome.ok) {
      const status = outcome.error === "Note not found" ? 404 : 500;
      return res.status(status).json({ error: outcome.error });
    }
    noteWriteMutations(res, outcome.mutations);
    res.json(updatedRow);
  }));
  app.delete("/api/notes/:id", asyncHandler(async (req, res) => {
    const mctx = beginMutationContext(storage, "rest");
    const outcome = await runMutation(mctx, {
      tool: "delete_note",
      input: { id: req.params.id },
      execute: async () => {
        const ok = await deleteNote(storage, req.params.id);
        return ok ? { id: req.params.id } : { error: "Note not found" };
      },
    });
    if (!outcome.ok) {
      const status = outcome.error === "Note not found" ? 404 : 500;
      return res.status(status).json({ error: outcome.error });
    }
    noteWriteMutations(res, outcome.mutations);
    // Notes own no Date Rule, so nothing leaves the calendar with them.
    res.json({ success: true, dateRuleImpact: "none" });
  }));

  // ---- Date Rules (derived) ----
  //
  // Read-only by design: a Date Rule is DERIVED from its canonical record
  // (shared/temporal-rules), so there is nothing here to POST. This endpoint
  // answers "what dates does this record put on my calendar, right now".
  app.get("/api/date-rules/:system/:id", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    res.json(await syncDateRulesForEntity(storage, uid, req.params.system, req.params.id));
  }));

  app.post("/api/tasks", asyncHandler(async (req, res) => {
    if (!req.body.title || typeof req.body.title !== "string" || !req.body.title.trim()) {
      return res.status(400).json({ error: "Task title required" });
    }
    const taskSanitized = wasSanitized(req.body.title) || (!!req.body.description && wasSanitized(req.body.description));
    req.body.title = sanitize(req.body.title);
    if (req.body.description) req.body.description = sanitize(req.body.description);
    applyActiveProfileScope(req, req.body);
    const parsed = insertTaskSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation failed", issues: parsed.error.issues });
    const newTask = await storage.createTask(parsed.data);
    // TEMPORAL LAYER — the same step the chat path runs. A manually-created
    // task with a due date or a recurrence must reach the Calendar, Upcoming
    // and Recurring & Important Dates exactly as an AI-created one does.
    const uid_t1 = cacheUserKey(req as AuthenticatedRequest);
    const rules_t1 = await syncDateRulesForEntity(storage, uid_t1, "task", newTask.id).catch(() => null);
    res.status(201).json({
      ...newTask,
      ...(taskSanitized ? { warning: SANITIZE_NOTICE } : {}),
      ...(rules_t1 ? { dateRules: rules_t1.rules } : {}),
    });
  }));
  app.patch("/api/tasks/:id", asyncHandler(async (req, res) => {
    // CLEARING the clock time. `dueTime` is validated as HH:MM, so "" and null
    // both fail the regex — but they are how a client says "make this all-day
    // again", and a 400 there would leave the task stuck at an hour the user
    // just removed. Normalise the clear to an explicit null and keep it out of
    // the schema's way.
    let clearDueTime = false;
    if ("dueTime" in (req.body || {}) && (req.body.dueTime === null || req.body.dueTime === "")) {
      clearDueTime = true;
      delete req.body.dueTime;
    }
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
    if (clearDueTime) req.body.dueTime = undefined;
    const updated = await storage.updateTask(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    // Re-derive after the edit: moving a due date moves the occurrence, and
    // clearing one removes it. Both fall out of the record automatically —
    // this reports the result so the caller never has to guess.
    const uid_t2 = cacheUserKey(req as AuthenticatedRequest);
    const rules_t2 = await syncDateRulesForEntity(storage, uid_t2, "task", updated.id).catch(() => null);
    res.json({ ...updated, ...(rules_t2 ? { dateRules: rules_t2.rules } : {}) });
  }));
  app.delete("/api/tasks/:id", asyncHandler(async (req, res) => {
    // Idempotent: soft-delete succeeds even if already deleted
    await storage.deleteTask(req.params.id);
    res.json({ success: true });
  }));
  app.patch("/api/tasks/:id/restore", asyncHandler(async (req, res) => {
    const ok = await storage.restoreTask(req.params.id);
    if (!ok) return res.status(404).json({ error: "Task not found" });
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
      // COST OF OWNERSHIP: when filtering expenses by a PERSON, also include the
      // expenses of the assets that person owns/contains (e.g. "$50 gas for my
      // truck" is linked to the truck, not the person). Widen the scope with the
      // owned-asset ids so the Finance page, the Spending-Breakdown popup and the
      // dashboard all show the same set. Each expense is still one row counted
      // once. Filtering by an ASSET id adds nothing (ownedAssetIds only expands
      // person selections).
      const allProfilesExp = getCached(`profiles:${uid}`) || await storage.getProfiles();
      const assetLinksExp = await storage.getAssetPartyLinks().catch(() => [] as any[]);
      const ownedExp = ownedAssetIds(expenseFilterIds, allProfilesExp as any, assetLinksExp as any[]);
      const scopeExp = ownedExp.size > 0
        ? Array.from(new Set([...expenseFilterIds, ...ownedExp]))
        : expenseFilterIds;
      items = await filterByProfileScope(items, scopeExp, uid);
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
    // Upper bound as well as lower (QA 2026-07-29 EDGE-001: a `1e10` expense was
    // accepted and rendered as -$9,999,972,024 in Cash Flow). insertExpenseSchema
    // enforces the same ceiling, but check here too so the caller gets the plain
    // message rather than a Zod issue array.
    {
      const amountError = validateTransactionAmount(req.body.amount);
      if (amountError) return res.status(400).json({ error: amountError });
    }
    if (!req.body.description || typeof req.body.description !== "string" || !req.body.description.trim()) {
      return res.status(400).json({ error: "Description required" });
    }
    // Fold the category to its canonical spelling instead of accepting several
    // at once. The old allowlist admitted BOTH "utilities" and "utility" (and
    // "other" alongside "general"), so grouped views showed the same bucket
    // twice — the reported "Utility and Utilities" / "Liability and Other".
    if (req.body.category !== undefined) {
      req.body.category = canonicalExpenseCategory(req.body.category);
    }
    if (req.body.date !== undefined) {
      const parsed_date = new Date(req.body.date);
      if (isNaN(parsed_date.getTime())) {
        return res.status(400).json({ error: "Date must be a valid date" });
      }
    }
    const expenseSanitized = wasSanitized(req.body.description) || (!!req.body.vendor && wasSanitized(req.body.vendor));
    req.body.description = sanitize(req.body.description);
    if (req.body.vendor) req.body.vendor = sanitize(req.body.vendor);

    // Profile isolation (QA 2026-07-29 PROP-005): an expense created while a
    // single profile is in scope belongs to that profile, whether or not the
    // form remembered to say so.
    applyActiveProfileScope(req, req.body);

    // Canonical pipeline (server/actions/expense-service.ts) wrapped in the
    // door-agnostic post-write contract: this door now gets the same category
    // canon and duplicate guard as chat (its window here is short — enough to
    // absorb a double-submit, never a deliberate re-entry), plus read-back
    // verification, an undo-ledger row (source "rest"), and a change manifest
    // on X-Write-Mutations. The AI categorizer is injected: it only runs when
    // keyword/profile inference found nothing.
    let expenseRow: any = null;
    let expenseDeduped = false;
    const mctx = beginMutationContext(storage, "rest");
    const outcome = await runMutation(mctx, {
      tool: "create_expense",
      input: {
        description: req.body.description, amount: req.body.amount,
        category: req.body.category, vendor: req.body.vendor, date: req.body.date,
      },
      execute: async () => {
        const result = await createExpenseRecord(storage, {
          description: req.body.description,
          amount: req.body.amount,
          category: req.body.category,
          vendor: req.body.vendor,
          date: req.body.date,
          tags: Array.isArray(req.body.tags) ? req.body.tags : [],
          linkedProfiles: Array.isArray(req.body.linkedProfiles) ? req.body.linkedProfiles : [],
        }, {
          lockUser: (req as AuthenticatedRequest).userId || "rest",
          dedupWindowMs: 15_000,
          timezone: String(req.headers["x-timezone"] || "") || undefined,
          aiCategorize: async ({ description, vendor, amount }) => {
            const decision = await aiPickIndex({
              task: "expense-create-category",
              question: "Which expense category does this transaction belong to?",
              context: `Description: "${description}"${vendor ? `\nVendor: "${vendor}"` : ""}\nAmount: $${amount}`,
              options: [...EXPENSE_CATEGORIES],
              timeoutMs: 3000,
              minConfidence: 0.55,
              fallback: () => -1,
            });
            return decision.value.index >= 0 ? EXPENSE_CATEGORIES[decision.value.index] : null;
          },
        });
        expenseRow = result.error ? null : result;
        expenseDeduped = !!result.deduped;
        return result;
      },
    });
    if (!outcome.ok) {
      const status = /duplicate/i.test(outcome.error || "") ? 409
        : /amount|validation|invalid/i.test(outcome.error || "") ? 400 : 500;
      return res.status(status).json({ error: outcome.error });
    }
    noteWriteMutations(res, outcome.mutations);
    // Tell the caller when their text was altered — never change it silently.
    res.status(expenseDeduped ? 200 : 201).json(
      expenseSanitized ? { ...expenseRow, warning: SANITIZE_NOTICE } : expenseRow,
    );
  }));
  app.patch("/api/expenses/:id", asyncHandler(async (req, res) => {
    {
      const parsed = insertExpenseSchema.partial().safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: `Validation failed: ${JSON.stringify(parsed.error.flatten())}` });
      req.body = { ...req.body, ...parsed.data };
    }
    if (req.body.amount !== undefined) {
      if (typeof req.body.amount !== "number") return res.status(400).json({ error: "Expense amount must be a positive number" });
      const amountError = validateTransactionAmount(req.body.amount);
      if (amountError) return res.status(400).json({ error: amountError });
    }
    if (req.body.description) req.body.description = sanitize(req.body.description);
    if (req.body.vendor) req.body.vendor = sanitize(req.body.vendor);
    const updated = await storage.updateExpense(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  }));
  app.delete("/api/expenses/:id", asyncHandler(async (req, res) => {
    // Idempotent: soft-delete succeeds even if already deleted
    await storage.deleteExpense(req.params.id);
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
    // Bug fix: paychecks list cache had a 3-min TTL but no busting on create —
    // newly added paychecks wouldn't appear on the Finance page until expiry.
    res.json(created);
  }));

  app.patch("/api/paychecks/:id/confirm", asyncHandler(async (req, res) => {
    const { actual_amount } = req.body;
    const updated = await storage.confirmPaycheck(req.params.id, actual_amount);
    res.json(updated);
  }));

  app.delete("/api/paychecks/:id", asyncHandler(async (req, res) => {
    // Idempotent: the row is hard-deleted with a user_id filter, so a repeat
    // DELETE is a no-op that still succeeded. `storage.deletePaycheck` returns
    // void and cannot distinguish "removed one" from "there was none", so this
    // handler must not pretend to — it reports success either way rather than
    // inventing a 404 it has no evidence for.
    await storage.deletePaycheck(req.params.id);
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
    res.json(created);
  }));

  app.patch("/api/loans/payment/:id/mark", asyncHandler(async (req, res) => {
    const updated = await storage.markLoanPayment(req.params.id);
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
    // Profile isolation: an event created while a single profile is in scope
    // belongs to that profile, same as every other create.
    applyActiveProfileScope(req, req.body);
    // Canonical pipeline (server/actions/event-service.ts) wrapped in the
    // door-agnostic contract: this door now gets the duplicate guard and
    // category canon chat always had, plus read-back verification, an undo
    // ledger row (source "rest"), and a change manifest.
    let eventRow: any = null;
    const mctx = beginMutationContext(storage, "rest");
    const outcome = await runMutation(mctx, {
      tool: "create_event",
      input: { title: req.body.title, date: req.body.date, category: req.body.category },
      execute: async () => {
        eventRow = await createEventRecord(storage, { ...req.body, source: req.body.source || "manual" });
        return eventRow;
      },
    });
    if (!outcome.ok) {
      const status = /required|valid/i.test(outcome.error || "") ? 400 : 500;
      return res.status(status).json({ error: outcome.error });
    }
    noteWriteMutations(res, outcome.mutations);
    res.status(outcome.deduped ? 200 : 201).json(eventRow);
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
    res.json(updated);
  }));
  app.delete("/api/events/:id", asyncHandler(async (req, res) => {
    const existing = await storage.getEvent(req.params.id);
    if (!existing) return res.status(404).json({ error: "Event not found" });
    await storage.deleteEvent(req.params.id);
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
      // PERF 2026-07-08: same treatment as /api/stats. getCalendarTimeline
      // fans out to 4 full-table fetches (events/tasks/obligations/profiles);
      // request-memo shares them with any concurrent handler work, the 30s
      // response cache serves repeat month-scrolls instantly, and dedupe
      // collapses concurrent identical requests. cacheBustMiddleware clears
      // the cache synchronously on every write, so staleness is bounded by
      // the next mutation, not the TTL.
      const calUserId = cacheUserKey(req as AuthenticatedRequest);
      const calCacheKey = `caltimeline:${calUserId}:${start}:${end}:${profileIds?.join(",") || "all"}:${tz}`;
      const cached = await getCachedShared(calCacheKey);
      if (cached) return res.json(cached);
      try { (storage as any).enableRequestMemo?.(); } catch {}
      const items = await dedupe(calCacheKey, () => storage.getCalendarTimeline(start, end, profileIds));
      try { (storage as any).disableRequestMemo?.(); } catch {}
      setCache(calCacheKey, items, 30 * 1000);
      res.json(items);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to load calendar" });
    }
  }));

  // ---- Date Rules ----
  //
  // The queryable face of shared/date-rules. Every actionable date in the
  // account, in ONE shape, with full traceability back to the entity and field
  // it came from — so "does a rule actually exist for Jane's licence?" is a
  // question with an answer, not an inference from what happens to render.
  //
  // Rules are DERIVED here rather than stored: the id is a pure function of
  // (source entity, source field, semantic type), so this endpoint cannot
  // return a duplicate, cannot return a rule whose source was deleted, and
  // needs no backfill for records that predate the feature.
  app.get("/api/date-rules", asyncHandler(async (req, res) => {
    const profileIdsRaw = req.query.profileIds as string | undefined;
    const profileIds = profileIdsRaw ? profileIdsRaw.split(",").filter(Boolean) : undefined;
    try {
      const [profiles, documents, events, obligations, tasks, incomes] = await Promise.all([
        storage.getProfiles(),
        storage.getDocuments(),
        storage.getEvents(),
        storage.getObligations(),
        storage.getTasks(),
        (storage as any).getIncomes?.() ?? Promise.resolve([]),
      ]);
      // Half the rules come from field-carried dates (profiles, documents);
      // the other half from the systems that already model a schedule in a
      // dedicated column (events, obligations, liabilities, tasks, income).
      // Both halves are presented as rules so callers see one list.
      const fieldRules = rulesFromAll({ profiles, documents });
      // `documents` must be passed here even though the field-carried rules
      // above already cover them: `seriesFromAll` uses the documents to work
      // out which legacy `document-extraction` events are shadows of a date the
      // record now owns. Passing an empty list left that set empty, so one real
      // expiration came back as two rules — the derived one and its copy.
      // The `rule:` series are dropped afterwards, so nothing is counted twice.
      const schedRules = rulesFromSeries(seriesFromAll({
        profiles, events, obligations, tasks, incomes, documents,
      }).filter((s) => !s.id.startsWith("rule:")));
      let rules: DateRule[] = dedupeRules([...fieldRules, ...schedRules]);
      if (profileIds && profileIds.length > 0) {
        const allow = new Set(profileIds);
        rules = rules.filter((r) =>
          (r.profileId && allow.has(r.profileId)) || (r.ownerIds || []).some((id) => allow.has(id)));
      }
      rules.sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
      res.json(rules);
    } catch (err: any) {
      log.error(`[date-rules] ${err?.message || err}`);
      res.status(500).json({ error: "Failed to load date rules" });
    }
  }));

  // ---- Documents ----
  app.get("/api/documents", asyncHandler(async (req, res) => {
    // [P2.4] Profile filter (parity with /api/obligations, /api/tasks, etc.).
    const profileIdsParam = req.query.profileIds as string | undefined;
    const fp = req.query.profileId as string | undefined;
    const docFilterIds = profileIdsParam ? profileIdsParam.split(",").filter(Boolean) : (fp ? [fp] : []);
    const uid_doc = cacheUserKey(req as AuthenticatedRequest);

    // Mirror paginate(): default 100/page, cap 500 — the documents route has no
    // route-level cache, so historically EVERY request fetched the entire
    // documents table (all rows + extracted_data) just to slice out a page.
    // X-Total-Count still carries the true total for opt-in pagers.
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    // [PERF Phase 4] Decide whether the DB-pushdown path is correctness-safe.
    // The pushed-down containment filter reproduces only the NON-orphan half of
    // the profile rule. The orphan-inclusion half (docs with empty
    // linked_profiles pass when a self-type profile is selected) can only apply
    // when the selection actually contains a self profile — so that narrow case
    // alone stays on the fetch-all + canonical orphan-rule path below.
    let hasSelfInSelection = false;
    if (docFilterIds.length > 0) {
      const allProfiles: Array<{ id: string; type?: string }> =
        getCached(`profiles:${uid_doc}`) ||
        await ((storage as any).getProfilesLite?.() ?? storage.getProfiles());
      const selfIds = new Set(allProfiles.filter(p => p.type === "self").map(p => p.id));
      hasSelfInSelection = docFilterIds.some(id => selfIds.has(id));
    }

    if (docFilterIds.length === 0 || !hasSelfInSelection) {
      // PUSHDOWN: everyone-mode, or a selection with no self profile. One
      // Supabase round-trip returns just the page (metadata only, created_at
      // desc) plus the exact total — no full-table fetch, no in-Node slice.
      const { rows, total } = await storage.getDocumentsPage({
        profileIds: docFilterIds.length > 0 ? docFilterIds : undefined,
        limit,
        offset,
      });
      res.set("X-Total-Count", String(total));
      return res.json(rows);
    }

    // NARROW CASE — selection includes a self profile, so orphan inclusion is in
    // play. Kept on the fetch-all path (filterByProfileScope) because the empty
    // linked_profiles / self-selected union is not expressed by the DB pushdown.
    let items = await storage.getDocuments();
    items = await filterByProfileScope(items, docFilterIds, uid_doc);
    // METADATA ONLY — never ship base64 blobs in a list (dev/MemStorage parity;
    // SupabaseStorage.getDocuments already excludes file_data).
    items = items.map((d: any) => (d && d.fileData ? { ...d, fileData: "" } : d));
    res.json(paginate(items, req, res));
  }));
  app.get("/api/documents/:id", asyncHandler(async (req, res) => {
    // PERF: metadata-only read. This route never returns the binary (clients
    // fetch it from /file), so it must not PAY for it either — getDocument()
    // downloads the object out of Supabase Storage and base64-encodes it, which
    // meant every "open document" tap waited on a full file transfer, then
    // waited on a SECOND one for /file. getDocumentMeta does neither.
    const doc = await storage.getDocumentMeta(req.params.id);
    if (!doc) return res.status(404).json({ error: "Not found" });
    // S1 fix: storage layer filters by user_id; defense-in-depth ownership guard.
    if ((doc as any).userId && (doc as any).userId !== (req as AuthenticatedRequest).userId) {
      return res.status(404).json({ error: "Not found" });
    }
    // `hasFile` tells the preview UI a binary exists so it renders the viewer
    // instead of "No preview available". `fileSize` is no longer computed —
    // knowing the exact byte count would require reading the file we just
    // avoided reading — so it's reported only as the boolean it was used as.
    res.json(doc);
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
    // Editing a document's expiration by hand is the same write as extracting
    // it, so it normalizes the same way — change 2034 to 2036 here and the
    // derived rule (and every view of it) moves, because the rule reads this
    // field. See shared/date-rules.
    if (req.body.extractedData && typeof req.body.extractedData === "object") {
      req.body.extractedData = normalizeEntityDateFields(
        req.body.extractedData as Record<string, any>,
        { contextKey: String(req.body.type ?? "") },
      ).fields;
    }
    const updated = await storage.updateDocument(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    // A document's dates are calendar items, so an edit to them is a calendar
    // change too.
    res.json(updated);
  }));
  app.delete("/api/documents/:id", asyncHandler(async (req, res) => {
    // Idempotent: soft-delete succeeds even if already deleted.
    const docIdToDelete = req.params.id;
    // CASCADE: remove the profile fields this document's extraction saved, so
    // a deleted document doesn't leave orphaned data behind on the asset.
    // Provenance (fields._docFields[docId] = {key: savedValue}) is written by
    // confirm-extraction; only fields whose CURRENT value still matches what
    // the document saved are removed — anything the user edited since stays.
    try {
      const profilesForCascade = await storage.getProfiles();
      for (const p of profilesForCascade as any[]) {
        const sources = p.fields?._docFields;
        const recorded = (sources && typeof sources === "object") ? sources[docIdToDelete] : undefined;
        if (!recorded || typeof recorded !== "object") continue;
        // Match the recorded field on IDENTITY, not on the literal key it was
        // saved under — see removeDocumentContributedFields.
        const cascade = removeDocumentContributedFields(p.fields as Record<string, any>, recorded);
        const nextFields = cascade.fields;
        // Top-level keys need an explicit null so the storage merge removes
        // them; nested groups are already rewritten without their entry.
        const removedKeys = cascade.removed.filter((path) => !path.includes("."));
        const nextSources: Record<string, any> = { ...sources };
        delete nextSources[docIdToDelete];
        // Null markers = deletion intents for the storage merge layer.
        const patch: Record<string, any> = { ...nextFields };
        for (const k of removedKeys) patch[k] = null;
        if (Object.keys(nextSources).length > 0) patch._docFields = nextSources;
        else { delete patch._docFields; patch._docFields = null; }
        await storage.updateProfile(p.id, { fields: patch } as any);
        if (cascade.removed.length > 0) {
          log.info(`[doc-delete-cascade] ${docIdToDelete} → removed ${cascade.removed.length} field(s) from ${p.name}: ${cascade.removed.join(", ")}`);
        }
      }
    } catch (cascadeErr: any) {
      // Cascade is best-effort — the delete itself must still succeed.
      console.error(`[doc-delete-cascade] failed for ${docIdToDelete}: ${cascadeErr?.message || cascadeErr}`);
    }
    // CASCADE 2: retire the standalone calendar events that older extractions
    // wrote for this document's dates.
    //
    // Those events are the legacy of the second date system: an expiration
    // saved BOTH as a field on the document and as an independent event with
    // no link back. Deleting the document left the event behind, still sitting
    // on the calendar with a date whose source no longer exists — the orphan
    // the user reported. New extractions no longer write them (the date is
    // derived from the document instead), so this only ever cleans up history;
    // it is scoped to events this app auto-created FROM this document, never
    // to anything the user made themselves.
    try {
      const allEvents = await storage.getEvents();
      for (const ev of allEvents as any[]) {
        const linked: string[] = Array.isArray(ev.linkedDocuments) ? ev.linkedDocuments : [];
        const tags: string[] = Array.isArray(ev.tags) ? ev.tags : [];
        if (!linked.includes(docIdToDelete)) continue;
        if (!tags.includes("document-extraction")) continue;
        // `date-rule-uncovered` events go too, deliberately. That tag exists to
        // stop the DISPLAY-time shadow pass hiding a date nothing else carries;
        // deletion is a different question, and this cascade's rule — the one
        // it already applies to profile fields above — is that a document takes
        // back exactly what it contributed. An auto-created event is
        // contributed data. Leaving it would be the orphan the user reported.
        // An event linked to OTHER documents too is not this document's to
        // delete — unlink and leave it. Deleting on "includes this id" orphaned
        // events that still belonged to a surviving document.
        const others = linked.filter((d) => d !== docIdToDelete);
        if (others.length > 0) {
          await storage.updateEvent(ev.id, { linkedDocuments: others } as any);
          log.info(`[doc-delete-cascade] ${docIdToDelete} → unlinked event ${ev.id} (still on ${others.length} document(s))`);
          continue;
        }
        await storage.deleteEvent(ev.id);
        log.info(`[doc-delete-cascade] ${docIdToDelete} → removed derived event ${ev.id} "${ev.title}"`);
      }
    } catch (evErr: any) {
      console.error(`[doc-delete-cascade] event cleanup failed for ${docIdToDelete}: ${evErr?.message || evErr}`);
    }
    await storage.deleteDocument(docIdToDelete);
    // A document carries dates, so deleting one changes the calendar, the
    // upcoming feed and the Important Dates list — not just the document list.
    // Omitting the calendar bust here is why a deleted licence's expiration
    // outlived it on screen.
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
    // PERF: getDocumentDelivery decides HOW the bytes reach the device.
    // Storage-backed documents 302 to a short-lived signed URL so the download
    // flows straight from Supabase's edge — the old path buffered the whole
    // file through this function first (Storage → serverless Buffer → device),
    // doubling the transfer and showing a spinner until the last byte of the
    // second hop. Legacy base64-in-DB rows still serve from the buffer below.
    // ?preview=1 asks for the phone-sized image variant (~10x smaller). The
    // storage layer generates it on first use and serves the original for
    // non-images or when generation isn't possible — the client can request it
    // unconditionally for images.
    const delivery = await storage.getDocumentDelivery(req.params.id, {
      preview: String((req.query as any)?.preview || "") === "1",
    });
    if (!delivery) return res.status(404).json({ error: "Not found" });
    // S1 fix: storage layer filters by user_id; defense-in-depth ownership guard.
    if (delivery.userId && delivery.userId !== (req as AuthenticatedRequest).userId) {
      return res.status(404).json({ error: "Not found" });
    }

    // PERF: a document's bytes are immutable until it's re-uploaded, and the
    // ETag folds in updated_at so a replacement invalidates instantly.
    // `no-cache` still revalidates every time (never serve a stale file), but a
    // 304 costs one small round-trip instead of re-sending megabytes over LTE —
    // which is the difference between reopening a PDF in ~100ms and in seconds.
    const etag = `"doc-${req.params.id}-${createHash("sha1").update(delivery.version).digest("hex").slice(0, 16)}"`;
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, no-cache, max-age=0");
    res.setHeader("Vary", "Authorization");
    if (req.headers["if-none-match"] === etag) return res.status(304).end();

    if (delivery.mode === "redirect") {
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.redirect(302, delivery.url);
    }

    const { buffer, mimeType, name } = delivery;
    res.setHeader("Content-Type", mimeType);
    // Sanitize filename: strip all non-alphanumeric except dots, hyphens, underscores
    const safeName = (name || 'document').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
    // Defence against MIME-confused script execution: force download for active
    // content types and strip browser sniffing on every response.
    const activeMime = new Set([
      "text/html",
      "image/svg+xml",
      "application/xhtml+xml",
    ]);
    const disposition = activeMime.has((mimeType || "").toLowerCase()) ? "attachment" : "inline";
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
    res.status(201).json(newHabit);
  }));
  app.post("/api/habits/:id/checkin", asyncHandler(async (req, res) => {
    const { date, value, notes } = req.body;
    // ONE completion pipeline (user directive 2026-08-20): checking a habit off
    // by hand goes through exactly what chat and the tracker go through, so it
    // also writes the habit's linked tracker record and can't double-count a
    // day that a chat message or a tracker log already completed.
    const result = await completeHabitOccurrence(storage, {
      habitId: req.params.id,
      date, value, notes,
      source: "habit_ui",
      timezone: getTimezone(req),
    });
    if (!result.ok && result.reason === "not_found") return res.status(404).json({ error: "Habit not found" });
    const updatedHabit = result.habit || await storage.getHabit(req.params.id);
    if (!updatedHabit) return res.status(404).json({ error: "Habit not found" });
    // The mirrored entry changes tracker reads too — without this the Trackers
    // page serves a cached list that predates the check-in.
    res.status(201).json({
      ...updatedHabit,
      // What actually happened, so the client can report it honestly rather
      // than assuming every tap recorded something.
      completion: {
        recorded: result.recorded,
        alreadyComplete: result.alreadyComplete,
        notScheduled: result.reason === "not_scheduled",
        date: result.date,
        progress: result.progress,
        tracker: result.tracker,
        trackerEntryIds: result.trackerEntries.map(e => e.id),
      },
    });
  }));
  app.delete("/api/habits/:id/checkin/:checkinId", asyncHandler(async (req, res) => {
    const ok = await storage.deleteHabitCheckin(req.params.id, req.params.checkinId);
    if (!ok) return res.status(404).json({ error: "Checkin not found" });
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
      res.json(result);
    } catch (e: any) { console.error("[habits]", e?.message || e); res.status(500).json({ error: "Failed to update habit" }); }
  }));
  app.delete("/api/habits/:id", asyncHandler(async (req, res) => {
    const existing = await storage.getHabit(req.params.id);
    if (!existing) return res.status(404).json({ error: "Habit not found" });
    await storage.deleteHabit(req.params.id);
    res.json({ success: true });
  }));
  app.patch("/api/habits/:id/restore", asyncHandler(async (req, res) => {
    const ok = await storage.restoreHabit(req.params.id);
    if (!ok) return res.status(404).json({ error: "Habit not found" });
    // Bug fix: missing `enhanced:` bust meant a restored habit could remain
    // missing from the dashboard until the 15-second cache expired.
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
    // Fold the category before validation so a form that still posts "utility"
    // (or an importer posting "subscriptions") is stored under the one
    // canonical spelling — shared/category-canon.
    if (req.body?.category !== undefined) {
      req.body.category = canonicalObligationCategory(req.body.category);
    }
    applyActiveProfileScope(req, req.body);
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
    res.status(201).json(created);
  }));

  // ---- Reminders: GONE -----------------------------------------------------
  // GET/POST/PATCH/DELETE /api/reminders were removed on 2026-08-09 along with
  // the entity. Portol has EVENTS and TASKS; a "remind me at 9am" is a task
  // with `dueTime`, so the task routes serve every one of those calls. A
  // deliberate 410 (rather than a 404) tells a stale client the difference
  // between "this moved" and "this is broken", and names where to go.
  const remindersGone: any = (_req: any, res: any) => res.status(410).json({
    error: "Reminders were replaced by timed tasks. Use /api/tasks with dueDate + dueTime.",
  });
  app.all("/api/reminders", remindersGone);
  app.all("/api/reminders/:id", remindersGone);

  app.patch("/api/obligations/:id", asyncHandler(async (req, res) => {
    if (req.body?.category !== undefined) {
      req.body.category = canonicalObligationCategory(req.body.category);
    }
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
    // Payments now live in liability_payments (obligations retired) — a bill's
    // payment history is projected from there.
    const { error } = await (storage as any).supabase
      .from("liability_payments")
      .delete()
      .eq("id", latest.id)
      .eq("user_id", uid);
    if (error) {
      console.error("[api] undo payment failed:", error.message);
      return res.status(500).json({ error: "Failed to undo payment" });
    }
    // Also clear the dedupe entry so the user can immediately re-pay.
    recentPayments.delete(`${uid}:${req.params.id}`);
    res.json({ success: true, deletedPaymentId: latest.id });
  }));

  app.delete("/api/obligations/:id", asyncHandler(async (req, res) => {
    const existing = await storage.getObligation(req.params.id);
    if (!existing) return res.status(404).json({ error: "Obligation not found" });
    await storage.deleteObligation(req.params.id);
    res.json({ success: true });
  }));

  // ─── Obligation Occurrences (Wave 16) ────────────────────────────────────
  // Per-instance status tracking so a single recurring obligation can have
  // some occurrences marked done, some skipped, some rescheduled, etc.
  // These power the new dashboard "Due today / Overdue / Upcoming" cards
  // and the calendar chips.
  // Split a synthetic occurrenceId "<liabilityId>:<YYYY-MM-DD>" (UUIDs/dates
  // carry no colon, so the single colon is unambiguous).
  const parseOccId = (occId: string): { liabilityId: string; date: string } | null => {
    const i = String(occId || "").indexOf(":");
    if (i < 0) return null;
    const liabilityId = occId.slice(0, i);
    const date = occId.slice(i + 1).slice(0, 10);
    if (!liabilityId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    return { liabilityId, date };
  };

  // Generated occurrences across every recurring bill in a window (no occurrence
  // table). Used by the legacy occurrence panels; the live calendar reads
  // /api/calendar-timeline which emits the same occurrences.
  app.get("/api/obligation-occurrences", asyncHandler(async (req, res) => {
    const tz = getTimezone(req);
    const today = getUserToday(tz);
    const start = (req.query.start as string) && /^\d{4}-\d{2}-\d{2}$/.test(req.query.start as string)
      ? (req.query.start as string) : today;
    const end = (req.query.end as string) && /^\d{4}-\d{2}-\d{2}$/.test(req.query.end as string)
      ? (req.query.end as string) : toLocalDateStr(new Date(Date.now() + 90 * 86400000), tz);
    const profileIdsParam = req.query.profileIds as string | undefined;
    const fp = req.query.profileId as string | undefined;
    const ids = profileIdsParam ? profileIdsParam.split(",").filter(Boolean) : (fp ? [fp] : null);
    const profiles = await storage.getProfiles();
    const obligations = await storage.getObligations();
    const payByLiab = new Map<string, any[]>();
    for (const ob of obligations) payByLiab.set(ob.id, (ob.payments || []).map((p: any) => ({ paymentDate: p.date, id: p.id })));
    const selfId = profiles.find(p => p.type === "self")?.id;
    const items: any[] = [];
    for (const p of profiles as any[]) {
      if (!isRecurringBillType(p.type_key ?? p.typeKey)) continue;
      const owner = p.parentProfileId || selfId;
      if (ids && !(owner && ids.includes(owner))) continue;
      const occ = generateSchedule({ id: p.id, fields: p.fields }, payByLiab.get(p.id) || [], { todayISO: today, windowStart: start, windowEnd: end });
      for (const o of occ) {
        items.push({
          id: o.occurrenceId, obligation_id: p.id, due_at: o.effectiveDate,
          status: o.status === "paid" ? "done" : o.status === "overdue" ? "late" : o.status === "skipped" ? "skipped" : "pending",
          amount: o.amount, notes: o.notes,
          obligation: { id: p.id, name: p.name, linked_profiles: owner ? [owner] : [] },
        });
      }
    }
    items.sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
    res.json(items);
  }));

  // Materialize is a no-op now — occurrences are generated, never persisted.
  app.post("/api/obligations/:id/materialize", asyncHandler(async (req, res) => {
    res.json({ ok: true, generated: true, note: "Occurrences are generated on the fly; nothing to materialize." });
  }));

  // Back-compat shim: the calendar's Done/Skip buttons POST a synthetic
  // occurrenceId "<liabilityId>:<date>". Route to pay/skip on the liability.
  app.post("/api/obligation-occurrences/:occId/status", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const { status, actualAmount, method } = req.body || {};
    const allowed = ["done", "skipped", "pending", "late"];
    if (!allowed.includes(status)) return res.status(400).json({ error: `status must be one of ${allowed.join(", ")}` });
    const parsed = parseOccId(req.params.occId);
    if (!parsed) return res.status(400).json({ error: "Unrecognized occurrence id" });
    let result;
    if (status === "done") result = await (storage as any).payOccurrence(parsed.liabilityId, parsed.date, { amount: actualAmount, method });
    else if (status === "skipped") result = await (storage as any).skipOccurrence(parsed.liabilityId, parsed.date);
    else result = await (storage as any).getLiabilitySchedule(parsed.liabilityId); // pending/late = no-op read
    if (!result) return res.status(404).json({ error: "Bill not found" });
    res.json(result);
  }));

  app.post("/api/obligation-occurrences/:occId/reschedule", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const { newDueAt } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(newDueAt || ""))) return res.status(400).json({ error: "newDueAt must be YYYY-MM-DD" });
    const parsed = parseOccId(req.params.occId);
    if (!parsed) return res.status(400).json({ error: "Unrecognized occurrence id" });
    const result = await (storage as any).rescheduleOccurrence(parsed.liabilityId, parsed.date, newDueAt);
    if (!result) return res.status(404).json({ error: "Bill not found" });
    res.json(result);
  }));

  // ---- Recurring-liability schedule & per-occurrence operations ----
  app.get("/api/liabilities/:id/schedule", asyncHandler(async (req, res) => {
    const months = Math.min(36, Math.max(1, Number(req.query.months) || 12));
    const result = await (storage as any).getLiabilitySchedule(req.params.id, months);
    if (!result) return res.status(404).json({ error: "Recurring liability not found" });
    res.json(result);
  }));

  app.post("/api/liabilities/:id/occurrences/:date/pay", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    const { amount, method, paymentDate, accountId } = req.body || {};
    if (amount !== undefined && (typeof amount !== "number" || amount < 0)) return res.status(400).json({ error: "amount must be a non-negative number" });
    const result = await (storage as any).payOccurrence(req.params.id, req.params.date, { amount, method, paymentDate, accountId });
    if (!result) return res.status(404).json({ error: "Recurring liability not found" });
    res.json(result);
  }));

  app.post("/api/liabilities/:id/occurrences/:date/skip", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    const result = await (storage as any).skipOccurrence(req.params.id, req.params.date);
    if (!result) return res.status(404).json({ error: "Recurring liability not found" });
    res.json(result);
  }));

  app.patch("/api/liabilities/:id/occurrences/:date", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    const { movedTo, amount, notes, estimatedAmount, actualAmount } = req.body || {};
    let result;
    if (movedTo !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(movedTo))) return res.status(400).json({ error: "movedTo must be YYYY-MM-DD" });
      result = await (storage as any).rescheduleOccurrence(req.params.id, req.params.date, movedTo);
    }
    if (amount !== undefined || notes !== undefined) {
      result = await (storage as any).setOccurrenceFields(req.params.id, req.params.date, { amount, notes });
    }
    // Estimated vs actual are separate, on purpose. Writing the estimate must
    // never masquerade as the bill having posted, and writing the actual must
    // freeze the period rather than nudge a forecast.
    if (estimatedAmount !== undefined) {
      const n = estimatedAmount === null ? null : Number(estimatedAmount);
      if (n !== null && (!Number.isFinite(n) || n < 0)) return res.status(400).json({ error: "estimatedAmount must be a non-negative number or null" });
      result = await (storage as any).setOccurrenceEstimate(req.params.id, req.params.date, n);
    }
    if (actualAmount !== undefined) {
      const n = actualAmount === null ? null : Number(actualAmount);
      if (n !== null && (!Number.isFinite(n) || n < 0)) return res.status(400).json({ error: "actualAmount must be a non-negative number or null" });
      result = await (storage as any).setOccurrenceActual(req.params.id, req.params.date, n);
    }
    if (!result) return res.status(404).json({ error: "Recurring liability not found (or nothing to change)" });
    res.json(result);
  }));

  // ---- Usage / credits / fee charges on ONE billing period ----
  // The charge lands on the occurrence for that period and nowhere else, which
  // is what keeps "another $30 of credits this month" from rewriting last
  // month's bill or inflating next month's estimate.
  app.post("/api/liabilities/:id/occurrences/:date/charges", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    const { amount, kind, label, date, notes } = req.body || {};
    const n = Number(amount);
    if (!Number.isFinite(n) || n === 0) return res.status(400).json({ error: "amount must be a non-zero number" });
    const result = await (storage as any).addOccurrenceCharge(req.params.id, req.params.date, {
      amount: n, kind, label, date, notes, source: "user",
    });
    if (!result) return res.status(404).json({ error: "Liability not found" });
    res.json(result);
  }));

  app.delete("/api/liabilities/:id/occurrences/:date/charges/:chargeId", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    const result = await (storage as any).removeOccurrenceCharge(req.params.id, req.params.date, req.params.chargeId);
    if (!result) return res.status(404).json({ error: "Liability not found" });
    res.json(result);
  }));

  app.post("/api/liabilities/:id/pause", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const { until } = req.body || {};
    if (until !== undefined && until !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(until))) return res.status(400).json({ error: "until must be YYYY-MM-DD" });
    const result = await (storage as any).pauseLiability(req.params.id, until || undefined);
    if (!result) return res.status(404).json({ error: "Recurring liability not found" });
    res.json(result);
  }));

  app.post("/api/liabilities/:id/resume", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const result = await (storage as any).resumeLiability(req.params.id);
    if (!result) return res.status(404).json({ error: "Recurring liability not found" });
    res.json(result);
  }));

  // ---- Financial accounts (manual) ----
  //
  // Accounts ARE profiles (`type: "account"`), so read/delete deliberately go
  // through the profile endpoints — there is one account record, not an account
  // record plus a profile shadow of it. These routes add only the shaping and
  // the balance ledger that the generic profile endpoints don't know about.
  app.get("/api/accounts", asyncHandler(async (req, res) => {
    const accounts = await (storage as any).getAccounts();
    const summary = summarizeAccounts(accounts.map((a: any) => a.profile));
    res.json({ accounts, summary });
  }));

  app.post("/api/accounts", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const { name, accountKind, institution, balance, availableBalance, creditLimit,
      accountNumberLast4, balanceAsOf, currency, notes, ownerProfileId } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "name is required" });
    if (balance !== undefined && balance !== null && !Number.isFinite(Number(balance))) {
      return res.status(400).json({ error: "balance must be a number" });
    }
    const created = await (storage as any).createAccount({
      name, accountKind, institution, balance, availableBalance, creditLimit,
      accountNumberLast4, balanceAsOf, currency, notes, ownerProfileId,
    });
    res.status(201).json(created);
  }));

  app.patch("/api/accounts/:id", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const updated = await (storage as any).updateAccount(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: "Account not found" });
    res.json(updated);
  }));

  app.delete("/api/accounts/:id", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const existing = await storage.getProfile(req.params.id);
    // isAccountProfile, not a bare type check: an investment/brokerage profile
    // is an account too, and it appears in the Accounts list — so it has to be
    // deletable from there.
    if (!existing || !isAccountProfile(existing)) return res.status(404).json({ error: "Account not found" });
    const ok = await storage.deleteProfile(req.params.id);
    if (!ok) return res.status(404).json({ error: "Account not found" });
    res.json({ success: true });
  }));

  // A balance CHANGE is an event with a reason, not a field overwrite: the
  // before/after pair is kept so "why is this $40 lower" stays answerable.
  app.post("/api/accounts/:id/adjust", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const { newBalance, delta, date, reason } = req.body || {};
    if (newBalance == null && delta == null) {
      return res.status(400).json({ error: "Pass newBalance (set to) or delta (move by)" });
    }
    if (newBalance != null && !Number.isFinite(Number(newBalance))) return res.status(400).json({ error: "newBalance must be a number" });
    if (delta != null && !Number.isFinite(Number(delta))) return res.status(400).json({ error: "delta must be a number" });
    const updated = await (storage as any).adjustAccountBalance(req.params.id, {
      newBalance, delta, date, reason, source: "user",
    });
    if (!updated) return res.status(404).json({ error: "Account not found" });
    res.json(updated);
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
    res.json(updated);
  }));
  app.post("/api/artifacts/:id/toggle/:itemId", asyncHandler(async (req, res) => {
    const result = await storage.toggleChecklistItem(req.params.id, req.params.itemId);
    if (!result) return res.status(404).json({ error: "Not found" });
    res.json(result);
  }));
  app.delete("/api/artifacts/:id", asyncHandler(async (req, res) => {
    const existing = await storage.getArtifact(req.params.id);
    if (!existing) return res.status(404).json({ error: "Artifact not found" });
    await storage.deleteArtifact(req.params.id);
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
    res.json({ token, path: `/share/${token}` });
  }));
  app.delete("/api/artifacts/:id/share", asyncHandler(async (req, res) => {
    const existing = await storage.getArtifact(req.params.id);
    if (!existing) return res.status(404).json({ error: "Not found" });
    if (typeof storage.setArtifactShareToken === "function") {
      await storage.setArtifactShareToken(req.params.id, null);
    }
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
    // Mood auto-detection (user request 2026-07-16): when the writer didn't
    // pick a mood, stamp one from the text — same shared detector the chat
    // fast-path and the journal composer use.
    if (!req.body.mood) req.body.mood = detectMoodFromText(req.body.content);
    const parsed = insertJournalEntrySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation failed", issues: parsed.error.issues });
    // SAME SERVICE AS CHAT. `entryDate` (or the legacy `date`) is the day the
    // experience happened; a second write for a day that already has an entry
    // appends, because journal_entries is UNIQUE on (user_id, date) and
    // "add this to today's journal" should append anyway.
    const entryDate = String(req.body.entryDate || parsed.data.date || getUserToday(getTimezone(req))).slice(0, 10);
    const linkedProfileId = Array.isArray(req.body.linkedProfiles) && req.body.linkedProfiles.length > 0
      ? String(req.body.linkedProfiles[0]) : null;
    const { entry: newEntry, appended } = await upsertJournalEntry(storage, {
      content: parsed.data.content || "",
      mood: parsed.data.mood,
      entryDate,
      profileId: linkedProfileId,
      energy: parsed.data.energy,
      gratitude: parsed.data.gratitude,
      highlights: parsed.data.highlights,
    });
    // Additional owners beyond the first (the service links only the primary).
    if (Array.isArray(req.body.linkedProfiles) && req.body.linkedProfiles.length > 1) {
      const merged = Array.from(new Set([...(((newEntry as any).linkedProfiles) || []), ...req.body.linkedProfiles.map(String)]));
      await storage.updateJournalEntry(newEntry.id, { linkedProfiles: merged } as any);
    }
    // A journal entry's date is not a calendar commitment — it never creates a
    // Date Rule. Stated in the response so no caller has to infer it.
    res.status(appended ? 200 : 201).json({ ...newEntry, appended, dateRules: [] });
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
    res.json(updated);
  }));
  app.delete("/api/journal/:id", asyncHandler(async (req, res) => {
    // Single-call delete — storage.deleteJournalEntry uses .select() to tell
    // us whether a row was actually removed, so we avoid the TOCTOU race that
    // existed when we used getJournalEntries() to pre-check existence.
    const removed = await storage.deleteJournalEntry(req.params.id);
    if (!removed) return res.status(404).json({ error: "Journal entry not found" });
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

      // Notification building lives in server/notification-service.ts so the
      // AI chat's dismiss_notifications tool computes the SAME list with the
      // SAME deterministic ids. Caching + profile filter stay here.
      const notifTz = getTimezone(req);
      const deduped = await buildNotifications(storage, notifTz);

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
        // Custom (user-created) notifications aren't entity-derived — they
        // survive every profile filter rather than silently vanishing.
        const filtered = deduped.filter(n => n.type === "custom" || matchesProfile(n.entityType, n.entityId));
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

      // Canonical category set — the same vocabulary POST /api/expenses folds
      // to (shared/category-canon), so an import can't introduce a spelling the
      // rest of the app treats as a separate bucket.
      const ALLOWED_CATEGORIES = [...EXPENSE_CATEGORIES];

      // Deterministic fallback (used if AI is unavailable / times out).
      // One category vocabulary for every door — this importer's local
      // keyword table was merged into shared/expense-canon.ts.
      const keywordCategory = (desc: string): string =>
        inferExpenseCategory({ description: desc }) ?? "general";

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
            const cat = canonicalExpenseCategory(v);
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
          // Fold through the one vocabulary so a CSV column reading "Utility"
          // lands in the same bucket as the app's "utilities".
          const category = canonicalExpenseCategory(csvCategory || aiCat || keywordCategory(description));

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

      const client = await getAnthropicClient();
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

      let [profiles, expenses, obligations, documents, trackers, goals, tasks, habits] = await Promise.all([
        storage.getProfiles(),
        storage.getExpenses(),
        storage.getObligations(),
        storage.getDocuments(),
        storage.getTrackers(),
        storage.getGoals(),
        storage.getTasks(),
        storage.getHabits(),
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
        tasks = tasks.filter((t: any) => inProfile(t.linkedProfiles));
        habits = habits.filter((h: any) => inProfile(h.linkedProfiles));
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
        // ── Briefing + health signals (the Executive tab's own view) ─────────
        // Counts and short labels only. The STRICT RULES below let the model
        // state facts that are derivable from this object and nothing else, so
        // anything it cannot count here it must not mention.
        ...(() => {
          const tz = getTimezone(req);
          const todayISO = getUserToday(tz);
          const dayDelta = (d: any) => {
            const s = String(d || "").slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
            return Math.round(
              (new Date(`${s}T12:00:00`).getTime() - new Date(`${todayISO}T12:00:00`).getTime()) / 86400000,
            );
          };
          const openTasks = tasks.filter((t: any) => t?.status !== "done");
          const activeObs = obligations.filter((o: any) => o?.status !== "cancelled" && o?.status !== "paused");
          const meds = activeObs.filter((o: any) => String(o.kind || "").toLowerCase() === "medication");
          const takenToday = (o: any) =>
            (o.payments || []).some((p: any) => String(p?.date || "").slice(0, 10) === todayISO);
          // Abnormal = the band the server already stamped on the entry at write
          // time, never a threshold re-invented here.
          let abnormalReadingCount = 0;
          const abnormalMetrics: string[] = [];
          for (const t of trackers as any[]) {
            const last = (t.entries || []).slice(-1)[0];
            const c = last?.computed || {};
            const bp = String(c.bloodPressureCategory || "");
            if (bp === "crisis" || bp === "high_stage2" || bp === "high_stage1"
                || String(c.sleepQuality || "") === "poor") {
              abnormalReadingCount++;
              if (t.name && abnormalMetrics.length < 5) abnormalMetrics.push(String(t.name).slice(0, 40));
            }
          }
          return {
            overdueTaskCount: openTasks.filter((t: any) => (dayDelta(t.dueDate) ?? 1) < 0).length,
            tasksDueTodayCount: openTasks.filter((t: any) => dayDelta(t.dueDate) === 0).length,
            overdueObligationCount: activeObs.filter((o: any) => (dayDelta(o.nextDueDate) ?? 1) < 0).length,
            expiringDocCount: documents.filter((d: any) => {
              const du = dayDelta(d.expirationDate);
              return du != null && du >= 0 && du <= 30;
            }).length,
            habitCount: habits.length,
            medicationCount: meds.length,
            medicationsNotLoggedTodayCount: meds.filter((o: any) => !takenToday(o)).length,
            appointmentCount: activeObs.filter((o: any) => {
              const du = dayDelta(o.nextDueDate);
              return String(o.kind || "").toLowerCase() === "appointment" && du != null && du >= 0 && du <= 14;
            }).length,
            abnormalReadingCount,
            abnormalMetrics,
          };
        })(),
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

      // Nothing registered, nothing to advise on. Short-circuits BEFORE the
      // model call so a brand-new account never spends a request to be told it
      // has no data.
      const hasAnything = expenses.length || obligations.length || documents.length
        || trackers.length || goals.length || tasks.length || habits.length;
      if (!hasAnything) {
        return res.json({ suggestions: [], generatedAt: new Date().toISOString(), source: "empty", fingerprint: snapshotFingerprint });
      }

      const decision = await aiDecide<{ suggestions: Array<{ title: string; body: string; action: string; priority: "high" | "medium" | "low" }> }>({
        task: "dashboard-ai-suggestions",
        system: `You are a household operations coach surfacing 3 to 5 actionable improvements based ONLY on the snapshot data provided. The snapshot covers money, admin, and health.
Return ONLY JSON: {"suggestions":[{"title":"<8 words max>","body":"<one short sentence>","action":"<short verb phrase>","priority":"high"|"medium"|"low"}]}
STRICT RULES (BUG-007/008 — factual accuracy):
- Only state facts that are directly derivable from the snapshot counts/fields. Never invent counts, amounts, dates, vendors, or category names.
- If a count is 0 (e.g. unlinkedDocCount=0), do NOT suggest fixing that issue.
- Never reference data not present in the snapshot.
- If the snapshot is sparse, return fewer suggestions rather than fabricating ones.
HEALTH RULES:
- Never give a medical diagnosis, name a condition, or suggest starting, stopping or changing a dose.
- abnormalMetrics names the trackers whose latest reading the app already flagged out of range. You may say a reading is flagged and suggest logging or reviewing it with a clinician. Do NOT interpret the value.
- Treat medicationsNotLoggedTodayCount as an unlogged dose, which is not the same as a missed one. Word it as logging, not as a lapse.
Focus on:
- expenses categorised as "other"/"general" → re-categorize (only if otherCategoryExpenses > 0)
- documents not linked to any profile → link them (only if unlinkedDocCount > 0)
- recurring vendors in recentExpenses with no matching obligation → add as subscription
- empty trackers → archive or use (only if emptyTrackerCount > 0)
- overdue tasks or obligations, and documents expiring within 30 days
- medications with no dose logged today, and readings flagged out of range
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
    // PERF (2026-08-17): this endpoint had no cache at all, yet it's fetched
    // by BOTH the Finance page and the always-mounted KPI strip. Cache the raw
    // list (same pattern as /api/expenses); filtering below stays per-request.
    const incomesUid = cacheUserKey(req as AuthenticatedRequest);
    const incomesCk = `incomes:${incomesUid}`;
    const incomesHit = getCached(incomesCk);
    let incomes = incomesHit || await dedupe(incomesCk, () => storage.getIncomes());
    if (!incomesHit) setCache(incomesCk, incomes, 5 * 60 * 1000);
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

  app.post("/api/incomes", asyncHandler(async (req, res) => {
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
    {
      const amountError = validateTransactionAmount(amt);
      if (amountError) return res.status(400).json({ error: amountError });
    }
    req.body.amount = amt;
    req.body.description = sanitize(req.body.description);
    applyActiveProfileScope(req, req.body);
    const income = await storage.createIncome(req.body);
    res.status(201).json(income);
  }));

  app.patch("/api/incomes/:id", asyncHandler(async (req, res) => {
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({ error: "Request body must be a JSON object" });
    }
    if (req.body.amount !== undefined) {
      const amt = typeof req.body.amount === "number" ? req.body.amount : Number(req.body.amount);
      const amountError = validateTransactionAmount(amt);
      if (amountError) return res.status(400).json({ error: amountError });
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
    res.json(income);
  }));

  app.delete("/api/incomes/:id", asyncHandler(async (req, res) => {
    const ok = await storage.deleteIncome(req.params.id);
    // Was `res.json({ success: ok })` — HTTP 200 carrying `success: false`.
    // The client checks the HTTP status, so a delete that removed nothing read
    // as a delete that worked: the toast said "Deleted", the refetch brought
    // the row straight back, and it looked like the app was ignoring the user.
    // A failed delete has to fail loudly. Pinned by tests/crud-coverage.test.ts.
    if (!ok) return res.status(404).json({ error: "Income not found" });
    res.json({ success: true });
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
    let rows = await storage.getLiabilityProfileLinks(req.params.id);
    // Self-heal: older recurring bills that resolved to an existing shell (or
    // predate the auto-ownership hook) never got an owner link, so the profile
    // showed "No linked people" / "Ownership not set" even though it's clearly
    // owned by the person it's filed under. Backfill the implied owner once, on
    // first read, so ownership is saved + displayed consistently.
    if (!rows || rows.length === 0) {
      await storage.ensureLiabilityOwnerLink(req.params.id).catch(() => {});
      rows = await storage.getLiabilityProfileLinks(req.params.id);
    }
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
    try {
      const row = await storage.createLiabilityProfileLink(parsed.data);
      res.json(row);
    } catch (err: any) {
      if (isOwnershipOverflow(err)) return res.status(400).json({ error: OWNERSHIP_OVERFLOW_MSG });
      throw err;
    }
  }));
  app.patch("/api/liability-profile-links/:id", asyncHandler(async (req, res) => {
    try {
      const updated = await storage.updateLiabilityProfileLink(req.params.id, req.body || {});
      if (!updated) return res.status(404).json({ error: "Not found" });
      res.json(updated);
    } catch (err: any) {
      if (isOwnershipOverflow(err)) return res.status(400).json({ error: OWNERSHIP_OVERFLOW_MSG });
      throw err;
    }
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

    // Payment behavior branches on the liability family (type_key). A recurring
    // service bill (utility / phone / streaming) has no balance to pay down —
    // paying it just LOGS the charge and ADVANCES the next due date by one cycle.
    // Amortizing / revolving / one-time debts reduce a real balance.
    const recurring = isRecurringBill((liability as any).type_key ?? (liability as any).typeKey);
    const data = { ...parsed.data };

    if (recurring) {
      // No permanent balance: record the full amount as principal (no interest,
      // no remainingBalanceAfter) and roll the due date forward.
      data.principalPortion = data.amount;
      data.interestPortion = 0;
      const row = await storage.createLiabilityPayment(data);
      const todayISO = getUserToday(getTimezone(req));
      const nextDue = advanceLiabilityDueDate(liability.fields, todayISO);
      await storage.updateProfile(req.params.id, {
        fields: {
          ...(liability.fields || {}),
          dueDate: nextDue,
          nextDueDate: nextDue,
          lastPaidDate: (data as any).paymentDate || todayISO,
          status: "upcoming",
        },
      });
      return res.json(row);
    }

    // SINGLE SOURCE OF TRUTH: the server — not the client — owns the
    // principal/interest split AND the resulting balance. The client used to
    // compute these and ship them, but a field-name mismatch silently dropped
    // them to $0 and stale client balances caused drift. Compute them here from
    // the liability's own balance + APR so every reader (profile page, payment
    // history, dashboard totals, net worth, linked page) agrees.
    const balanceBefore = resolveLiabilityBalance(liability);
    const annualRate = resolveAnnualRate(liability.fields);
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
  // A new asset/liability is auto-owned 100% by its self profile, so adding a
  // second owner trips the DB ownership-sum guard (check_violation, code 23514).
  // Previously that bubbled up as a raw 500 "Internal server error" — the
  // add-co-owner button appeared to silently fail. Detect it and return an
  // actionable 400 instead.
  const isOwnershipOverflow = (err: any): boolean => {
    const msg = String(err?.message || err?.details || err?.hint || "").toLowerCase();
    return err?.code === "23514" || msg.includes("would total") || msg.includes("exceed 100") || msg.includes("must not exceed");
  };
  const OWNERSHIP_OVERFLOW_MSG =
    "Total ownership would exceed 100%. Lower an existing owner's share first, then add the co-owner.";

  app.post("/api/asset-party-links", asyncHandler(async (req, res) => {
    const parsed = insertAssetPartyLinkSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const [assetOwned, partyOwned] = await Promise.all([
      storage.getProfile(parsed.data.assetProfileId),
      storage.getProfile(parsed.data.partyProfileId),
    ]);
    if (!assetOwned || !partyOwned) return res.status(404).json({ error: "Resource not found" });
    try {
      const row = await storage.createAssetPartyLink(parsed.data);
      res.json(row);
    } catch (err: any) {
      if (isOwnershipOverflow(err)) return res.status(400).json({ error: OWNERSHIP_OVERFLOW_MSG });
      throw err;
    }
  }));
  app.patch("/api/asset-party-links/:id", asyncHandler(async (req, res) => {
    try {
      const updated = await storage.updateAssetPartyLink(req.params.id, req.body || {});
      if (!updated) return res.status(404).json({ error: "Not found" });
      res.json(updated);
    } catch (err: any) {
      if (isOwnershipOverflow(err)) return res.status(400).json({ error: OWNERSHIP_OVERFLOW_MSG });
      throw err;
    }
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

  // ── Stripe Financial Connections (/api/finance/*) ──────────────────────────
  // Bank connections, account/transaction sync, and the signed Stripe webhook.
  // Registered here (before the error handler) so it shares this app's auth
  // middleware, CORS and no-store cache headers. The webhook route inside is
  // exempted from bearer auth in server/auth.ts and authenticates by signature.
  registerFinanceRoutes(app);

  // Global async error handler — catches unhandled promise rejections from route handlers
  app.use((err: any, _req: any, res: any, _next: any) => {
    console.error(`[API Error]`, err?.message || err);
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message || "Internal server error" });
    }
  });

  return httpServer;
}

