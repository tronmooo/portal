import { z } from "zod";
import express, { type Express, type Request } from "express";
import { fieldPatchBetween } from "../shared/field-patch";
import { shouldAppendClarifyingQuestion, appendClarifyingQuestion } from "@shared/chat-clarify";
import { canonicalExpenseCategory, canonicalObligationCategory, EXPENSE_CATEGORIES } from "@shared/category-canon";
import { createServer, type Server } from "http";
import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { execFile } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);
import { getUserToday, getUserCurrentMonth, toLocalDateStr, parseLocalDate, parseUserDateTime, zonedTimeToUTC, DEFAULT_TIMEZONE } from "@shared/timezone";
import { completeHabitOccurrence, uncompleteHabitOccurrence } from "./habit-completion";
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
import { advanceLiabilityDueDate, readDueDate, isSettledOccurrence } from "@shared/liability-recurrence";
import { generateSchedule, liabilityAmount, liabilityFrequency } from "@shared/liability-schedule";
import { isRecurringBill as isRecurringBillType } from "@shared/liability-types";
import { selfIdsFrom } from "@shared/scope";
import { validateFinanceImport } from "@shared/finance-import-schema";
import { findBlockingDuplicateProfile } from "@shared/profile-dedup";
import { buildImportPrompt, planImport, applyImport, undoImport } from "./finance-import";
import { registerCacheBuster } from "./cache-bus";
import { sanitizeTrackerEntryValues } from "./tracker-entry-guard";
import { removeTrackerEntry } from "./tracker-entries";
import { EPOCH_KEY, versionStamp, encodeVersionMap, decodeVersionMap, mergeVersionMaps, MAX_VERSION_LOOKAHEAD } from "@shared/cache-domains";
import { payBillOccurrence, unpayBillOccurrence, closeBillReminderTasksWhere, isOpenBillReminderTask } from "./liability-payments";
import { createWriteJournal, writeJournalContext, type WriteJournal } from "./write-journal";
import { encodeWriteManifest, WRITE_MANIFEST_HEADER } from "@shared/write-manifest";
import { registerFinanceRoutes } from "./finance-routes";
import { HIDDEN_TRACKER_CATEGORIES } from "@shared/hidden-tracker-categories";
import { normalizeDateString } from "@shared/extraction-normalize";
import {
  mergeStructuredRecords, allergyKey, medicationKey, conditionKey, surgeryKey,
  type ExtractionItem, type ExtractionDestination,
  type ProfileAllergy, type ProfileMedication, type ProfileCondition, type ProfileSurgery,
} from "@shared/extraction-destinations";
import { findIdentityMatches } from "@shared/tracker-identity";
import { canonicalizeProfileFields, looselyEqual } from "@shared/profile-field-canon";
import { checkProfileRename, checkProfileTypeChange } from "@shared/profile-rename";
import { checkProfileDelete } from "@shared/profile-delete";
import { cascadeProfileRename } from "./profile-rename-cascade";
import { normalizeEntityDateFields, impossibleCalendarDays, isRealCalendarDay, classifyDateField, normalizeFieldKey, bareDateOf, rulesFromAll, rulesFromDocuments, rulesFromSeries, dedupeRules, daysBetweenISO, isDocumentAttentionRule, ruleTypeLabel, CALENDAR_OPT_OUT_KEY, type DateRule } from "@shared/date-rules";
import type { CalendarDateDecision } from "@shared/extraction-calendar";
import { itemsClaimedByActions, type ProposedAction } from "@shared/extraction-actions";
import { executeActions } from "./action-executor";
import { seriesFromAll } from "@shared/calendar-adapters";
import { fieldIdentity, PROFILE_FIELD_GROUPS, cleanupStoredProfileFields, mergeFieldWrite, fieldValuePersisted } from "@shared/profile-field-identity";

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
 * incomes / obligations / tasks / events / habits / trackers / goals / journal /
 * documents / artifacts; `ownerProfileId` (scalar) on captures.
 */
function applyActiveProfileScope(
  req: Request,
  body: any,
  field: "linkedProfiles" | "profileId" | "ownerProfileId" = "linkedProfiles",
): any {
  if (!body || typeof body !== "object") return body;
  const active = activeProfileIds(req);
  if (active.length === 0) return body;
  if (field === "profileId" || field === "ownerProfileId") {
    if (typeof body[field] === "string" && body[field]) return body;
    const owner = resolveCreateOwnerIds([], active);
    if (owner.length === 1) body[field] = owner[0];
    return body;
  }
  const explicit = Array.isArray(body.linkedProfiles) ? body.linkedProfiles.filter(Boolean) : [];
  const owners = resolveCreateOwnerIds(explicit, active);
  if (owners.length > 0) body.linkedProfiles = owners;
  return body;
}

/**
 * The guards a parent assignment must pass: the parent exists (404), the link
 * would not close a cycle (400), the chain stays at most 32 deep (400).
 *
 * Shared by PATCH /api/profiles/:id (`parentProfileId`) and PATCH
 * /api/accounts/:id (`ownerProfileId`, which storage writes to the SAME
 * column). The account route used to skip all three — a self-parented
 * account sent deleteProfile's child cascade into unbounded recursion.
 */
async function checkParentAssignment(
  userId: string,
  profileId: string,
  newParentId: string,
): Promise<{ status: number; error: string } | null> {
  // storage.getProfile() is user-scoped: a parent it returns is ours.
  const parentProfile = await storage.getProfile(newParentId);
  if (!parentProfile) return { status: 404, error: "Parent profile not found" };
  const cycle = await storage.wouldCreateCycle(userId, profileId, newParentId);
  if (cycle) return { status: 400, error: "Cannot set parent: would create a cycle" };
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
  if (depthFromParent > 32) return { status: 400, error: "Cannot set parent: nesting depth would exceed 32 levels" };
  return null;
}

// Augment Express Request with auth middleware userId
interface AuthenticatedRequest extends Request {
  userId?: string;
}
import { computeDocumentDeletionImpact, deleteDocumentEverywhere, parseDeletionMode, repairOrphanedDocumentEvents } from "./document-deletion";
import { storage } from "./storage";
import { buildOverviewSpec, isOverviewEntity } from "./overview-engine";
import { resolveAssetValue, resolveLiabilityValue, resolveMonthlyPayment, canonicalObligationStatus } from "./supabase-storage";
import { computeAiSensitiveStripKeys, deepStripKeys } from "./ai-summary-sanitizer";
import { buildNotifications } from "./notification-service";
import {
  createNote, updateNote, deleteNote, listNotes,
  upsertJournalEntry, syncDateRulesForEntity,
} from "./content-service";

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
import { parseBankCsv, expenseDedupeKey } from "./bank-csv";
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
  insertIncomeSchema,
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
  isCalendarDay,
} from "@shared/schema";
import type { ParsedAction, Tracker, CalendarEvent } from "@shared/schema";
import { validateTransactionAmount, validateProfileMoneyFields } from "@shared/quick-add";
import { normalizeMonthKey, budgetCategoryKey, spendByCategory } from "@shared/budget-ledger";
import { canonicalIncomeFrequency } from "@shared/obligation-windows";
import { toMonthlyAmount } from "@shared/obligation-windows";
import { ACTIVE_PROFILE_HEADER, parseActiveProfileIds, resolveCreateOwnerIds } from "@shared/active-scope";
import { generateSmartInsights } from "./insights-engine";
import { requireAdmin, resolveUserFromRequest, isUniqueViolation } from "./auth";

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
const versionMemo = new Map<string, { v: Record<string, number>; at: number }>();

/**
 * Per-domain versions, or a single epoch?
 *
 * Set PER_DOMAIN_VERSIONS=0 to collapse every cache key back to the epoch
 * alone — exactly the pre-migration behavior. Rolling that back is an env flip,
 * not a deploy, because this is the one change here that can serve genuinely
 * stale data if a prefix under-declares what it reads.
 */
const PER_DOMAIN_VERSIONS = () =>
  process.env.PER_DOMAIN_VERSIONS !== "0" && process.env.PER_DOMAIN_VERSIONS !== "false";

/** This instance's view of a user's version map, memoized for ~2s. */
async function currentVersions(uid: string): Promise<Record<string, number>> {
  const hit = versionMemo.get(uid);
  if (hit && Date.now() - hit.at < VERSION_MEMO_MS) return hit.v;
  let map: Record<string, number> = {};
  try {
    const raw = await (storage as any).getDataVersions?.();
    // `!Array.isArray`: an array is an object, and a storage double that answers
    // unknown methods with [] would otherwise be read as "no versions at all".
    if (raw && typeof raw === "object" && !Array.isArray(raw)) map = raw as Record<string, number>;
    else {
      const legacy = Number(await (storage as any).getDataVersion?.());
      if (Number.isFinite(legacy)) map = { [EPOCH_KEY]: legacy };
    }
  } catch { /* fail open: no version known, same-instance busting still applies */ }
  if (versionMemo.size > 5000) versionMemo.clear();
  versionMemo.set(uid, { v: map, at: Date.now() });
  return map;
}

/**
 * Bump the versions of the domains a request wrote, and WAIT for it.
 *
 * The wait is the point. The response to a write is what tells the client to
 * refetch; if the bump is still in flight when that response lands, the refetch
 * computes the PRE-write cache key and can be served pre-write data, which
 * React Query then stores as fresh for a full staleTime. That was "it saved,
 * but the page doesn't show it until I refresh".
 *
 * What changed is the SCOPE. This used to bump one counter that appeared in
 * every cache key, so saving a tracker entry made the dashboard, the expense
 * list and the calendar unaddressable too — every write cold-started the whole
 * account. Now a write moves only the domains it touched (plus the epoch, which
 * every key carries, so an unnamed or unknown domain still invalidates all).
 *
 * Returns the new map for the client's read-your-writes token; undefined when
 * storage can't report one, in which case callers keep their old behavior.
 */
export async function bumpDataVersionNow(
  uid: string,
  domains: string[] = [],
): Promise<Record<string, number> | undefined> {
  versionMemo.delete(uid);
  // An empty domain list is how the RPC is told "invalidate everything": it
  // moves the account-wide epoch, which every cache key carries. So a write
  // that named "everything" — or that could not be classified at all — must
  // send NO domains rather than the rest of its list, or it would quietly
  // invalidate less than it asked for.
  const nuclear = !PER_DOMAIN_VERSIONS() || domains.some((d) => d === "everything");
  const names = nuclear
    ? []
    : domains.filter((d): d is string => typeof d === "string" && d.length > 0);
  try {
    const raw = await (storage as any).bumpDataVersions?.(names);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const map = raw as Record<string, number>;
      versionMemo.set(uid, { v: map, at: Date.now() });
      return map;
    }
  } catch { /* fall through to the legacy counter */ }
  try {
    const v = Number(await (storage as any).bumpDataVersion?.());
    if (Number.isFinite(v) && v > 0) {
      const map = { [EPOCH_KEY]: v };
      versionMemo.set(uid, { v: map, at: Date.now() });
      return map;
    }
  } catch { /* the next GET resolves versions from the DB */ }
  return undefined;
}

/**
 * Read-your-writes token. A client that has just been told "saved" sends the
 * versions it was given on every subsequent GET; this instance then uses the
 * per-domain max of its own memo and the client's token to build cache keys.
 *
 * Awaiting the bump alone does NOT close the window: the response cache is
 * per-instance and each instance memoizes versions for VERSION_MEMO_MS, so a
 * GET landing on a DIFFERENT warm instance within ~2s still computes the
 * pre-write key. The token makes that instance compute the post-write key
 * regardless of what its own memo says.
 */
export const DATA_VERSION_HEADER = "x-data-version";

export { MAX_VERSION_LOOKAHEAD };

/** Legacy single-counter form, kept for the tests that pin its clamping. */
export function resolveDataVersion(memoVersion: number, headerValue: unknown): number {
  const raw = Number(Array.isArray(headerValue) ? headerValue[0] : headerValue);
  if (!Number.isFinite(raw) || raw <= memoVersion) return memoVersion;
  return Math.min(Math.floor(raw), memoVersion + MAX_VERSION_LOOKAHEAD);
}

/**
 * Write one structured medical array onto the profile's merged fields.
 *
 * Only writes when there is something to write: an extraction that carried no
 * allergies must not touch `fields.allergies`, and must certainly not convert a
 * user's free-text allergy string into records for no reason.
 */
function applyStructuredArray<T extends Record<string, any>>(
  merged: Record<string, any>,
  existingFields: Record<string, any>,
  key: string,
  incoming: T[],
  keyOf: (x: Partial<T>) => string,
  fromLegacyString: (s: string) => T,
): void {
  if (!incoming.length) return;
  merged[key] = mergeStructuredRecords(existingFields[key], incoming, keyOf, fromLegacyString);
}

/**
 * The per-user, per-prefix cache key segment.
 *
 * `prefix` names WHICH cache this key is for, because that decides which
 * domains' versions belong in the stamp (shared/cache-domains.ts). Omit it and
 * the key depends on everything — the old behavior, and the safe default for
 * anything unclassified.
 *
 * Callers on the WRITE path pass no prefix and get a bare user id: writes never
 * resolve versions, and `bustCache(\`stats:${uid}\`)` still prefix-matches every
 * stamped variant of that key.
 */
function cacheUserKey(req: { userId?: string }, prefix?: string): string {
  if (!req.userId) return `nouser-${Math.random().toString(36).slice(2)}`;
  const versions = (req as any).__dataVersions as Record<string, number> | undefined;
  // Versions are resolved by the GET middleware below. None known (a write, or
  // a failed resolve) still produces a stable key — same-instance busting
  // covers it.
  if (!versions) return req.userId;
  if (!PER_DOMAIN_VERSIONS()) return `${req.userId}@v${Number(versions[EPOCH_KEY]) || 0}`;
  return `${req.userId}@${versionStamp(prefix ?? "", versions)}`;
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
/** Longest a write may wait for its version bump before answering anyway. */
const BARRIER_TIMEOUT_MS = 3000;

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
 *
 * The same barrier carries the WRITE MANIFEST — what this request actually
 * changed, recorded by the storage proxy as it wrote (server/write-journal.ts).
 * Both go out before the response, in this order:
 *
 *   db write committed → caches busted + version bumped → manifest attached
 *   → response sent → client patches its cache from the manifest → dependent
 *   queries refresh
 *
 * The old ordering ended at "response sent" and left the client to guess the
 * rest, which is why a payment's own row appeared instantly while the balance
 * it moved took a refetch to catch up.
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
  // frame, which never goes through res.json). It still opens a journal below —
  // its manifest reaches the client in the SSE body instead of a header.
  const inlineBarrier = req.path === "/api/chat";

  const journal = createWriteJournal();

  let barrierDone = false;
  const settle = (send: () => void, body: any) => {
    if (barrierDone || res.statusCode >= 400) { send(); return; }
    barrierDone = true;
    attachWriteManifest(res, journal);
    bustUserCaches(uid);
    // The barrier holds the response open until the version bump lands. That
    // ordering is the point — but it must never be able to hold it open
    // FOREVER. An upstream call with no timeout would otherwise turn a slow
    // Postgres round trip into a hung write. Past the deadline the response
    // goes out without the token; the client falls back to its own version
    // memo, which is how every write behaved before the barrier existed.
    let sent = false;
    const sendOnce = () => { if (!sent) { sent = true; send(); } };
    const deadline = setTimeout(sendOnce, BARRIER_TIMEOUT_MS);
    (deadline as any).unref?.();
    // Only the domains this request actually wrote. A write that reported none
    // (or reported "everything") still moves the epoch, which every cache key
    // carries — so an unclassifiable write invalidates all of them, exactly as
    // every write used to.
    Promise.resolve(bumpDataVersionNow(uid, journal.drain().domains))
      .then((v) => {
        if (v === undefined) return;
        try { res.setHeader(DATA_VERSION_HEADER, encodeVersionMap(v)); } catch { /* headers already sent */ }
        // The AI write routes also carry it in the body, which their clients
        // already read; keep that contract.
        if (isAiWrite && body && typeof body === "object" && !Array.isArray(body)) {
          try { (body as any).dataVersion = encodeVersionMap(v); } catch { /* frozen body */ }
        }
      })
      .catch(() => { /* fall through: the client keeps its old behavior */ })
      .finally(() => { clearTimeout(deadline); sendOnce(); });
  };

  if (!inlineBarrier) {
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
    // A handler that answers with res.send or a bare res.end (the 204 paths)
    // used to skip the barrier entirely and ship no manifest at all.
    const sendRaw = res.send.bind(res);
    res.send = (body?: any) => {
      settle(() => sendRaw(body), body);
      return res;
    };
    const endRaw = res.end.bind(res);
    res.end = (...args: any[]) => {
      settle(() => endRaw(...args), null);
      return res;
    };
  }

  // Everything the handler does — including the AI tool calls that /api/chat
  // makes — runs inside the journal, so the manifest describes the whole turn.
  writeJournalContext.run(journal, next);
}

/**
 * Put the request's change manifest on the response, degrading rather than
 * failing: an unencodable or oversize manifest simply isn't sent, and the
 * client falls back to the behavior it had before manifests existed.
 */
function attachWriteManifest(res: any, journal: WriteJournal): void {
  try {
    if (!journal.dirty) return;
    const encoded = encodeWriteManifest(journal.drain());
    if (encoded) res.setHeader(WRITE_MANIFEST_HEADER, encoded);
  } catch { /* headers already sent, or a row that won't serialize */ }
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
/**
 * Drop every cached response under a key prefix.
 *
 * The prefix MUST include the user id. `bustCache("enhanced:")` looks like it
 * clears the caller's dashboard; it actually clears the dashboard of every user
 * whose request happened to land on this warm instance, cold-starting a ~15
 * query recompute for each of them. Dozens of those calls had accumulated —
 * one person saving a tracker entry was making the app slow for strangers.
 * They were also redundant: bustUserCaches() already covers every per-user
 * prefix for the writing user, correctly scoped.
 */
function bustCache(prefix: string): void {
  if (process.env.NODE_ENV !== "production" && /^[a-z-]+:$/.test(prefix)) {
    log.warn(`[cache] bustCache("${prefix}") has no user id — this clears every user on this instance. Use bustCache(\`${prefix}\${uid}\`).`);
  }
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

/** Escape text for interpolation into HTML (outbound email bodies). */
function htmlEscape(input: unknown): string {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitize(input: unknown): string {
  // A non-string (an array or object where a title was expected) is not
  // text to clean; returning "" lets the schema reject it as empty instead
  // of `.replace` throwing halfway through the handler (a 500).
  if (typeof input !== "string") return "";
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

/** Text fields of an account must be strings when present (an object or array is not a name). */
function validateAccountTextFields(body: Record<string, any> | null | undefined): string | null {
  if (!body || typeof body !== "object") return "Request body must be a JSON object";
  for (const key of ["name", "accountKind", "institution", "accountNumberLast4", "currency", "notes"]) {
    const v = body[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") return `${key} must be a string`;
    if (v.length > 500) return `${key} is too long`;
  }
  return null;
}

/** The same object without the keys whose value is undefined. */
function withoutUndefined<T extends Record<string, any>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

// Date validation helper
function isValidDateStr(d: string): boolean {
  return isCalendarDay(d);
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
//
// The same rule holds for every list /api/dashboard-bootstrap seeds WHOLE into
// the client cache (tasks, events, habits, obligations, artifacts, journal,
// goals, documents): the page renders the seeded full list, then its first
// refetch — after any write — came back through the 100-row cap, so the Tasks
// page counted 121 open tasks until a task was added and 100 afterwards, and
// the task just created was not among the 100. One list, one size.
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
      // A PostgREST error is a plain object whose enumerable fields are
      // message/code/details/hint — `err?.message || err` printed "{}" for
      // any thrown value whose message was empty, which hid the cause of every
      // storage 500 from the log.
      const errText = err?.message || err?.details || err?.code
        ? [err?.code, err?.message, err?.details, err?.hint].filter(Boolean).join(" — ")
        : (typeof err === "string" ? err : (() => { try { return JSON.stringify(err); } catch { return String(err); } })());
      log.error(`[API Error] ${req.method} ${req.path}:`, errText);
      if (!res.headersSent) {
        // Honor explicit client-error status codes thrown by lower layers
        // (e.g. the storage layer's optimistic-concurrency ConflictError sets
        // statusCode = 409). 5xx and unknown statuses stay a generic 500 so
        // internal details never leak to clients.
        const status = Number(err?.statusCode || err?.status);
        // A malformed id ("undefined", "not-a-uuid") reaches Postgres as an
        // invalid uuid literal (22P02). No row can match it, so it is the same
        // answer as an unknown id — not a server error.
        const pgCode = String(err?.code || err?.details?.code || "");
        const msg = String(err?.message || "");
        if (/invalid input syntax for type uuid/i.test(msg) || pgCode === "PGRST116" || /JSON object requested, multiple \(or no\) rows returned/i.test(msg)) {
          // An unknown id: no row for the uuid, or a `.single()` read-back
          // that matched nothing (an update of a row this user does not have).
          res.status(404).json({ error: "Not found" });
        } else if (pgCode === "PGRST204" || /Could not find the '.*' column/i.test(msg)) {
          // A field the table does not have is the caller's bad request.
          res.status(400).json({ error: "Unknown field in request" });
        } else if (pgCode === "22P02" || pgCode === "22003" || pgCode === "42804" || /invalid input syntax for type|out of range for type|malformed array literal/i.test(msg)) {
          // A value the column cannot hold (text where a number goes, an
          // object where text goes) is the caller's bad request.
          res.status(400).json({ error: "Invalid value for a field" });
        } else if (pgCode === "23505" || /duplicate key value violates unique constraint/i.test(msg)) {
          // A uniqueness rule (one journal entry per day, one Self, …) is the
          // caller's conflict, not a server fault.
          res.status(409).json({ error: "A record with the same key already exists" });
        } else if (pgCode === "22007" || pgCode === "22008" || /invalid input syntax for type (date|timestamp)|date\/time field value out of range/i.test(msg)) {
          // A date or time the database could not read is a bad request.
          res.status(400).json({ error: "Invalid date or time value" });
        } else if (Number.isInteger(status) && status >= 400 && status < 500) {
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
  // Co-ownership widens a person's selection to the assets they co-own
  // (shared/profile-filter.effectiveSelection) — the bills route used to
  // hide the co-owned car's insurance while the expenses route showed its
  // fuel.
  const ctx = await profileFilterCtx(ids, allProfiles);
  return items.filter((item: any) => passesProfileFilter(item?.linkedProfiles, ctx));
}

/**
 * THE context for `passesProfileFilter` on the server: the selection, the
 * profile tree and the co-ownership links. Every inline
 * `{ selectedIds, allProfiles }` literal that used to be built at a call site
 * silently dropped the co-ownership half of the rule (the bootstrap seeds,
 * insights, wellness, cashflow, notifications, search, incomes), so a
 * co-owner's dashboard disagreed with the lists it seeds. No selection ⇒ no
 * link fetch.
 */
async function profileFilterCtx(
  ids: string[],
  allProfiles: Array<{ id: string; type?: string; parentProfileId?: string | null }>,
  assetPartyLinks?: any[] | null,
  liabilityProfileLinks?: any[] | null,
): Promise<{ selectedIds: string[]; allProfiles: any[]; assetPartyLinks: any[]; liabilityProfileLinks: any[] }> {
  const need = ids.length > 0;
  const [links, liabLinks] = await Promise.all([
    Array.isArray(assetPartyLinks) ? assetPartyLinks
      : (need ? (storage.getAssetPartyLinks?.() ?? Promise.resolve([])).catch(() => [] as any[]) : []),
    Array.isArray(liabilityProfileLinks) ? liabilityProfileLinks
      : (need ? (storage.getLiabilityProfileLinks?.() ?? Promise.resolve([])).catch(() => [] as any[]) : []),
  ]);
  return { selectedIds: ids, allProfiles, assetPartyLinks: links || [], liabilityProfileLinks: liabLinks || [] };
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
    res.setHeader("Access-Control-Expose-Headers", "X-Data-Version, X-Write-Manifest, X-Total-Count");
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
        // and can never serve a stale (pre-write) version. Per prefix, because
        // stamps are per prefix now — a key warmed under the wrong stamp is
        // simply never read, which is a warmup that quietly does nothing.
        const versions = await currentVersions(authed.userId);
        const keyFor = (prefix: string) => `${authed.userId}@${versionStamp(prefix, versions)}`;
        const ckStats = `stats:${keyFor("stats:")}:${filterKey}`;
        const ckEnh = `enhanced:${keyFor("enhanced:")}:${filterKey}`;
        const ckProf = `profiles:${keyFor("profiles:")}`;
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
    const token = decodeVersionMap(req.headers[DATA_VERSION_HEADER]);
    currentVersions(uid)
      .then((own) => { (req as any).__dataVersions = mergeVersionMaps(own, token); next(); })
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
        // Fallback only (see below): the turn's own domains are long gone by
        // 'finish', so this bumps the epoch alone — which invalidates
        // everything, the safe answer for a turn that bailed out mid-write.
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
        }
        // Every other write: NO bump here. writeBarrierMiddleware issues one
        // awaited bump after the write commits and before the response is sent,
        // which is the only bump whose ordering actually helps. This
        // pre-handler bump was a second Postgres RPC per write, on the critical
        // path of the same request, doing nothing the barrier's bump doesn't —
        // any entry a GET cached mid-handler is made unaddressable by the
        // barrier's bump before the write response reaches the client.
        //
        // cacheBustMiddleware's PRE-HANDLER BUST is a different mechanism and
        // stays: it clears this instance's entries, which no version bump does.
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
        // Only the domains this turn actually wrote — read from the same write
        // journal every other route uses, so a chat turn and a form submission
        // invalidate on identical terms.
        const turnDomains = writeJournalContext.getStore()?.drain().domains ?? [];
        const v = await bumpDataVersionNow(userId, turnDomains);
        tBump = Date.now() - tBumpStart;
        if (v !== undefined) (result as any).dataVersion = encodeVersionMap(v);
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
          // classifier is unsure AND nothing was routed AND the assistant
          // neither executed anything nor asked its own question — the rule
          // lives in shared/chat-clarify.ts. Appending it after a successful
          // update or a confirmation prompt made the reply contradict itself.
          // Skipped when the final frame already shipped (routed turns) — the
          // reply is on the wire and routed turns never carried the question.
          if (
            !finalSent &&
            (result as any) &&
            typeof (result as any).reply === "string" &&
            shouldAppendClarifyingQuestion({
              question: classification?.clarifyingQuestion,
              reply: (result as any).reply,
              confidence: captureConf,
              projectionsCount: projections.length,
              actionsCount: actions.length,
            })
          ) {
            (result as any).reply = appendClarifyingQuestion((result as any).reply, classification!.clarifyingQuestion!);
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
  // Accept the Bearer header as well as ?key=. Vercel Cron authenticates with
  // `Authorization: Bearer $CRON_SECRET` and cannot append a query string, so
  // a ?key=-only check makes an endpoint unreachable from a schedule. ?key= is
  // kept so a job can still be triggered by hand. ONE check for every cron
  // route — two of them had grown their own ?key=-only copy.
  function cronAuthorized(req: any): boolean {
    const secret = process.env.CRON_SECRET;
    const provided = String(
      req.query.key || (req.headers.authorization || "").replace("Bearer ", "")
    ).trim();
    return !!secret && !!provided && safeEqual(provided, secret);
  }
  const cronDailyMaintenance: any = asyncHandler(async (req: any, res: any) => {
    if (!cronAuthorized(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      // Expired rows are already unreadable — this just keeps the table from
      // growing without bound.
      let swept = 0;
      try { swept = (await (storage as any).sweepResponseCache?.()) || 0; } catch { /* best-effort */ }
      // The net-worth snapshot and the recurring-bill due scan have their own
      // routes below, but nothing ever scheduled them: vercel.json carries ONE
      // cron (this one). So /api/net-worth/history stayed empty and autopay
      // bills never auto-logged. Run both from the daily job — one schedule,
      // three tasks — and report each outcome; one failing must not stop the
      // others.
      const [snapshot, dueScan] = await Promise.allSettled([
        runNetWorthSnapshot(),
        runLiabilityDueScan(),
      ]);
      const settle = (label: string, r: PromiseSettledResult<any>) => {
        if (r.status === "fulfilled") return r.value;
        log.error(`[Cron Daily Maintenance] ${label}`, (r.reason as any)?.message || r.reason);
        return { error: "failed" };
      };
      res.json({ swept, snapshot: settle("snapshot", snapshot), dueScan: settle("due-scan", dueScan) });
    } catch (err: any) {
      log.error("[Cron Daily Maintenance]", err?.message || err);
      res.status(500).json({ error: "Cron failed" });
    }
  });
  app.get("/api/cron/daily-maintenance", cronDailyMaintenance);
  // Legacy path — still what vercel.json schedules.
  app.get("/api/cron/fire-due-reminders", cronDailyMaintenance);

  // ---- Cron: daily net-worth snapshot (W4-5) ----
  // Global cross-user job. Gated by CRON_SECRET (see cronAuthorized), runs under
  // the service_role admin client, and writes one snapshot row per profile + an
  // aggregate row for each user. Returns { snapped: N } counting users snapped.
  // Also run by the daily-maintenance job, which is the one vercel.json schedules.
  async function runNetWorthSnapshot(): Promise<{ snapped: number }> {
      const { createClient } = await import("@supabase/supabase-js");
      const url = process.env.VITE_SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) throw new Error("Supabase admin env vars missing");
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
      return { snapped };
  }
  const cronSnapshotNetWorth: any = asyncHandler(async (req: any, res: any) => {
    if (!cronAuthorized(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      res.json(await runNetWorthSnapshot());
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
  // Also run by the daily-maintenance job (the one vercel.json schedules).
  async function runLiabilityDueScan(): Promise<{ autopaid: number; reminded: number }> {
      const { createClient } = await import("@supabase/supabase-js");
      const url = process.env.VITE_SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) throw new Error("Supabase admin env vars missing");
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
                  // A reminder whose occurrence was paid or skipped, or that the
                  // schedule has already rolled past, is finished. Closing it
                  // here (not only at pay time) heals the ones an older build
                  // left open.
                  if (existingTasks.some((t: any) => isOpenBillReminderTask(t, bill.id))) {
                    const occ = (f.occurrences && typeof f.occurrences === "object") ? f.occurrences : {};
                    await closeBillReminderTasksWhere(scoped, bill.id, (day) => {
                      const st = occ[day]?.status;
                      return st === "paid" || st === "skipped" || (!!day && !!due && day < due);
                    }, log, existingTasks);
                  }
                  if (!due || due > windowEnd) continue; // not due within the window
                  const autopay = f.autopay === true || f.autoPay === true || String(f.autopay ?? "").toLowerCase() === "true";
                  if (autopay) {
                    // Already settled (manually or by a prior run)? Never pay twice.
                    const ov = (f.occurrences && typeof f.occurrences === "object") ? f.occurrences[due] : null;
                    if (ov?.status === "paid" || ov?.status === "skipped") continue;
                    // The one pay operation: real occurrence total (not the
                    // definition's base price), occurrence stamped, due date
                    // advanced from the occurrence, expense logged.
                    try {
                      const paid = await payBillOccurrence(scoped, bill.id, {
                        occurrenceDate: due,
                        paymentDate: todayISO,
                        notes: "Autopay",
                        source: "autopay",
                      });
                      if (paid.ok && paid.amount > 0) autopaid++;
                    } catch { /* per-bill best effort */ }
                  } else {
                    // Non-autopay: surface a timed TASK at the due date, deduped
                    // on title + date. A task is checkable and lands on the
                    // calendar at its hour; the reminder rows this used to write
                    // were neither.
                    const title = `Bill due: ${bill.name}`;
                    // An occurrence already paid or skipped needs no reminder.
                    // Creating one anyway made the next run close it (D92) and
                    // the run after that create it again — a churn of reminder
                    // tasks for a bill whose date sits on a settled day.
                    if (isSettledOccurrence(f, due)) continue;
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
      return { autopaid, reminded };
  }
  const cronLiabilityDueScan: any = asyncHandler(async (req: any, res: any) => {
    if (!cronAuthorized(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      res.json(await runLiabilityDueScan());
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
      const { fileName, mimeType, fileData, message, profileId, discardImage } = req.body;
      if (!fileData || !fileName) {
        return res.status(400).json({ error: "fileName and fileData (base64) required" });
      }
      // Extract-only: read the file for its data, keep nothing. The bytes are
      // never written to Storage or the database — see processFileUpload.
      const discardUploadImage = discardImage === true || discardImage === "true";
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
      const result = await processFileUpload(fileName, mimeType, fileData, message, profileId, { discardImage: discardUploadImage });
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
      const { files, message, discardImage } = req.body;
      const discardBatchImages = discardImage === true || discardImage === "true";
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
            profileId !== "none" ? profileId : undefined,
            { discardImage: discardBatchImages || file.discardImage === true }
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
          if (!isCalendarDay(d?.iso || "")) continue;
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
      const { extractionId, targetProfileId, items } = req.body;
      // The reviewed plan (shared/extraction-actions). Present when the
      // understanding stage produced one and the user confirmed from the
      // action review; absent for a chat message rendered from history, or
      // when reasoning degraded and the pane fell back to per-field routing.
      const reviewedActions: ProposedAction[] = Array.isArray(req.body?.actions)
        ? req.body.actions : [];
      let { confirmedFields, createCalendarEvents, trackerEntries } = req.body;
      // The Calendar section's decisions — one per recognised date. See
      // shared/extraction-calendar for why they travel separately from
      // `createCalendarEvents`: a date the RECORD owns needs no event, only
      // permission to be derived.
      const calendarDates: CalendarDateDecision[] = Array.isArray(req.body?.calendarDates)
        ? req.body.calendarDates : [];
      if (!extractionId) {
        return res.status(400).json({ error: "extractionId required" });
      }

      // ═══ THE REVIEW LIST IS THE ROUTING DECISION ═══
      // The client now sends ONE list, each row carrying the destination the
      // user actually chose (shared/extraction-destinations). Expand it into
      // the per-destination payloads the steps below already understand, and
      // collect the destinations that had no home before this change —
      // allergies, medications, medical history, notes and tasks.
      //
      // A row's destination is the USER'S answer, not the extractor's: the AI
      // proposes in processFileUpload, the review pane lets it be changed, and
      // nothing here second-guesses what came back. Rows the user unticked, and
      // rows routed to "ignore", are not written anywhere.
      const structuredAllergies: ProfileAllergy[] = [];
      const structuredMedications: ProfileMedication[] = [];
      const structuredConditions: ProfileCondition[] = [];
      const structuredSurgeries: ProfileSurgery[] = [];
      const noteWrites: Array<{ title: string; content: string }> = [];
      const taskWrites: Array<{ title: string; dueDate?: string }> = [];
      const ignoredItems: string[] = [];

      // Rows the reviewed plan is already writing. The client partitions the
      // two lists, but a row reaching BOTH paths would write the same fact
      // twice — one profile field written by an action and again by the legacy
      // switch — so the partition is enforced here as well rather than trusted.
      // One rule, defined once (shared/extraction-actions.itemsClaimedByActions):
      // a row is withheld ONLY when a selected action already performs that
      // exact write. A tracker/expense/obligation action does not, so its fact
      // still reaches the profile — "facts get saved; actions get performed".
      const claimedByActions = itemsClaimedByActions(
        reviewedActions,
        Array.isArray(items) ? (items as ExtractionItem[]) : [],
      );

      if (Array.isArray(items) && items.length > 0) {
        const fields: Array<{ key: string; value: any }> = [];
        const events: Array<{ field: string; date: string; title: string; category: string }> = [];
        const entries: any[] = [];

        for (const raw of items as ExtractionItem[]) {
          if (!raw || typeof raw !== "object") continue;
          if (claimedByActions.has(String(raw.id))) continue;
          const dest = String(raw.destination || "") as ExtractionDestination;
          if (!raw.selected || dest === "ignore") {
            if (raw.label) ignoredItems.push(String(raw.label));
            continue;
          }
          const label = String(raw.label ?? raw.key ?? "").trim();
          const payload = (raw.payload && typeof raw.payload === "object") ? raw.payload : {};

          switch (dest) {
            case "profile":
            // ═══ THE ASSET-DOCUMENT BUG (2026-08-26) ═══
            // For a document filed under an asset/vehicle/property/liability,
            // suggestDestination routes nearly EVERY field to entity_field /
            // entity_record — that IS the designed home for entity data. This
            // switch had no case for either, so whenever those rows travelled
            // as loose items (the reasoner degraded, or the plan's context
            // action was unticked by an identity conflict), every one of them
            // fell through and the confirmation reported success while writing
            // NOTHING to the asset the user picked. They take the same
            // field-write path as "profile": the write lands on the resolved
            // target profile — which is exactly the asset the user chose.
            case "entity_field":
            case "entity_record":
            case "structured_append":
              if (raw.key) fields.push({ key: raw.key, value: raw.value });
              break;

            case "profile_tracker":
              // ONE fact, TWO jobs: the person's current height/weight/BMI AND a
              // point in its time series. The user ticks it once.
              // The profile half is written whether the row came from a
              // printed field or from the model's tracker list. Skipping the
              // latter left `fields.weight` unset, and the estimation engine
              // (shared/estimation-engine, fed at ai-engine log_tracker_entry)
              // then sized THIS person's calorie estimates with a population
              // default instead of their own weight.
              if (raw.key) fields.push({ key: raw.key, value: raw.value });
              if (raw.trackerName && raw.values) {
                entries.push({ trackerName: raw.trackerName, values: raw.values, unit: raw.unit || "", category: raw.category || "health", date: raw.date });
              }
              break;

            case "tracker":
              if (raw.trackerName && raw.values) {
                entries.push({ trackerName: raw.trackerName, values: raw.values, unit: raw.unit || "", category: raw.category || "health", date: raw.date });
              }
              break;

            case "allergy":
              structuredAllergies.push({
                substance: String(payload.substance ?? raw.value ?? label),
                reaction: payload.reaction ? String(payload.reaction) : (raw.detail ? String(raw.detail) : undefined),
                type: payload.type ? String(payload.type) : undefined,
                source: extractionId,
              });
              break;

            case "medication":
              structuredMedications.push({
                name: String(payload.name ?? raw.value ?? label),
                dose: payload.dose ? String(payload.dose) : undefined,
                frequency: payload.frequency ? String(payload.frequency) : undefined,
                asNeeded: payload.asNeeded === true,
                kind: payload.kind ? String(payload.kind) : undefined,
                source: extractionId,
              });
              break;

            case "medical_history":
              if (raw.source === "surgery" || payload.procedure) {
                structuredSurgeries.push({
                  procedure: String(payload.procedure ?? raw.value ?? label),
                  year: Number.isFinite(Number(payload.year)) && Number(payload.year) > 0 ? Number(payload.year) : undefined,
                  source: extractionId,
                });
              } else {
                structuredConditions.push({
                  name: String(payload.name ?? raw.value ?? label),
                  status: payload.status ? String(payload.status) : undefined,
                  source: extractionId,
                });
              }
              break;

            case "note": {
              const content = String(payload.body ?? raw.value ?? "").trim();
              if (content) noteWrites.push({ title: String(payload.title ?? label) || "Clinical note", content });
              break;
            }

            case "calendar": {
              const date = normalizeDateString(raw.date ?? raw.value);
              if (date) events.push({ field: raw.key || label, date, title: label || "Reminder", category: "health" });
              break;
            }

            case "task": {
              const due = normalizeDateString(raw.date ?? raw.value);
              taskWrites.push({ title: String(payload.title ?? label) || "Follow-up", dueDate: due || undefined });
              break;
            }

            default:
              // reference / document_attach / unsupported — and any destination
              // this switch does not write — stay on the document, NAMED in the
              // response as kept-on-document. A silent fall-through here is how
              // an asset upload once confirmed "success" while writing nothing.
              if (label) ignoredItems.push(label);
              break;
          }
        }

        // Anything the client ALSO sent the old way is kept — a message
        // rendered from history still posts the legacy shapes.
        confirmedFields = [...(Array.isArray(confirmedFields) ? confirmedFields : []), ...fields];
        createCalendarEvents = [...(Array.isArray(createCalendarEvents) ? createCalendarEvents : []), ...events];
        trackerEntries = [...(Array.isArray(trackerEntries) ? trackerEntries : []), ...entries];
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
      const skippedFields: string[] = [...ignoredItems];

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
            // ── The user's calendar decisions, kept ON the record ───────────
            // A date the record owns reaches the calendar by being derived
            // (shared/date-rules), so "don't put this on my calendar" cannot be
            // expressed by NOT creating something — there is nothing to skip.
            // It is recorded here instead, as an opt-out list the rule engine
            // reads, which is also what makes the choice durable: edit the date
            // later and the same decision still applies; clear the opt-out and
            // the calendar entry comes back. No copy, nothing to drift.
            const docFields: Record<string, any> = { ...normalizedDoc.fields };
            const priorOptOut: string[] = Array.isArray((doc.extractedData as any)?.[CALENDAR_OPT_OUT_KEY])
              ? (doc.extractedData as any)[CALENDAR_OPT_OUT_KEY].map((v: any) => String(v))
              : [];
            if (calendarDates.length > 0) {
              const decidedOff = calendarDates.filter((d) => d && d.addToCalendar === false)
                .map((d) => String(d.path || d.field)).filter(Boolean);
              const decidedOn = new Set(calendarDates.filter((d) => d && d.addToCalendar !== false)
                .map((d) => normalizeFieldKey(d.path || d.field)));
              const next = [
                // Keep earlier opt-outs the user did not just revisit…
                ...priorOptOut.filter((k) => !decidedOn.has(normalizeFieldKey(k))),
                ...decidedOff,
              ];
              const deduped = Array.from(new Set(next.map((k) => String(k)).filter(Boolean)));
              if (deduped.length > 0) docFields[CALENDAR_OPT_OUT_KEY] = deduped;
              else delete docFields[CALENDAR_OPT_OUT_KEY];
            } else if (priorOptOut.length > 0) {
              docFields[CALENDAR_OPT_OUT_KEY] = priorOptOut;
            }
            await storage.updateDocument(extractionId, { extractedData: docFields });
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
      //
      // Also runs for a confirmation that ticked ONLY structured medical rows
      // (an allergy list with no scalar fields) — those still have to reach the
      // profile, and gating this whole step on confirmedFields dropped them.
      const hasStructuredMedical = structuredAllergies.length > 0 || structuredMedications.length > 0
        || structuredConditions.length > 0 || structuredSurgeries.length > 0;
      if ((confirmedFields && confirmedFields.length > 0) || hasStructuredMedical) {
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

        for (const field of (confirmedFields || [])) {
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

        // Save to the resolved profile.
        //
        // The structured arrays count as "something to write": a report whose
        // only ticked rows are allergies has no scalar profileFields, and
        // gating on those alone dropped them silently.
        if (resolvedProfileId && (Object.keys(profileFields).length > 0 || hasStructuredMedical)) {
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

              // ── Structured medical arrays ──────────────────────────────
              // Allergies, medications, conditions and surgical history are
              // STRUCTURED DATA, not loose strings: "Penicillin — Rash" is a
              // substance and a reaction, and an appendectomy is a procedure and
              // a year. They ride the SAME updateProfile as the scalar fields so
              // one confirmation is one write.
              //
              // Idempotent by construction: mergeStructuredRecords dedupes on a
              // normalized key, so re-uploading the same report adds nothing and
              // never overwrites a record the user edited. The legacy free-text
              // `allergies` / `medications` strings are converted to records on
              // the first structured write rather than being dropped.
              applyStructuredArray(merged, existingFields, "allergies", structuredAllergies, allergyKey,
                (t: string) => ({ substance: t }) as ProfileAllergy);
              applyStructuredArray(merged, existingFields, "medications", structuredMedications, medicationKey,
                (t: string) => ({ name: t }) as ProfileMedication);
              applyStructuredArray(merged, existingFields, "conditions", structuredConditions, conditionKey,
                (t: string) => ({ name: t }) as ProfileCondition);
              applyStructuredArray(merged, existingFields, "surgicalHistory", structuredSurgeries, surgeryKey,
                (t: string) => ({ procedure: t }) as ProfileSurgery);

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
              // Name the structured rows separately — "Saved 12 fields" says
              // nothing about whether the penicillin allergy landed.
              const structuredSummary: string[] = [];
              if (structuredAllergies.length) structuredSummary.push(`${structuredAllergies.length} allerg${structuredAllergies.length === 1 ? "y" : "ies"}`);
              if (structuredConditions.length) structuredSummary.push(`${structuredConditions.length} condition${structuredConditions.length === 1 ? "" : "s"}`);
              if (structuredSurgeries.length) structuredSummary.push(`${structuredSurgeries.length} surgical record${structuredSurgeries.length === 1 ? "" : "s"}`);
              if (structuredMedications.length) structuredSummary.push(`${structuredMedications.length} medication${structuredMedications.length === 1 ? "" : "s"}`);
              if (structuredSummary.length) {
                saved.push(`Saved ${structuredSummary.join(", ")} to ${profile.name}`);
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
      // The candidate events: the classifier's own suggestions (dates it does
      // NOT recognise as a rule) PLUS every recognised date the user ticked in
      // the Calendar section. The `covered` test below is what keeps the second
      // group from becoming a duplicate: a date the record owns is derived, so
      // it is skipped here — but a ticked date whose field did not persist, or
      // which no rule can be derived from, still gets the real event it needs
      // instead of silently going nowhere.
      const calendarEventCandidates = [
        ...(Array.isArray(createCalendarEvents) ? createCalendarEvents : []),
        ...calendarDates
          .filter((d) => d && d.addToCalendar !== false && d.field && d.date)
          .map((d) => ({
            field: String(d.path || d.field),
            date: String(d.date),
            title: d.title || `📅 ${d.field}`,
            category: d.category || "other",
          })),
      ].filter((e, i, arr) =>
        arr.findIndex((o) => normalizeFieldKey(o.field) === normalizeFieldKey(e.field)) === i);
      if (calendarEventCandidates.length > 0) {
        // A date is only DERIVED if its field actually PERSISTED.
        //
        // `createCalendarEvents` arrives independently of `confirmedFields`, so
        // a date ticked for the calendar alone has no field behind it — and if
        // Step 0's write threw, neither does one that was ticked. Suppressing
        // the event in either case loses the date entirely while the response
        // still reports success, so the set below is the fields that landed.
        for (const event of calendarEventCandidates) {
          try {
            // A rule must be DERIVABLE, not merely plausible. A value the date
            // engine rejects — a range, a sentence, a timestamp — still
            // classifies as actionable from its field NAME, so suppressing on
            // classification alone left the date on no surface at all while
            // the response reported success.
            // A field may arrive as a dotted PATH ("payment.dueDate"). What
            // persisted was keyed on the leaf, so both spellings are tried —
            // otherwise a nested date read as "not covered" and a duplicate
            // event was created beside the derived rule.
            const rawField = String(event.field ?? "");
            const leaf = rawField.split(".").pop() || rawField;
            const key = persistedFieldValues.has(normalizeFieldKey(rawField))
              ? normalizeFieldKey(rawField) : normalizeFieldKey(leaf);
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
              // Say so in the response. The date IS on the calendar — derived
              // from the field rather than copied into an event — and a silent
              // skip here is what made the whole thing feel like it did
              // nothing (user report 2026-08-25).
              saved.push(`Calendar: ${ruleTypeLabel(cls.ruleType)} ${bareDateOf(persistedFieldValues.get(key)) || ""}`.trim());
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
            // Identity, not raw text. The old test lowercased and stripped
            // spaces, so "Weight" and "Body Weight" compared UNEQUAL and a
            // document handed the user a second weight tracker beside the one
            // they already log to (user report 2026-08-25: "Weight", "Body
            // Weight" and "Weight 2" for one measurement). trackerNamesMatch
            // folds noise words and matches whole-token containment, which is
            // the same test the chat path has always used to resolve a tracker
            // — the two doors now agree.
            //
            // Narrowed to the target profile the way pickTrackerForLog does:
            // an owned tracker first, then an orphan nobody has claimed. A
            // tracker owned by SOMEONE ELSE is never adopted — that is how one
            // person's reading lands on another person's chart.
            const nameMatches = findIdentityMatches(trackers as any[], entry.trackerName || "");
            let tracker: any = resolvedProfileId
              ? (nameMatches.find((t: any) => (t.linkedProfiles || []).includes(resolvedProfileId))
                  ?? nameMatches.find((t: any) => (t.linkedProfiles || []).length === 0))
              : nameMatches[0];
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
            // The measurement's own date when the document printed one — a lab
            // drawn last week charts on last week. Bare dates anchor at local
            // noon so the day never rolls across the timezone offset.
            const entryDate = String(entry.date || "").slice(0, 10);
            await storage.logEntry({
              trackerId: tracker.id,
              values: entryValues,
              notes: `From document extraction (${extractionId})`,
              profileId: resolvedProfileId,
              timestamp: isCalendarDay(entryDate)
                ? parseUserDateTime(entryDate, (storage as any)._timezone).toISOString()
                : undefined,
            });
            saved.push(`Logged ${humanName}: ${Object.entries(entryValues).map(([k, v]) => `${k}=${v}`).join(", ")}`);
          } catch (tErr: any) {
            console.error("Failed to log tracker entry from extraction:", tErr.message);
            failures.push(`tracker entry "${entry.trackerName}": ${tErr?.message || "unknown error"}`);
          }
        }
      }

      // 4. Medications and supplements
      //
      // A medication in this app IS a tracker with category "medication"
      // (shared/medication-doses.isMedicationTracker) — its entries are the dose
      // ledger. So a prescription list creates the RECORD and leaves the ledger
      // empty: the document says Sarah is prescribed Cetirizine 10 mg once daily
      // as needed. It does NOT say she took one today, and inventing that entry
      // would corrupt every adherence number computed from it.
      //
      // The dose, frequency and PRN flag live on the profile's medications[]
      // (written with the profile fields above); the tracker exists so the next
      // "took my cetirizine" has somewhere to land.
      if (structuredMedications.length > 0) {
        for (const med of structuredMedications) {
          try {
            const trackers = await storage.getTrackers();
            const matches = findIdentityMatches(trackers as any[], med.name);
            const existing = resolvedProfileId
              ? (matches.find((t: any) => (t.linkedProfiles || []).includes(resolvedProfileId))
                  ?? matches.find((t: any) => (t.linkedProfiles || []).length === 0))
              : matches[0];
            if (existing) {
              if (resolvedProfileId && !(existing.linkedProfiles || []).includes(resolvedProfileId)) {
                try {
                  await storage.updateTracker(existing.id, {
                    linkedProfiles: [...(existing.linkedProfiles || []), resolvedProfileId],
                  } as Partial<Tracker>);
                } catch { /* non-critical */ }
              }
              saved.push(`${med.name} already tracked — recorded the prescription`);
              continue;
            }
            await storage.createTracker({
              name: med.name,
              // No unit: an adherence tracker measures "did I take it?", not a
              // physical quantity (shared/tracker-units.isAdherenceTracker).
              unit: "",
              category: "medication",
              fields: [
                { name: "drugName", type: "text" as const, unit: "", isPrimary: false, options: [] },
                { name: "dosage", type: "text" as const, unit: "", isPrimary: false, options: [] },
                { name: "adherence", type: "select" as const, unit: "", isPrimary: true, options: ["taken", "skipped", "missed"] },
              ],
              linkedProfiles: resolvedProfileId ? [resolvedProfileId] : [],
            } as any);
            const how = [med.dose, med.frequency].filter(Boolean).join(" ");
            saved.push(`Added medication: ${med.name}${how ? ` (${how})` : ""} — no dose logged`);
          } catch (mErr: any) {
            console.error("Failed to create medication tracker from extraction:", mErr?.message);
            failures.push(`medication "${med.name}": ${mErr?.message || "unknown error"}`);
          }
        }
      }

      // 5. Clinical narrative → notes
      //
      // The physical examination summary, the assessment and the plan are prose.
      // Before this, extraction had no note destination at all: every sentence
      // either became a loose profile field ("abdomen: Soft, non-tender") or was
      // dropped. createNote already dedupes on normalized body per profile, so a
      // re-uploaded report adds no second copy.
      for (const n of noteWrites) {
        try {
          const result = await createNote(storage, {
            title: n.title,
            content: n.content,
            profileId: resolvedProfileId || undefined,
            tags: ["document-extraction"],
            source: "chat",
          } as any);
          if ((result as any)?.deduped) {
            saved.push(`Note "${n.title}" already saved — skipped duplicate`);
          } else {
            saved.push(`Created note: ${n.title}`);
          }
        } catch (nErr: any) {
          console.error("Failed to create note from extraction:", nErr?.message);
          failures.push(`note "${n.title}": ${nErr?.message || "unknown error"}`);
        }
      }

      // 6. Follow-ups → tasks
      //
      // "Repeat labs in 6 months" is a commitment, not a fact about today. The
      // task runs through syncDateRulesForEntity exactly as POST /api/tasks
      // does, so it reaches Calendar, Upcoming and Recurring & Important Dates.
      for (const t of taskWrites) {
        try {
          const newTask = await storage.createTask({
            title: t.title,
            priority: "medium",
            status: "todo",
            dueDate: t.dueDate,
            tags: ["document-extraction"],
            linkedProfiles: resolvedProfileId ? [resolvedProfileId] : [],
          } as any);
          await syncDateRulesForEntity(storage, cacheUserKey(req as AuthenticatedRequest), "task", newTask.id).catch(() => null);
          saved.push(`Created task: ${t.title}${t.dueDate ? ` (due ${t.dueDate})` : ""}`);
        } catch (tskErr: any) {
          console.error("Failed to create task from extraction:", tskErr?.message);
          failures.push(`task "${t.title}": ${tskErr?.message || "unknown error"}`);
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
          // Dedupe: one document must never yield two expenses. If an expense
          // with the same date and amount already exists (e.g. auto-created at
          // upload time, or the confirmation was replayed), skip creating a twin.
          const priorExpenses = await storage.getExpenses();
          const duplicate = (priorExpenses || []).find((e: any) =>
            e.date === (exp.date || e.date) && Math.abs(Number(e.amount) - amt) < 0.005
          );
          if (duplicate) {
            saved.push(`Expense $${amt.toFixed(2)} already exists (${duplicate.description}) — skipped duplicate`);
            try { await storage.linkProfileTo(duplicate.id, "document", extractionId); } catch {}
          } else {
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
          const expense = await storage.createExpense({
            description: exp.description,
            amount: amt,
            // One vocabulary: "transportation"/"auto"/"car" all fold to their
            // canonical bucket so the dashboard never splits one category.
            category: canonicalExpenseCategory(exp.category || 'general'),
            vendor: exp.vendor,
            date: exp.date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }),
            tags: [],
            linkedProfiles: expenseLinks,
          });
          saved.push(`Created expense: $${amt.toFixed(2)} ${exp.description}`);
          // Link document to expense
          try { await storage.linkProfileTo(expense.id, "document", extractionId); } catch {}
          }
        } catch (eErr: any) {
          console.error("Failed to create expense from extraction:", eErr?.message);
          failures.push(`expense: ${eErr?.message || "unknown error"}`);
        }
      }

      // Recurring bill — UPDATE ONLY, never create.
      //
      // This is the pre-plan path: it still runs for a chat message rendered
      // from history, and whenever the understanding stage degraded. It used to
      // call storage.createObligation, and in this app that ends in
      // createProfile({ type: "liability" }) — so confirming a declarations
      // page would mint a liability beside the house it was filed under.
      //
      // Document extraction never creates a profile, asset or liability. The
      // action path enforces that in three places; this is the fourth, and it
      // matters precisely because it is the path that runs when the smart one
      // could not.
      if (req.body.createObligation) {
        try {
          const obl = req.body.createObligation;
          const amt = parseFloat(obl.amount);
          if (!isFinite(amt) || amt <= 0) {
            throw new Error("Obligation amount must be a positive number");
          }
          // Is there already a bill this describes? Then update it.
          const priorBills = await storage.getObligations();
          const match = (priorBills || []).find((o: any) => {
            const sameName = String(o?.name || "").trim().toLowerCase()
              === String(obl.name || "").trim().toLowerCase();
            const sameOwner = resolvedProfileId
              && ((o?.linkedProfiles || []).includes(resolvedProfileId) || o?.linkedAssetId === resolvedProfileId);
            return sameName || sameOwner;
          });
          if (match) {
            await storage.updateObligation(match.id, {
              amount: amt,
              frequency: obl.frequency || "monthly",
              ...(obl.nextDueDate ? { nextDueDate: obl.nextDueDate } : {}),
              linkedDocumentId: extractionId,
            } as any);
            saved.push(`Updated bill: $${amt.toFixed(2)}/${obl.frequency || "mo"} ${match.name}`);
          } else {
            skippedFields.push(
              `recurring bill "${obl.name}" — a new bill is stored as a liability, and document extraction never creates one`,
            );
          }
        } catch (oErr: any) {
          console.error("Failed to record obligation from extraction:", oErr?.message);
          failures.push(`obligation: ${oErr?.message || "unknown error"}`);
        }
      }

      // ═══ THE REVIEWED PLAN ═══
      // Runs last, and in stages: entities, then the records that reference
      // them, then the links between them, then dates. A link needs both ends
      // to exist, which is why the order is a dependency graph and not a
      // convention. See server/action-executor.ts.
      let actionResults: Array<{ actionId: string; status: string; message: string }> = [];
      if (reviewedActions.length > 0) {
        const outcome = await executeActions({
          actions: reviewedActions,
          documentId: extractionId,
          documentName: extractionDoc?.name,
        });
        actionResults = outcome.results;
        saved.push(...outcome.saved);
        failures.push(...outcome.failures);

        // Rows the user chose to keep on the document only. Recorded as
        // calendar opt-outs so the rule engine stops deriving an entry for
        // them — the same mechanism the Calendar section already uses, so a
        // signature date declines to become an event by the same route
        // whichever pane the decision was made in.
        if (outcome.calendarOptOuts.length > 0) {
          try {
            const doc = await storage.getDocument(extractionId);
            const data: Record<string, any> = { ...((doc as any)?.extractedData || {}) };
            const prior: string[] = Array.isArray(data[CALENDAR_OPT_OUT_KEY])
              ? data[CALENDAR_OPT_OUT_KEY].map((v: any) => String(v)) : [];
            const next = Array.from(new Set([...prior, ...outcome.calendarOptOuts]));
            if (next.length !== prior.length) {
              data[CALENDAR_OPT_OUT_KEY] = next;
              await storage.updateDocument(extractionId, { extractedData: data });
            }
          } catch (e: any) {
            log.warn(`[confirm-extraction] could not record calendar opt-outs: ${e?.message || e}`);
          }
        }
      }

      // Bust caches BEFORE responding so client's invalidate-and-refetch sees fresh state.
      clearAllCache();

      // If nothing succeeded but at least one thing was attempted-and-failed,
      // surface as 500 so the client shows a real error.
      const attempted = (confirmedFields?.length || 0) + (createCalendarEvents?.length || 0) + (trackerEntries?.length || 0)
        + structuredMedications.length + noteWrites.length + taskWrites.length
        + structuredAllergies.length + structuredConditions.length + structuredSurgeries.length
        + (req.body.createExpense ? 1 : 0) + (req.body.createObligation ? 1 : 0)
        + reviewedActions.filter((a) => a && a.selected !== false && a.operation !== "NO_ACTION").length;
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
        // Per-action outcomes. `skipped` here means "not attempted, because
        // what it depended on failed" — which is the dependency made visible
        // instead of a cascade of secondary errors burying the one real cause.
        actionResults,
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
    const userId = cacheUserKey(req as AuthenticatedRequest, "stats:");
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
    const userId = cacheUserKey(req as AuthenticatedRequest, "enhanced:");
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
    // Several ids → the storage sums their per-profile rows by day (it used
    // to answer the account aggregate for any selection larger than one).
    try {
      const rows = typeof (storage as any).getNetWorthHistory === "function"
        ? await (storage as any).getNetWorthHistory(ids.length > 0 ? ids : undefined, lookbackDays)
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
    // The user's month, not UTC's: late on the last evening of a month (US
    // zones) the UTC default already pointed the budget block at next month.
    const month = (req.query.month as string) || getUserCurrentMonth(getTimezone(req));
    const userId = cacheUserKey(req as AuthenticatedRequest, "bootstrap:");
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
      // `userId` here carries the bootstrap: stamp. stats:, enhanced: and
      // bootstrap: all declare "all", so the three stamps are identical and
      // these seeds land on the keys the real /api/stats and
      // /api/dashboard-enhanced requests will compute. That equality is pinned
      // by tests/cache-key-domains.test.ts — narrowing one of the three without
      // the others would leave this seeding writing keys nobody reads.
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
      const bootCtx = await profileFilterCtx(filterIds || [], profiles, assetPartyLinks, liabilityProfileLinks);
      const filteredExpenses = (!filterIds || filterIds.length === 0)
        ? expensesForBudget
        : expensesForBudget.filter((e: any) => passesProfileFilter(e.linkedProfiles, bootCtx));
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
        : incomes.filter((i: any) => passesProfileFilter(i.linkedProfiles, bootCtx));

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
          : obligationsAll.filter((o: any) => passesProfileFilter(o.linkedProfiles, bootCtx))).slice(0, 100),
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
              return passesProfileFilter(entity.linkedProfiles, bootCtx);
            }),
        // Hero trend-line series (see nwProfileId above). Already scoped by the
        // storage call, so no extra filtering.
        netWorthHistory: Array.isArray(netWorthHistory) ? netWorthHistory : [],
        month,
        filterIds: filterIds || [],
      };

      function scopeByLinkedProfiles<T extends { linkedProfiles?: string[] }>(rows: T[]): T[] {
        if (!filterIds || filterIds.length === 0) return rows || [];
        return (rows || []).filter((x: any) => passesProfileFilter(x.linkedProfiles, bootCtx));
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
      const uid = cacheUserKey(req as AuthenticatedRequest, "insights-data:");
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
      const filterCtx = await profileFilterCtx(ids, allProfiles);
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
      const filterCtx = await profileFilterCtx(ids, profiles);
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
    const uid = cacheUserKey(req as AuthenticatedRequest, "profiles-lite:");
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
    const uid = cacheUserKey(req as AuthenticatedRequest, "profiles:");
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
      const originalFields = (detail as any).fields;
      const cleanup = cleanupStoredProfileFields(originalFields);
      if (cleanup.changed) {
        (detail as any).fields = cleanup.fields;
        log.info(`[profile-cleanup] ${req.params.id} collapsed ${cleanup.removed.length} redundant field(s): ${cleanup.removed.join(", ")}`);
        // Top-level removals need explicit null markers so the storage merge
        // layer deletes them; rewritten nested groups replace wholesale.
        // Only what the cleanup changed. This write-back rides on a READ,
        // beside whatever edit is in flight; handing back the whole map it
        // read put that edit back the way it was.
        const patch: Record<string, any> = fieldPatchBetween(originalFields, cleanup.fields);
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
    const userId = cacheUserKey(req as AuthenticatedRequest, "profile-bootstrap:");
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
      // Compare against the bare user id: `userId` above is the versioned
      // CACHE key ("<uid>@v…"), which never equals a row's user_id.
      if ((detail as any).userId && (detail as any).userId !== (req as AuthenticatedRequest).userId) {
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
          storage.getLiabilityPayments(profileId).catch(() => [] as any[]),
          storage.getLiabilitySchedule(profileId, 12).catch(() => null),
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
    const uid_p1 = cacheUserKey(req as AuthenticatedRequest);
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
      {
        const impossible = impossibleCalendarDays(req.body.fields as Record<string, any>);
        if (impossible.length > 0) return res.status(400).json({ error: `${impossible.join(", ")} must be a real calendar day (YYYY-MM-DD)` });
      }
    }
    // Validate common profile fields if provided
    if (req.body.fields && typeof req.body.fields === "object") {
      const f = req.body.fields;
      const moneyError = validateProfileMoneyFields(f);
      if (moneyError) return res.status(400).json({ error: moneyError });
      if (f.email && typeof f.email === "string" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) {
        return res.status(400).json({ error: "Invalid email format" });
      }
      if (f.phone && typeof f.phone === "string" && !/^[\d\s()+-]{7,20}$/.test(f.phone)) {
        return res.status(400).json({ error: "Invalid phone number format" });
      }
      if (f.birthday && typeof f.birthday === "string" && !isCalendarDay(f.birthday)) {
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
    bustCache(`profiles:${uid_p1}`); bustCache(`stats:${uid_p1}`); bustCache(`profile-detail:${uid_p1}:`);

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
    let renamedFromName: string | undefined;
    if (req.body.name !== undefined) {
      if (typeof req.body.name !== "string" || req.body.name.trim() === "") {
        return res.status(400).json({ error: "Profile name must be a non-empty string" });
      }
      req.body.name = sanitize(req.body.name);
      // A rename is checked here rather than in each screen, so the manual
      // door and the AI door refuse the same names: two profiles answering to
      // one name make every later "update <name>" a coin flip.
      // shared/profile-rename.ts holds the rule both callers read.
      const existingProfile = await storage.getProfile(req.params.id);
      if (!existingProfile) return res.status(404).json({ error: "Not found" });
      const rename = checkProfileRename(
        storage.getProfilesLite ? await storage.getProfilesLite() : await storage.getProfiles(),
        req.params.id,
        req.body.name,
        existingProfile.name,
      );
      if (rename.status === "rejected") return res.status(409).json({ error: rename.error });
      if (rename.status === "ok") renamedFromName = existingProfile.name;
      req.body.name = rename.name;
    }
    if (req.body.type !== undefined) {
      // Same rule the AI path is held to, for the same reason: a record may
      // become any KIND except the user's own, which the app resolves by type.
      const current = await storage.getProfile(req.params.id);
      if (!current) return res.status(404).json({ error: "Not found" });
      const typeCheck = checkProfileTypeChange(current.type, req.body.type);
      if (typeCheck.status === "rejected") return res.status(400).json({ error: typeCheck.error });
      if (typeCheck.status === "unchanged") delete req.body.type;
      else req.body.type = typeCheck.type;
    }
    // Manual entry follows the exact same rule as extraction and chat: a date
    // typed as "7/18/2034" is stored as 2034-07-18, so the Date Rule engine
    // (shared/date-rules) derives the same rule whichever door the date came
    // in by. No screen-specific shortcut.
    if (req.body.fields && typeof req.body.fields === "object") {
      req.body.fields = normalizeEntityDateFields(req.body.fields as Record<string, any>).fields;
      {
        const impossible = impossibleCalendarDays(req.body.fields as Record<string, any>);
        if (impossible.length > 0) return res.status(400).json({ error: `${impossible.join(", ")} must be a real calendar day (YYYY-MM-DD)` });
      }
    }
    // Validate common profile fields if provided
    if (req.body.fields && typeof req.body.fields === "object") {
      const f = req.body.fields;
      const moneyError = validateProfileMoneyFields(f);
      if (moneyError) return res.status(400).json({ error: moneyError });
      if (f.email && typeof f.email === "string" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) {
        return res.status(400).json({ error: "Invalid email format" });
      }
      if (f.phone && typeof f.phone === "string" && !/^[\d\s()+-]{7,20}$/.test(f.phone)) {
        return res.status(400).json({ error: "Invalid phone number format" });
      }
      if (f.birthday && typeof f.birthday === "string" && !isCalendarDay(f.birthday)) {
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
        // Existence, cycle and depth — the same guards the accounts route runs.
        const problem = await checkParentAssignment(uid_p2, req.params.id, newParentId);
        if (problem) return res.status(problem.status).json({ error: problem.error });
      }

      // Persist: set top-level parentProfileId. The legacy `fields._parentProfileId`
      //   shadow is no longer written — the column is the single source of truth.
      //   If the caller sent the shadow, strip it so it can't slip in.
      req.body.parentProfileId = newParentId;
      if (req.body.fields && typeof req.body.fields === "object" && "_parentProfileId" in req.body.fields) {
        delete req.body.fields._parentProfileId;
      }
    }

    const previousName: string | undefined = renamedFromName;
    const updated = await storage.updateProfile(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    // A rename carries into the titles the app generated from the old name —
    // the same follow-up the chat tool does, so both doors leave the data in
    // the same state. Best-effort; the rename itself has already landed.
    if (previousName && updated.name && previousName !== updated.name) {
      try { await cascadeProfileRename(storage, req.params.id, previousName, updated.name); }
      catch (err) { console.warn("[routes:patch-profile] rename cascade failed:", err); }
    }
    // `enhanced:` with no uid dropped here: it cleared the dashboard of every
    // user on this instance, and bustUserCaches() already covers this one.
    bustCache(`profiles:${uid_p2}`); bustCache(`stats:${uid_p2}`); bustCache(`profile-detail:${uid_p2}:`); bustCache(`cashflow:${uid_p2}`);
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
    const uid_p3 = cacheUserKey(req as AuthenticatedRequest);
    const existing = await storage.getProfile(req.params.id);
    if (!existing) return res.status(404).json({ error: "Profile not found" });
    // The Info tab can now delete a person or a pet outright, so this route is
    // reachable by hand rather than only from code paths that already knew
    // what they were deleting. shared/profile-delete.ts holds the one rule —
    // the self profile is not deletable — so the screen and the route refuse
    // for the same reason and say the same sentence.
    const deletable = checkProfileDelete(existing);
    if (deletable.status === "rejected") {
      return res.status(400).json({ error: deletable.error });
    }
    const ok = await storage.deleteProfile(req.params.id);
    bustCache(`profiles:${uid_p3}`); bustCache(`stats:${uid_p3}`); bustCache(`profile-detail:${uid_p3}:`); bustCache(`cashflow:${uid_p3}`);
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
      bustCache(`profiles:${uid_pl1}`); bustCache(`profile-detail:${uid_pl1}:`); bustCache(`stats:${uid_pl1}`); bustCache(`${entityType}s:${uid_pl1}`);
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[profile-link]", err?.message || err);
      res.status(500).json({ error: "Link failed" });
    }
  }));

  app.post("/api/profiles/:id/unlink", asyncHandler(async (req, res) => {
    const { entityType, entityId } = req.body;
    // The unlink writes under this user's storage and never fails for a
    // profile that is not theirs; answer 404 unless the profile is the caller's.
    if (!(await storage.getProfile(req.params.id))) return res.status(404).json({ error: "Resource not found" });
    await storage.unlinkProfileFrom(req.params.id, entityType, entityId);
    const uid_pl2 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`profiles:${uid_pl2}`); bustCache(`profile-detail:${uid_pl2}:`); bustCache(`stats:${uid_pl2}`); bustCache(`${entityType}s:${uid_pl2}`);
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

  // ---- Dynamic Overview (asset & liability profiles) ----
  // GET /api/profiles/:id/overview
  //
  // Returns the STRUCTURED Overview definition for this entity — sections,
  // metrics, relationships, attention items, missing-information suggestions —
  // with every displayed value resolved from canonical storage on this
  // request. The layout half is reasoned once per structural signature and
  // cached; the data half is never cached, so an edited balance shows up
  // immediately and a deleted field disappears immediately.
  //
  //   ?refresh=true  re-reason the composition even if the shape is unchanged
  //   ?ai=0          deterministic composition only (no model call)
  app.get("/api/profiles/:id/overview", asyncHandler(async (req, res) => {
    const { id } = req.params;
    const profile = await storage.getProfile(id);
    if (!profile) return res.status(404).json({ error: "Not found" });
    if ((profile as any).userId && (profile as any).userId !== (req as AuthenticatedRequest).userId) {
      return res.status(404).json({ error: "Not found" });
    }
    if (!isOverviewEntity(profile as any)) {
      // Person / pet / medical profiles keep their own purpose-built Overview.
      return res.status(409).json({ error: "Not an asset or liability profile" });
    }
    try { (storage as any).enableRequestMemo?.(); } catch {}
    try {
      const spec = await buildOverviewSpec(storage, id, {
        refresh: req.query.refresh === "true",
        allowModel: req.query.ai !== "0",
      });
      if (!spec) return res.status(404).json({ error: "Not found" });
      res.json(spec);
    } catch (err: any) {
      log.error("[overview]", err?.message || "unknown error");
      // A failed composition must never blank the profile page — the client
      // falls back to its static rendering when this 500s.
      res.status(500).json({ error: "Failed to build overview" });
    } finally {
      try { (storage as any).disableRequestMemo?.(); } catch {}
    }
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
    const uid = cacheUserKey(req as AuthenticatedRequest, "trackers:");
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
    applyActiveProfileScope(req, req.body);
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
    bustCache(`trackers:${uid_tr1}`); bustCache(`stats:${uid_tr1}`);
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
    bustCache(`trackers:${uid_tr2}`); bustCache(`stats:${uid_tr2}`);
    res.json(updated);
  }));
  // ONE timestamp rule for every tracker-entry write. A zone-less value
  // ("2026-09-02T22:30", what <input type="datetime-local"> posts) is the
  // user's wall clock, read in the caller's zone; a qualified instant passes
  // through; junk is a 400. Storage stores the string it is given, so before
  // this a datetime-local value landed as UTC — an evening entry moved to the
  // next day for anyone west of Greenwich — and junk failed inside Postgres.
  const parseEntryTimestamp = (raw: unknown, req: Request): { iso?: string; error?: string } => {
    if (typeof raw !== "string" || !raw.trim()) return { error: "timestamp must be a date/time string" };
    const d = parseUserDateTime(raw, getTimezone(req));
    if (isNaN(d.getTime())) return { error: "timestamp must be a valid date/time" };
    return { iso: d.toISOString() };
  };
  // The tracker-scoped and by-id PATCH routes accept the same body; the
  // storage patch is built once so the two cannot drift.
  const buildTrackerEntryPatch = (req: Request, trackerFields: any): { patch?: any; error?: string } => {
    const { values, notes, mood, tags, timestamp, valuesToDelete } = req.body || {};
    const patch: any = {};
    // The same value gate as POST (server/tracker-entry-guard.ts), so an edit
    // can't smuggle a value the create path would have rejected.
    if (values && typeof values === "object") {
      const guard = sanitizeTrackerEntryValues(trackerFields, values);
      if (guard.error) return { error: guard.error };
      patch.values = guard.values;
    }
    if (notes !== undefined) patch.notes = notes;
    if (mood !== undefined) patch.mood = mood;
    if (tags !== undefined) patch.tags = tags;
    if (timestamp !== undefined && timestamp !== null && timestamp !== "") {
      const ts = parseEntryTimestamp(timestamp, req);
      if (ts.error) return { error: ts.error };
      patch.timestamp = ts.iso;
    }
    // P1 universal-delete: clients can pass `valuesToDelete: [key, ...]` to
    // remove specific keys from the entry.values JSONB. Shallow-PATCH'ing
    // `{ values: rest }` no longer removes keys after the storage rewrite,
    // so we surface the explicit deletion signal here instead.
    if (Array.isArray(valuesToDelete)) {
      const clean = valuesToDelete.filter((k: any) => typeof k === "string" && k.length > 0);
      if (clean.length > 0) patch.valuesToDelete = clean;
    }
    return { patch };
  };
  // Resolve an entry the caller knows only by id (chat result cards) to the
  // tracker that owns it. This used to scan getTrackers(), whose entries are
  // windowed to the last 120 days — so any older entry was "not found". The
  // by-id read proves the entry exists (it is user-scoped) but carries no
  // trackerId in either storage, so the owner is looked for in the default
  // window first and, on a miss, in an effectively unbounded one.
  const ALL_TRACKER_ENTRIES_DAYS = 36_500;
  const locateTrackerEntry = async (entryId: string): Promise<{ tracker: Tracker; entry: any } | null> => {
    const entry: any = await storage.getTrackerEntry(entryId);
    if (!entry || typeof entry !== "object") return null;
    const owning = (trackers: Tracker[]) => trackers.find((t) => (t.entries || []).some((e: any) => e?.id === entryId));
    const hinted = typeof entry.trackerId === "string" && entry.trackerId ? await storage.getTracker(entry.trackerId) : undefined;
    const tracker = hinted || owning(await storage.getTrackers()) || owning(await storage.getTrackers(ALL_TRACKER_ENTRIES_DAYS));
    return tracker ? { tracker, entry } : null;
  };

  app.post("/api/trackers/:id/entries", asyncHandler(async (req, res) => {
    const { values } = req.body;
    if (!values || typeof values !== "object") {
      return res.status(400).json({ error: "Values required" });
    }
    if (req.body.timestamp !== undefined) {
      if (req.body.timestamp === null || req.body.timestamp === "") {
        delete req.body.timestamp; // "no timestamp": storage stamps now
      } else {
        const ts = parseEntryTimestamp(req.body.timestamp, req);
        if (ts.error) return res.status(400).json({ error: ts.error });
        req.body.timestamp = ts.iso;
      }
    }
    // ONE value gate (server/tracker-entry-guard.ts), shared with logEntry in
    // both storages, so this route, smart-entry, the AI quick-log lanes and
    // extraction all enforce the same coercion and sanity bounds. Running it
    // here too turns a rejection into a clean 400 instead of a 500.
    {
      const tracker = await storage.getTracker(req.params.id);
      const guard = sanitizeTrackerEntryValues(tracker?.fields, values);
      if (guard.error) return res.status(400).json({ error: guard.error });
      for (const k of Object.keys(guard.values)) (values as any)[k] = guard.values[k];
      // Pet-specific tighter bound — needs profile context the pure guard
      // deliberately doesn't have.
      const w = (guard.values as any).weight;
      if (typeof w === "number" && w > 500 && tracker) {
        const profiles = await storage.getProfiles();
        const isPetTracker = (tracker.linkedProfiles || []).some(pid =>
          profiles.find(pr => pr.id === pid)?.type === "pet");
        if (isPetTracker) {
          return res.status(400).json({ error: `Pet weight ${w} lbs is unrealistic. Max: 500 lbs.` });
        }
      }
    }
    const parsed = insertTrackerEntrySchema.safeParse({ ...req.body, trackerId: req.params.id });
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation failed", issues: parsed.error.issues });
    const entry = await storage.logEntry(parsed.data);
    if (!entry) return res.status(404).json({ error: "Tracker not found" });
    const uid_te1 = cacheUserKey(req as AuthenticatedRequest); bustCache(`stats:${uid_te1}`);
    res.status(201).json(entry);
  }));
  app.patch("/api/trackers/:id/entries/:entryId", asyncHandler(async (req, res) => {
    // The tracker's field definitions drive the value gate; only fetched when
    // there are values to gate (a notes-only edit never needed the tracker).
    let trackerFields: any = undefined;
    if (req.body?.values && typeof req.body.values === "object") {
      const tracker = await storage.getTracker(req.params.id);
      if (!tracker) return res.status(404).json({ error: "Tracker not found" });
      trackerFields = tracker.fields;
    }
    const built = buildTrackerEntryPatch(req, trackerFields);
    if (built.error) return res.status(400).json({ error: built.error });
    const updated = await storage.updateTrackerEntry(req.params.id, req.params.entryId, built.patch);
    if (!updated) return res.status(404).json({ error: "Entry not found" });
    const uid_tep = cacheUserKey(req as AuthenticatedRequest); bustCache(`stats:${uid_tep}`);
    res.json(updated);
  }));
  app.delete("/api/trackers/:id/entries/:entryId", asyncHandler(async (req, res) => {
    // One remove operation: deletes the entry AND, when it mirrors a habit
    // completion, the habit check-in it mirrors (otherwise the habit stays
    // "done" off a record the user just removed).
    const removed = await removeTrackerEntry(storage, { trackerId: req.params.id, entryId: req.params.entryId }, getTimezone(req), log);
    if (!removed.ok) return res.status(404).json({ error: "Entry not found" });
    const uid_te2 = cacheUserKey(req as AuthenticatedRequest); bustCache(`stats:${uid_te2}`);
    if (removed.removedHabitCheckinId) bustCache(`habits:${uid_te2}`);
    res.json({ success: true, removedHabitCheckinId: removed.removedHabitCheckinId });
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
    const located = await locateTrackerEntry(req.params.entryId);
    if (!located) return res.status(404).json({ error: "Entry not found" });
    // Same value gate + timestamp rule as the tracker-scoped PATCH above.
    const built = buildTrackerEntryPatch(req, located.tracker.fields);
    if (built.error) return res.status(400).json({ error: built.error });
    const updated = await storage.updateTrackerEntry(located.tracker.id, req.params.entryId, built.patch);
    if (!updated) return res.status(404).json({ error: "Entry not found" });
    const uid_tep2 = cacheUserKey(req as AuthenticatedRequest); bustCache(`stats:${uid_tep2}`); bustCache(`profile-detail:${uid_tep2}:`);
    return res.json(updated);
  }));
  app.delete("/api/tracker-entries/:entryId", asyncHandler(async (req, res) => {
    const located = await locateTrackerEntry(req.params.entryId);
    if (!located) return res.status(404).json({ error: "Entry not found" });
    const removed = await removeTrackerEntry(storage, { trackerId: located.tracker.id, entryId: req.params.entryId }, getTimezone(req), log);
    if (!removed.ok) return res.status(404).json({ error: "Entry not found" });
    const uid_te3 = cacheUserKey(req as AuthenticatedRequest); bustCache(`stats:${uid_te3}`);
    if (removed.removedHabitCheckinId) bustCache(`habits:${uid_te3}`);
    return res.json({ success: true, removedHabitCheckinId: removed.removedHabitCheckinId });
  }));
  app.delete("/api/trackers/:id", asyncHandler(async (req, res) => {
    const existing = await storage.getTracker(req.params.id);
    if (!existing) return res.status(404).json({ error: "Tracker not found" });
    // A storage delete that returns false did NOT remove the row (a failed
    // cascade rolls back, an RLS miss matches nothing): answering 200 then
    // left the client believing the record was gone while every list still
    // showed it.
    if (!(await storage.deleteTracker(req.params.id))) {
      return res.status(500).json({ error: "Tracker could not be deleted. Nothing was removed — please try again." });
    }
    // Bug fix: deleted trackers stayed visible for up to 5 minutes because
    // the trackers list cache wasn't busted.
    const uid_tr3 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`trackers:${uid_tr3}`); bustCache(`stats:${uid_tr3}`);
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

    const uid_se = cacheUserKey(req as AuthenticatedRequest); bustCache(`stats:${uid_se}`);
    res.status(201).json({
      entry,
      tracker: { id: tracker.id, name: tracker.name },
      ai: { source: decision.source, confidence: decision.value.confidence, reason: decision.value.reason },
    });
  }));

  // ---- Tasks ----
  app.get("/api/tasks", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest, "tasks:");
    const ck = `tasks:${uid}`;
    const hit = getCached(ck);
    let items: Awaited<ReturnType<typeof storage.getTasks>> = hit || await dedupe(ck, () => storage.getTasks());
    if (!hit) setCache(ck, items, 5 * 60 * 1000); // version-stamped key (migration 010): fresh by construction; TTL only bounds memory
    // Support both ?profileId=x (single) and ?profileIds=x,y (multi)
    const fp = req.query.profileId as string | undefined;
    const fps = req.query.profileIds as string | undefined;
    const filterProfileIds = fps ? fps.split(",").filter(Boolean) : fp ? [fp] : [];
    if (filterProfileIds.length > 0) {
      items = await filterByProfileScope(items, filterProfileIds, uid);
    }
    res.json(paginateFull(items, req, res));
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
    const result = await createNote(storage, {
      content, title, profileId,
      tags: Array.isArray(req.body.tags) ? req.body.tags.map(String) : [],
      source: "manual",
    });
    const uid_n1 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`artifacts:${uid_n1}`); bustCache(`stats:${uid_n1}`);
    res.status(result.deduped ? 200 : 201).json({ ...result.note, deduped: result.deduped });
  }));
  app.patch("/api/notes/:id", asyncHandler(async (req, res) => {
    const changes: Record<string, any> = {};
    if (typeof req.body?.title === "string") changes.title = sanitize(req.body.title);
    if (typeof req.body?.content === "string") changes.content = sanitize(req.body.content);
    if (typeof req.body?.append === "string") changes.append = sanitize(req.body.append);
    if (Array.isArray(req.body?.tags)) changes.tags = req.body.tags.map(String);
    const updated = await updateNote(storage, req.params.id, changes);
    if (!updated) return res.status(404).json({ error: "Note not found" });
    const uid_n2 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`artifacts:${uid_n2}`); bustCache(`stats:${uid_n2}`);
    res.json(updated);
  }));
  app.delete("/api/notes/:id", asyncHandler(async (req, res) => {
    const ok = await deleteNote(storage, req.params.id);
    if (!ok) return res.status(404).json({ error: "Note not found" });
    const uid_n3 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`artifacts:${uid_n3}`); bustCache(`stats:${uid_n3}`);
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
    const uid_t1 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`tasks:${uid_t1}`); bustCache(`stats:${uid_t1}`); bustCache(`calendar:${uid_t1}`); bustCache(`notifications:${uid_t1}`);
    // TEMPORAL LAYER — the same step the chat path runs. A manually-created
    // task with a due date or a recurrence must reach the Calendar, Upcoming
    // and Recurring & Important Dates exactly as an AI-created one does.
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
    const uid_t2 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`tasks:${uid_t2}`); bustCache(`stats:${uid_t2}`); bustCache(`calendar:${uid_t2}`); bustCache(`notifications:${uid_t2}`);
    // Re-derive after the edit: moving a due date moves the occurrence, and
    // clearing one removes it. Both fall out of the record automatically —
    // this reports the result so the caller never has to guess.
    const rules_t2 = await syncDateRulesForEntity(storage, uid_t2, "task", updated.id).catch(() => null);
    res.json({ ...updated, ...(rules_t2 ? { dateRules: rules_t2.rules } : {}) });
  }));
  app.delete("/api/tasks/:id", asyncHandler(async (req, res) => {
    // The storage reports whether a live row of this user's was retired; a
    // task that is not yours, or is already gone, is a 404 — not a success.
    if (!(await storage.deleteTask(req.params.id))) return res.status(404).json({ error: "Task not found" });
    const uid_t3 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`tasks:${uid_t3}`); bustCache(`stats:${uid_t3}`); bustCache(`calendar:${uid_t3}`); bustCache(`notifications:${uid_t3}`);
    res.json({ success: true });
  }));
  app.patch("/api/tasks/:id/restore", asyncHandler(async (req, res) => {
    const ok = await storage.restoreTask(req.params.id);
    if (!ok) return res.status(404).json({ error: "Task not found" });
    const uid_t4 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`tasks:${uid_t4}`); bustCache(`stats:${uid_t4}`); bustCache(`calendar:${uid_t4}`); bustCache(`notifications:${uid_t4}`);
    const task = await storage.getTask(req.params.id);
    res.json(task || { id: req.params.id, restored: true });
  }));

  // ---- Budgets ----
  // A month is "YYYY-MM": "2026-9" is folded to "2026-09" and anything else is
  // a 400, so a budget can no longer be written to a bucket no reader shows.
  const budgetMonthParam = (raw: unknown, req: any): string | null =>
    raw === undefined || raw === null || raw === "" ? getUserCurrentMonth(getTimezone(req)) : normalizeMonthKey(raw);

  app.get("/api/budgets", asyncHandler(async (req, res) => {
    const month = budgetMonthParam(req.query.month, req);
    if (!month) return res.status(400).json({ error: "month must be YYYY-MM" });
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
    const m = budgetMonthParam(month, req);
    if (!m) return res.status(400).json({ error: "month must be YYYY-MM" });
    const budget = await storage.addBudget(m, category.trim(), parsedAmount, notes, profileId || undefined);
    res.json(budget);
  }));

  app.patch("/api/budgets/:id", asyncHandler(async (req, res) => {
    const month = budgetMonthParam(req.query.month, req);
    if (!month) return res.status(400).json({ error: "month must be YYYY-MM" });
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
    const month = budgetMonthParam(req.query.month, req);
    if (!month) return res.status(400).json({ error: "month must be YYYY-MM" });
    const ok = await storage.deleteBudget(month, req.params.id);
    if (!ok) return res.status(404).json({ error: "Budget not found" });
    res.json({ success: true });
  }));

  app.post("/api/budgets/copy", asyncHandler(async (req, res) => {
    const fromMonth = normalizeMonthKey(req.body?.fromMonth);
    const toMonth = normalizeMonthKey(req.body?.toMonth);
    if (!fromMonth || !toMonth) return res.status(400).json({ error: "fromMonth and toMonth are required as YYYY-MM" });
    // Adds the caps the destination month lacks; caps already set there stay.
    const count = await storage.copyBudgetsToMonth(fromMonth, toMonth);
    res.json({ copied: count, fromMonth, toMonth });
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
    const result = await applyImport(storage, validation.data, profileId, plan, { month: getUserCurrentMonth(getTimezone(req)) });
    // `failed` names the records the commit could not write (the batch is
    // still recorded and undoable for everything that landed).
    res.json({ ok: result.failed.length === 0, batchId: result.batchId, summary: result.summary, failed: result.failed, plan, profileId });
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
    const uid = cacheUserKey(req as AuthenticatedRequest, "expenses:");
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

    // Wave 1 #1 — AI categorize when caller didn't provide a meaningful category.
    // Only fires for missing / "other" / "general" so we don't override deliberate picks.
    if (!req.body.category || req.body.category === "other" || req.body.category === "general") {
      try {
        const decision = await aiPickIndex({
          task: "expense-create-category",
          question: "Which expense category does this transaction belong to?",
          context: `Description: "${req.body.description}"${req.body.vendor ? `\nVendor: "${req.body.vendor}"` : ""}\nAmount: $${req.body.amount}`,
          options: [...EXPENSE_CATEGORIES],
          timeoutMs: 3000,
          minConfidence: 0.55,
          fallback: () => -1,
        });
        if (decision.value.index >= 0) {
          req.body.category = EXPENSE_CATEGORIES[decision.value.index];
        }
      } catch (e: any) {
        console.error(`[expense-create] AI categorize failed silently: ${e?.message || e}`);
      }
    }

    // Profile isolation (QA 2026-07-29 PROP-005): an expense created while a
    // single profile is in scope belongs to that profile, whether or not the
    // form remembered to say so.
    applyActiveProfileScope(req, req.body);

    const parsed = insertExpenseSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation failed", issues: parsed.error.issues });
    const newExpense = await storage.createExpense(parsed.data);
    const uid_e1 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`expenses:${uid_e1}`); bustCache(`stats:${uid_e1}`);
    // Tell the caller when their text was altered — never change it silently.
    res.status(201).json(expenseSanitized ? { ...newExpense, warning: SANITIZE_NOTICE } : newExpense);
  }));
  app.patch("/api/expenses/:id", asyncHandler(async (req, res) => {
    {
      const parsed = insertExpenseSchema.partial().safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: `Validation failed: ${JSON.stringify(parsed.error.flatten())}` });
      // A blank date input parses to undefined ("not given"); drop it rather
      // than hand storage a patch that names the column with nothing in it.
      req.body = withoutUndefined({ ...req.body, ...parsed.data });
    }
    if (req.body.amount !== undefined) {
      if (typeof req.body.amount !== "number") return res.status(400).json({ error: "Expense amount must be a positive number" });
      const amountError = validateTransactionAmount(req.body.amount);
      if (amountError) return res.status(400).json({ error: amountError });
    }
    // The same gates the create route runs: an edit could blank the
    // description and store a raw category ("Utility Bill" next to
    // "utilities"), re-splitting the buckets the canon folds on create.
    if (req.body.description !== undefined) {
      if (typeof req.body.description !== "string" || !req.body.description.trim()) return res.status(400).json({ error: "Description required" });
      req.body.description = sanitize(req.body.description);
    }
    if (req.body.category !== undefined) req.body.category = canonicalExpenseCategory(req.body.category);
    if (req.body.vendor) req.body.vendor = sanitize(req.body.vendor);
    const updated = await storage.updateExpense(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    const uid_e2 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`expenses:${uid_e2}`); bustCache(`stats:${uid_e2}`);
    res.json(updated);
  }));
  app.delete("/api/expenses/:id", asyncHandler(async (req, res) => {
    if (!(await storage.deleteExpense(req.params.id))) return res.status(404).json({ error: "Expense not found" });
    const uid_e3 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`expenses:${uid_e3}`); bustCache(`stats:${uid_e3}`);
    res.json({ success: true });
  }));
  // Expenses were the one soft-deleted entity with NO restore route — 6,000+
  // recoverable rows and no way to recover any of them.
  app.post("/api/expenses/:id/restore", asyncHandler(async (req, res) => {
    const ok = await storage.restoreEntity("expense", req.params.id);
    if (!ok) return res.status(404).json({ error: "Expense not found" });
    const uid_er = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`expenses:${uid_er}`); bustCache(`stats:${uid_er}`);
    res.json({ success: true });
  }));

  // ---- Paychecks ----
  app.get("/api/paychecks", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest, "paychecks:");
    const ck = `paychecks:${uid}`;
    const hit = getCached(ck);
    let items: Awaited<ReturnType<typeof storage.getPaychecks>> = hit || await dedupe(ck, () => storage.getPaychecks());
    if (!hit) setCache(ck, items, 5 * 60 * 1000); // version-stamped key (migration 010): fresh by construction; TTL only bounds memory
    const profileIdsParam = req.query.profileIds as string | undefined;
    const profileId = req.query.profileId as string | undefined;
    const ids = profileIdsParam ? profileIdsParam.split(",").filter(Boolean) : (profileId ? [profileId] : []);
    if (ids.length > 0) {
      // Canonical scope rule (orphans pass for Self) plus the direct owner id.
      const inScope = new Set((await filterByProfileScope(items, ids, uid)).map((i: any) => i.id));
      items = items.filter((item: any) => inScope.has(item.id) || ids.includes(item.profileId));
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
    bustCache(`paychecks:${uid_pc1}`); bustCache(`stats:${uid_pc1}`); bustCache(`cashflow:${uid_pc1}`);
    res.json(created);
  }));

  app.patch("/api/paychecks/:id/confirm", asyncHandler(async (req, res) => {
    const { actual_amount } = req.body;
    const updated = await storage.confirmPaycheck(req.params.id, actual_amount);
    const uid_pc2 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`paychecks:${uid_pc2}`); bustCache(`stats:${uid_pc2}`); bustCache(`cashflow:${uid_pc2}`);
    res.json(updated);
  }));

  app.delete("/api/paychecks/:id", asyncHandler(async (req, res) => {
    // The storage reports whether a row was removed, so a paycheck that is
    // not this user's (or is already gone) is a 404 rather than a success.
    const removed = await storage.deletePaycheck(req.params.id);
    if (!removed) return res.status(404).json({ error: "Paycheck not found" });
    const uid_pc3 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`paychecks:${uid_pc3}`); bustCache(`stats:${uid_pc3}`); bustCache(`cashflow:${uid_pc3}`);
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
      // Canonical scope rule (orphans pass for Self) plus the direct owner id.
      const loanUid = cacheUserKey(req as AuthenticatedRequest, "profiles:");
      const inScope = new Set((await filterByProfileScope(items, ids, loanUid)).map((i: any) => i.id));
      items = items.filter((item: any) => inScope.has(item.id) || ids.includes(item.profileId));
    }
    res.json(items);
  }));

  app.post("/api/loans/schedule", asyncHandler(async (req, res) => {
    const { entries } = req.body;
    if (!Array.isArray(entries)) return res.status(400).json({ error: "entries array required" });
    // The rows used to go to the table as given: an empty entry was a 500, a
    // loan id nobody owns produced a schedule (and projected payments) for a
    // loan that does not exist.
    const entrySchema = z.object({
      loan_id: z.string().uuid(),
      loan_name: z.string().min(1),
      payment_number: z.number().int().min(1),
      payment_date: z.string().refine((v) => isRealCalendarDay(v), "payment_date must be a real calendar day (YYYY-MM-DD)"),
      principal_amount: z.number().finite().min(0),
      interest_amount: z.number().finite().min(0),
      total_payment: z.number().finite().min(0),
      remaining_balance: z.number().finite().min(0),
    }).strict();
    const parsed = z.array(entrySchema).min(1).safeParse(entries);
    if (!parsed.success) return res.status(400).json({ error: `Validation failed: ${JSON.stringify(parsed.error.flatten())}` });
    for (const loanId of new Set(parsed.data.map((e) => e.loan_id))) {
      const loan = await storage.getProfile(loanId);
      if (!loan) return res.status(404).json({ error: "Loan not found" });
    }
    const created = await storage.createLoanSchedule(parsed.data);
    const uid_ln1 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`stats:${uid_ln1}`); bustCache(`cashflow:${uid_ln1}`); bustCache(`profile-detail:${uid_ln1}:`);
    res.json(created);
  }));

  app.patch("/api/loans/payment/:id/mark", asyncHandler(async (req, res) => {
    // Thin adapter over the one pay operation. Marking an amortization row
    // paid used to flip `loan_amortization.paid` and nothing else — no payment
    // row, no balance move — a boolean only the cashflow projection read.
    //
    // Order matters: the ledger write comes FIRST and the flag SECOND. The
    // flag used to be set before the payment and the payment's failure was
    // only logged, so a row read "paid" with no payment behind it while the
    // caller saw a 200.
    const rows = await storage.getAllLoanSchedules();
    const row = (rows || []).find((r: any) => r?.id === req.params.id);
    if (!row) return res.status(404).json({ error: "Amortization row not found" });
    // Already flagged: the payment behind it exists; never record it twice.
    if (row.paid) return res.json({ ...row, alreadyPaid: true });
    if (row.loan_id) {
      const paid = await payBillOccurrence(storage, row.loan_id, {
        occurrenceDate: String(row.payment_date || "").slice(0, 10) || null,
        amount: Number(row.total_payment) || null,
        principal: Number(row.principal_amount) || null,
        interest: Number(row.interest_amount) || null,
        notes: `Amortization payment #${row.payment_number ?? ""}`.trim(),
        source: "route",
      }, getTimezone(req), log);
      if (!paid.ok) {
        log.warn("[loans/mark] ledger write failed", paid.reason);
        const failed = paid.reason === "payment_failed";
        return res.status(failed ? 500 : 404).json({ error: failed ? "Payment failed" : "Loan not found", reason: paid.reason });
      }
    }
    const updated = await storage.markLoanPayment(req.params.id);
    const uid_ln2 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`stats:${uid_ln2}`); bustCache(`cashflow:${uid_ln2}`); bustCache(`profile-detail:${uid_ln2}:`);
    res.json(updated);
  }));

  // ---- Cashflow ----
  app.get("/api/cashflow", asyncHandler(async (req, res) => {
    // The client sends no ?month; storage's own default is the UTC month, which
    // is next month for an evening caller west of Greenwich on the last day.
    // Default here, in the user's zone, and pass it explicitly.
    const month = budgetMonthParam(req.query.month, req);
    if (!month) return res.status(400).json({ error: "month must be YYYY-MM" });
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
      const filterCtx = await profileFilterCtx(ids, allProfiles);
      items = items.filter((item: any) => {
        const linked = item.linkedProfiles || [];
        if (item.profileId && ids.includes(item.profileId)) return true;
        return passesProfileFilter(linked, filterCtx);
      });
    }
    res.json(items);
  }));

  app.post("/api/cashflow", asyncHandler(async (req, res) => {
    const { month: rawMonth, week: rawWeek, projected_income, projected_expenses, actual_income, actual_expenses } = req.body;
    if (!rawMonth || typeof rawMonth !== "string") return res.status(400).json({ error: "month is required" });
    // "2026-9" used to be stored verbatim and never read back under "2026-09".
    const month = normalizeMonthKey(rawMonth);
    if (!month) return res.status(400).json({ error: "month must be YYYY-MM" });
    if (rawWeek === undefined || rawWeek === null) return res.status(400).json({ error: "week is required" });
    const week = typeof rawWeek === "number" ? rawWeek : Number(rawWeek);
    // The table's CHECK allows weeks 1–5 (a month spans at most five
    // Mon–Sun slices); 6 used to pass here and die on the constraint as a 500.
    if (!Number.isInteger(week) || week < 1 || week > 5) return res.status(400).json({ error: "week must be an integer from 1 to 5" });
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
    const uid = cacheUserKey(req as AuthenticatedRequest, "events:");
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
    res.json(paginateFull(items, req, res));
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
    applyActiveProfileScope(req, req.body);
    const parsed = insertEventSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation failed", issues: parsed.error.issues });
    const newEvent = await storage.createEvent(parsed.data);
    const uid_ev1 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`events:${uid_ev1}`); bustCache(`stats:${uid_ev1}`); bustCache(`calendar:${uid_ev1}`);
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
    bustCache(`events:${uid_ev2}`); bustCache(`stats:${uid_ev2}`); bustCache(`calendar:${uid_ev2}`);
    res.json(updated);
  }));
  app.delete("/api/events/:id", asyncHandler(async (req, res) => {
    const existing = await storage.getEvent(req.params.id);
    if (!existing) return res.status(404).json({ error: "Event not found" });
    // A storage delete that returns false did NOT remove the row (a failed
    // cascade rolls back, an RLS miss matches nothing): answering 200 then
    // left the client believing the record was gone while every list still
    // showed it.
    if (!(await storage.deleteEvent(req.params.id))) {
      return res.status(500).json({ error: "Event could not be deleted. Nothing was removed — please try again." });
    }
    const uid_ev3 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`events:${uid_ev3}`); bustCache(`stats:${uid_ev3}`); bustCache(`calendar:${uid_ev3}`);
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
      const calUserId = cacheUserKey(req as AuthenticatedRequest, "caltimeline:");
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
    // Full-by-default, like paginateFull below: the bootstrap seeds the whole
    // document list into the client cache, so a 100-row default page here made
    // the Documents tab shrink on its first refetch. An explicit ?limit=/?offset=
    // still pages.
    const hasDocPager = typeof req.query.limit === "string" || typeof req.query.offset === "string";
    const limit = hasDocPager ? Math.min(Math.max(parseInt(req.query.limit as string) || 100, 1), 500) : undefined;
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
      // The storage widens the ids with the owner chain and co-ownership
      // (SupabaseStorage.pushdownIds) so this agrees with filterByProfileScope.
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
    res.json(paginateFull(items, req, res));
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
    if (req.body.extractedData && typeof req.body.extractedData === "object") {
      const impossible = impossibleCalendarDays(req.body.extractedData, { contextKey: String(req.body.type ?? "") });
      if (impossible.length > 0) return res.status(400).json({ error: `${impossible.join(", ")} must be a real calendar day (YYYY-MM-DD)` });
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
      // Profile isolation (PROP-005): the active scope is the owner the caller
      // can see, so it is applied BEFORE the AI guess below — the guess only
      // runs for a document nobody has claimed.
      applyActiveProfileScope(req, req.body);
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
      bustCache(`documents:${uid_d1}`); bustCache(`stats:${uid_d1}`); bustCache(`profile-detail:${uid_d1}:`); bustCache(`notifications:${uid_d1}`);
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
      // A day-shaped value that is not a day ("2026-02-30") passes the
      // normalizer untouched and used to be stored as given.
      const impossible = impossibleCalendarDays(req.body.extractedData, { contextKey: String(req.body.type ?? "") });
      if (impossible.length > 0) return res.status(400).json({ error: `${impossible.join(", ")} must be a real calendar day (YYYY-MM-DD)` });
    }
    const updated = await storage.updateDocument(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: "Not found" });
    const uid_d2 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`documents:${uid_d2}`); bustCache(`stats:${uid_d2}`); bustCache(`profile-detail:${uid_d2}:`); bustCache(`notifications:${uid_d2}`);
    // A document's dates are calendar items, so an edit to them is a calendar
    // change too.
    bustCache(`caltimeline:${uid_d2}`); bustCache(`activity:${uid_d2}`);
    res.json(updated);
  }));
  // Impact preview for the delete confirmation: what this document contributed
  // and what each mode would take with it. Read-only — nothing is deleted here.
  app.get("/api/documents/:id/delete-impact", asyncHandler(async (req, res) => {
    const impact = await computeDocumentDeletionImpact(storage as any, req.params.id);
    if (!impact) return res.status(404).json({ error: "Not found" });
    res.json(impact);
  }));
  app.delete("/api/documents/:id", asyncHandler(async (req, res) => {
    // Idempotent: soft-delete succeeds even if already deleted.
    //
    // The whole cascade — provenance-aware field removal, derived events,
    // profile back-references, the file itself, the cached AI summaries that
    // quote it — lives in server/document-deletion.ts, so this route, the AI's
    // manage_document tool and an undo all delete a document the same way. See
    // that module for why each step is there.
    //
    // `?mode=document-only` keeps the extracted data and removes only the
    // document and every reference to it; the default takes the derived data
    // too. The client asks the user which, showing the counts from
    // /delete-impact.
    const docIdToDelete = req.params.id;
    // The cascade runs under this user's storage and reports "done" when it
    // finds nothing to remove, so another user's document id (or a missing
    // one) answered 200 while the owner's document stayed put.
    const owned = (await storage.getDocumentMeta(docIdToDelete)) || (await storage.getDocument(docIdToDelete));
    if (!owned) return res.status(404).json({ error: "Not found" });
    const mode = parseDeletionMode(req.query.mode);
    const outcome = await deleteDocumentEverywhere(storage as any, docIdToDelete, mode, log);
    const uid_d3 = cacheUserKey(req as AuthenticatedRequest);
    // A document carries dates, so deleting one changes the calendar, the
    // upcoming feed and the Important Dates list — not just the document list.
    // Omitting the calendar bust here is why a deleted licence's expiration
    // outlived it on screen.
    bustCache(`documents:${uid_d3}`); bustCache(`stats:${uid_d3}`); bustCache(`profile-detail:${uid_d3}:`); bustCache(`notifications:${uid_d3}`);
    bustCache(`profiles:${uid_d3}`); bustCache(`events:${uid_d3}`); bustCache(`caltimeline:${uid_d3}`); bustCache(`activity:${uid_d3}`);
    res.json({ success: true, ...outcome });
  }));
  // Un-delete a soft-deleted document: the row comes back with its bytes and
  // owners (the delete keeps both now — the old delete destroyed the blob, so
  // "restore" produced a file that wouldn't open).
  app.post("/api/documents/:id/restore", asyncHandler(async (req, res) => {
    const ok = await storage.restoreDocument(req.params.id);
    if (!ok) return res.status(404).json({ error: "Document not found" });
    const uid_dr = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`documents:${uid_dr}`); bustCache(`stats:${uid_dr}`); bustCache(`profile-detail:${uid_dr}:`); bustCache(`profiles:${uid_dr}`);
    res.json({ success: true });
  }));
  // Destroy a document's bytes and row, permanently — the ONLY route that
  // does. A live document gets the full cascade first so nothing derived is
  // left pointing at a record that no longer exists.
  app.post("/api/documents/:id/purge", asyncHandler(async (req, res) => {
    const meta = await storage.getDocumentMeta(req.params.id).catch(() => undefined);
    if (meta) {
      await deleteDocumentEverywhere(storage as any, req.params.id, parseDeletionMode(req.query.mode), log);
    }
    const ok = await storage.purgeDocument(req.params.id);
    if (!ok) return res.status(404).json({ error: "Document not found" });
    const uid_dp = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`documents:${uid_dp}`); bustCache(`stats:${uid_dp}`); bustCache(`profile-detail:${uid_dp}:`); bustCache(`notifications:${uid_dp}`);
    res.json({ success: true, purged: true });
  }));
  // ---- Repair: events whose source document is gone ----
  // One-off cleanup for orphans created before the delete cascade existed.
  // Dry run by default — pass ?apply=true to actually remove them. Uses the
  // same isDocumentDerivedEvent rule the cascade does, so this can never take
  // something a live delete would have left alone.
  app.post("/api/documents/repair-orphaned-events", asyncHandler(async (req, res) => {
    const apply = req.query.apply === "true";
    const result = await repairOrphanedDocumentEvents(storage as any, { dryRun: !apply }, log);
    if (result.removed > 0) {
      const uidO = cacheUserKey(req as AuthenticatedRequest);
      bustCache(`events:${uidO}`); bustCache(`caltimeline:${uidO}`); bustCache(`stats:${uidO}`);
      bustCache(`notifications:${uidO}`); bustCache(`activity:${uidO}`); bustCache(`profile-detail:${uidO}:`);
    }
    res.json(result);
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
    bustCache(`documents:${uidR}`); bustCache(`stats:${uidR}`); bustCache(`profile-detail:${uidR}:`);
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
    bustCache(`documents:${uidR}`); bustCache(`stats:${uidR}`); bustCache(`profile-detail:${uidR}:`);
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
    if (typeof to !== "string" || to.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())) {
      return res.status(400).json({ error: "Valid email required" });
    }
    if (subject !== undefined && subject !== null && (typeof subject !== "string" || subject.length > 200)) {
      return res.status(400).json({ error: "Subject must be 200 characters or fewer" });
    }
    if (message !== undefined && message !== null && (typeof message !== "string" || message.length > 2000)) {
      return res.status(400).json({ error: "Message must be 2000 characters or fewer" });
    }

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
      to: [to.trim()],
      subject: subject || `${doc.name} — shared from Portol`,
      // Everything user- or document-supplied is escaped: the body used to
      // interpolate the free-form message raw, which made this an authenticated
      // HTML-injection relay from a Portol-branded sender.
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <div style="margin-bottom:20px">
          <img src="https://portol.me/portol-logo-sm.png" alt="Portol" height="28" />
        </div>
        <h2 style="color:#1a1a1a;margin:0 0 8px">${htmlEscape(doc.name)}</h2>
        <p style="color:#666;font-size:13px;margin:0 0 16px">Type: ${htmlEscape(doc.type || doc.mimeType || 'document')}</p>
        ${message ? `<p style="color:#444;font-size:14px;background:#f5f5f5;padding:12px;border-radius:6px">${htmlEscape(message).replace(/\r?\n/g, '<br />')}</p>` : ''}
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
    const uid = cacheUserKey(req as AuthenticatedRequest, "habits:");
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
    res.json(paginateFull(items, req, res));
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
    applyActiveProfileScope(req, req.body);
    // The owner goes in WITH the insert. Creating first (auto-linked to self)
    // and re-linking afterwards inserted every habit as the user's own for an
    // instant — and under the owner-scoped unique name key that instant is
    // exactly where a child's "Floss" collided with the parent's.
    const linkedProfiles = Array.isArray(req.body.linkedProfiles)
      ? (req.body.linkedProfiles as any[]).filter((x) => typeof x === "string" && x.length > 0)
      : [];
    let newHabit: Awaited<ReturnType<typeof storage.createHabit>>;
    try {
      newHabit = await storage.createHabit({ ...parsed.data, ...(linkedProfiles.length > 0 ? { linkedProfiles } : {}) } as any);
    } catch (e: any) {
      if (isUniqueViolation(e)) {
        return res.status(409).json({ error: `A habit named "${parsed.data.name}" already exists for that profile.`, code: "DUPLICATE_HABIT" });
      }
      throw e;
    }
    const uid_h3 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`habits:${uid_h3}`); bustCache(`stats:${uid_h3}`); bustCache(`notifications:${uid_h3}`);
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
    if (!result.ok && result.reason === "in_future") return res.status(400).json({ error: `Cannot check in for ${result.date}: that day has not happened yet` });
    const updatedHabit = result.habit || await storage.getHabit(req.params.id);
    if (!updatedHabit) return res.status(404).json({ error: "Habit not found" });
    const uid_h1 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`habits:${uid_h1}`); bustCache(`stats:${uid_h1}`); bustCache(`notifications:${uid_h1}`);
    // The mirrored entry changes tracker reads too — without this the Trackers
    // page serves a cached list that predates the check-in.
    bustCache(`trackers:${uid_h1}`);
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
    // The inverse pipeline: removes the check-in AND its mirrored tracker
    // entry. The raw deleteHabitCheckin left the mirror behind, so the tracker
    // chart (and medication adherence) kept counting the un-taken dose.
    const result = await uncompleteHabitOccurrence(storage, {
      habitId: req.params.id, checkinId: req.params.checkinId,
      source: "habit_ui", timezone: getTimezone(req),
    }, log);
    if (!result.ok) return res.status(404).json({ error: result.reason === "not_found" ? "Habit not found" : "Checkin not found" });
    const uid_h2 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`habits:${uid_h2}`); bustCache(`stats:${uid_h2}`); bustCache(`notifications:${uid_h2}`);
    res.json({ success: true, removedCheckinId: result.removedCheckinId, removedTrackerEntryIds: result.removedTrackerEntryIds, progress: result.progress });
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
      bustCache(`habits:${uid_h4}`); bustCache(`stats:${uid_h4}`);
      res.json(result);
    } catch (e: any) {
      // A typed refusal (a 409 version conflict, a 400 from the storage) is
      // the answer, not a server fault: let the handler map it.
      if (Number(e?.statusCode) >= 400 && Number(e?.statusCode) < 500) throw e;
      console.error("[habits]", e?.message || e); res.status(500).json({ error: "Failed to update habit" });
    }
  }));
  app.delete("/api/habits/:id", asyncHandler(async (req, res) => {
    const existing = await storage.getHabit(req.params.id);
    if (!existing) return res.status(404).json({ error: "Habit not found" });
    // A storage delete that returns false did NOT remove the row (a failed
    // cascade rolls back, an RLS miss matches nothing): answering 200 then
    // left the client believing the record was gone while every list still
    // showed it.
    if (!(await storage.deleteHabit(req.params.id))) {
      return res.status(500).json({ error: "Habit could not be deleted. Nothing was removed — please try again." });
    }
    const uid_h5 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`habits:${uid_h5}`); bustCache(`stats:${uid_h5}`);
    res.json({ success: true });
  }));
  app.patch("/api/habits/:id/restore", asyncHandler(async (req, res) => {
    const ok = await storage.restoreHabit(req.params.id);
    if (!ok) return res.status(404).json({ error: "Habit not found" });
    const uid_h6 = cacheUserKey(req as AuthenticatedRequest);
    // Bug fix: missing `enhanced:` bust meant a restored habit could remain
    // missing from the dashboard until the 15-second cache expired.
    bustCache(`habits:${uid_h6}`); bustCache(`stats:${uid_h6}`);
    const habit = await storage.getHabit(req.params.id);
    res.json(habit || { id: req.params.id, restored: true });
  }));

  // ---- Obligations ----
  app.get("/api/obligations", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest, "obligations:");
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
    res.json(paginateFull(items, req, res));
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
  // `inflight` is the FIRST request's create, registered before it is awaited:
  // two identical creates that arrive together used to both miss the map (it
  // was only written after the insert finished) and both insert.
  const recentObligationCreates = new Map<string, { at: number; id?: string; inflight?: Promise<any> }>();
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
      const priorId = prior.id ?? (await prior.inflight?.catch(() => undefined))?.id;
      // Re-fetch so the response shape matches a fresh insert.
      const existing = priorId ? await storage.getObligation(priorId) : undefined;
      if (existing) {
        return res.status(200).json({ ...existing, deduped: true });
      }
    }
    const inflight = storage.createObligation(parsed.data);
    recentObligationCreates.set(fp, { at: Date.now(), inflight });
    let created: Awaited<typeof inflight>;
    try {
      created = await inflight;
    } catch (e) {
      recentObligationCreates.delete(fp);
      throw e;
    }
    recentObligationCreates.set(fp, { at: Date.now(), id: created.id });
    if (recentObligationCreates.size > 500) {
      const cutoff = Date.now() - 30000;
      for (const [k, v] of recentObligationCreates) if (v.at < cutoff) recentObligationCreates.delete(k);
    }
    bustCache(`obligations:${uid_o1}`); bustCache(`stats:${uid_o1}`); bustCache(`cashflow:${uid_o1}`); bustCache(`calendar:${uid_o1}`); bustCache(`notifications:${uid_o1}`);
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
    // A client that round-trips the record sends back whatever status it was
    // shown; lifecycle words ("upcoming", "overdue") mean the bill is active.
    if (typeof req.body?.status === "string") {
      req.body.status = canonicalObligationStatus(req.body.status);
    }
    {
      const parsed = insertObligationSchema.partial().safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: `Validation failed: ${JSON.stringify(parsed.error.flatten())}` });
      req.body = withoutUndefined({ ...req.body, ...parsed.data });
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
    bustCache(`obligations:${uid_o2}`); bustCache(`stats:${uid_o2}`); bustCache(`cashflow:${uid_o2}`); bustCache(`calendar:${uid_o2}`); bustCache(`notifications:${uid_o2}`);
    res.json(updated);
  }));
  // In-memory dedupe to absorb rapid double/triple-click of the "Mark Paid"
  // button on flaky connections (the previous implementation let users create
  // 3 duplicate payments by tapping when the UI didn't update fast enough).
  // Key = userId:obligationId; cleared after 8s.
  // Value is the payment the first request recorded, so a deduped retry can
  // answer with the real row instead of a bare acknowledgement.
  const recentPayments = new Map<string, { at: number; payment: any; inflight?: Promise<any> }>();
  app.post("/api/obligations/:id/pay", asyncHandler(async (req, res) => {
    let { amount, method, confirmationNumber, date, accountId } = req.body;
    if (accountId !== undefined && accountId !== null && typeof accountId !== "string") {
      return res.status(400).json({ error: "accountId must be a string" });
    }
    if (amount !== undefined && (typeof amount !== "number" || amount <= 0)) {
      return res.status(400).json({ error: "Payment amount must be a positive number" });
    }
    // Validate date if provided
    if (date && !isCalendarDay(date)) {
      return res.status(400).json({ error: "Date must be YYYY-MM-DD format" });
    }
    const uid_o3 = cacheUserKey(req as AuthenticatedRequest);
    // This route is the bills surface — loans/cards have their own payment
    // form. payBillOccurrence itself accepts any liability, so keep the guard.
    const ob = await storage.getObligation(req.params.id);
    if (!ob) return res.status(404).json({ error: "Obligation not found" });
    // Same-instance duplicate within 8 s: share the FIRST request's outcome.
    // Previously a duplicate that arrived while the first was still in flight
    // got `{ok:true,deduped:true}` with no row (the UI had nothing to render).
    // Awaiting the in-flight promise answers both taps with the same payment.
    // Cross-instance duplicates are handled inside payBillOccurrence.
    // Keyed on WHAT is being paid as well as who and which bill: a second
    // tap with the same payload is the duplicate; a different amount (or a
    // named occurrence) seconds later is a second payment and must reach
    // the pay operation.
    const dedupeKey = `${uid_o3}:${req.params.id}:${amount ?? "due"}:${req.body?.occurrenceDate ?? ""}`;
    const last = recentPayments.get(dedupeKey);
    if (last && Date.now() - last.at < 8000) {
      const prior = last.payment ?? (last.inflight ? await last.inflight.catch(() => null) : null);
      if (prior && typeof prior === "object") return res.status(200).json({ ...(prior as object), deduped: true });
      // The first tap produced NO payment — it threw, or the pay operation
      // refused. There is nothing to share, so this retry is the real attempt.
      // It used to be answered `{ok:true, deduped:true}` with no row behind
      // it, which is how a failed payment looked paid for eight seconds.
      if (recentPayments.get(dedupeKey) === last) recentPayments.delete(dedupeKey);
    }
    // Clean old entries occasionally to bound memory
    if (recentPayments.size > 500) {
      const cutoff = Date.now() - 30000;
      for (const [k, v] of recentPayments) if (v.at < cutoff) recentPayments.delete(k);
    }
    // The one pay operation. Leaving `amount` undefined lets it settle the
    // occurrence's REAL total (base + charges / posted actual); `date` is the
    // payment date the caller chose — previously validated and then silently
    // dropped on the floor.
    let failReason: string | undefined;
    const inflight = (async () => {
      const result = await payBillOccurrence(storage, req.params.id, {
        amount: amount ?? null,
        paymentDate: date || null,
        // Pay-from-account: the occurrence route honoured accountId, this one
        // silently dropped it, so the source account's balance never moved.
        accountId: accountId || null,
        method,
        confirmationNumber,
        source: "route",
      }, getTimezone(req));
      if (!result.ok) { failReason = result.reason; return null; }
      // Same response shape payObligation produced, so existing callers keep working.
      return {
        id: result.payment?.id, amount: result.amount,
        date: result.payment?.paymentDate, method, confirmationNumber,
        // True when another request settled this occurrence first — the row
        // above is THAT payment, so the caller renders one payment, not two.
        ...(result.deduped ? { deduped: true } : {}),
      };
    })();
    recentPayments.set(dedupeKey, { at: Date.now(), payment: null, inflight });
    let payment: any = null;
    try {
      payment = await inflight;
    } finally {
      // The window entry only ever holds a REAL payment: release it on every
      // other outcome — a throw included — so a retry pays for real.
      if (!payment && recentPayments.get(dedupeKey)?.inflight === inflight) recentPayments.delete(dedupeKey);
    }
    if (!payment) {
      // A ledger failure is a server error, not a missing bill.
      if (failReason === "payment_failed") return res.status(500).json({ error: "Payment failed" });
      return res.status(404).json({ error: "Obligation not found" });
    }
    recentPayments.set(dedupeKey, { at: Date.now(), payment });
    bustCache(`obligations:${uid_o3}`); bustCache(`stats:${uid_o3}`); bustCache(`cashflow:${uid_o3}`); bustCache(`expenses:${uid_o3}`); bustCache(`calendar:${uid_o3}`); bustCache(`notifications:${uid_o3}`);
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
    // The full inverse: payment row deleted, occurrence stamp cleared, due date
    // rolled back, account credited, logged expense retracted. This used to be
    // a raw supabase row delete that reached around the storage proxy — no
    // write journal, no reversal of anything the pay wrote.
    const result = await unpayBillOccurrence(storage, req.params.id, { source: "route" }, getTimezone(req));
    if (!result.ok) {
      return res.status(404).json({ error: result.reason === "no_payment" ? "No payments to undo" : "Obligation not found" });
    }
    // Also clear the dedupe entry so the user can immediately re-pay.
    recentPayments.delete(`${uid}:${req.params.id}`);
    bustCache(`obligations:${uid}`); bustCache(`stats:${uid}`); bustCache(`cashflow:${uid}`); bustCache(`expenses:${uid}`); bustCache(`calendar:${uid}`); bustCache(`notifications:${uid}`);
    res.json({ success: true, deletedPaymentId: result.deletedPaymentId });
  }));

  app.delete("/api/obligations/:id", asyncHandler(async (req, res) => {
    const existing = await storage.getObligation(req.params.id);
    if (!existing) return res.status(404).json({ error: "Obligation not found" });
    // A storage delete that returns false did NOT remove the row (a failed
    // cascade rolls back, an RLS miss matches nothing): answering 200 then
    // left the client believing the record was gone while every list still
    // showed it.
    if (!(await storage.deleteObligation(req.params.id))) {
      return res.status(500).json({ error: "Obligation could not be deleted. Nothing was removed — please try again." });
    }
    const uid_o4 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`obligations:${uid_o4}`); bustCache(`stats:${uid_o4}`); bustCache(`cashflow:${uid_o4}`); bustCache(`calendar:${uid_o4}`); bustCache(`notifications:${uid_o4}`);
    res.json({ success: true });
  }));

  // ─── Obligation Occurrences (Wave 16) ────────────────────────────────────
  // Per-instance status tracking so a single recurring obligation can have
  // some occurrences marked done, some skipped, some rescheduled, etc.
  // These power the new dashboard "Due today / Overdue / Upcoming" cards
  // and the calendar chips.
  // Bust every finance/calendar surface after a bill or occurrence changes, so
  // dashboard, cash flow, budget, notifications and the calendar all resync.
  const bustBillCaches = (uid: string) => {
    bustCache(`obligations:${uid}`); bustCache(`stats:${uid}`);
    bustCache(`cashflow:${uid}`); bustCache(`expenses:${uid}`); bustCache(`calendar:${uid}`);
    bustCache(`notifications:${uid}`); bustCache(`profile-detail:${uid}:`);
  };
  // Split a synthetic occurrenceId "<liabilityId>:<YYYY-MM-DD>" (UUIDs/dates
  // carry no colon, so the single colon is unambiguous).
  const parseOccId = (occId: string): { liabilityId: string; date: string } | null => {
    const i = String(occId || "").indexOf(":");
    if (i < 0) return null;
    const liabilityId = occId.slice(0, i);
    const date = occId.slice(i + 1).slice(0, 10);
    if (!liabilityId || !isCalendarDay(date)) return null;
    return { liabilityId, date };
  };

  // Generated occurrences across every recurring bill in a window (no occurrence
  // table). Used by the legacy occurrence panels; the live calendar reads
  // /api/calendar-timeline which emits the same occurrences.
  app.get("/api/obligation-occurrences", asyncHandler(async (req, res) => {
    const tz = getTimezone(req);
    const today = getUserToday(tz);
    const start = (req.query.start as string) && isCalendarDay(req.query.start as string)
      ? (req.query.start as string) : today;
    const end = (req.query.end as string) && isCalendarDay(req.query.end as string)
      ? (req.query.end as string) : toLocalDateStr(new Date(Date.now() + 90 * 86400000), tz);
    const profileIdsParam = req.query.profileIds as string | undefined;
    const fp = req.query.profileId as string | undefined;
    const ids = profileIdsParam ? profileIdsParam.split(",").filter(Boolean) : (fp ? [fp] : null);
    const profiles = await storage.getProfiles();
    const obligations = await storage.getObligations();
    const payByLiab = new Map<string, any[]>();
    for (const ob of obligations) payByLiab.set(ob.id, (ob.payments || []).map((p: any) => ({ paymentDate: p.date, id: p.id })));
    // Scope with the same rule as the scoped bills list (owner chain and
    // co-ownership included — D120/D133); the raw "immediate parent is in
    // the selection" test hid a co-owned car's bill from the calendar.
    const allowedBillIds = ids && ids.length > 0 ? new Set((await storage.getObligations(ids)).map((o: any) => o.id)) : null;
    const selfId = profiles.find(p => p.type === "self")?.id;
    const items: any[] = [];
    for (const p of profiles as any[]) {
      if (!isRecurringBillType(p.type_key ?? p.typeKey)) continue;
      if (allowedBillIds && !allowedBillIds.has(p.id)) continue;
      const owner = p.parentProfileId || selfId;
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
    if (!(await storage.getObligation(req.params.id))) return res.status(404).json({ error: "Obligation not found" });
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
    if (status === "done") {
      const paid = await payBillOccurrence(storage, parsed.liabilityId, {
        occurrenceDate: parsed.date, amount: actualAmount ?? null, method, source: "shim",
      }, getTimezone(req));
      result = paid.ok ? await storage.getLiabilitySchedule(parsed.liabilityId) : null;
    } else if (status === "skipped") {
      result = await storage.skipOccurrence(parsed.liabilityId, parsed.date);
    } else {
      result = await storage.getLiabilitySchedule(parsed.liabilityId); // pending/late = no-op read
    }
    if (!result) return res.status(404).json({ error: "Bill not found" });
    bustBillCaches(uid);
    res.json(result);
  }));

  app.post("/api/obligation-occurrences/:occId/reschedule", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const { newDueAt } = req.body || {};
    if (!isCalendarDay(String(newDueAt || ""))) return res.status(400).json({ error: "newDueAt must be YYYY-MM-DD" });
    const parsed = parseOccId(req.params.occId);
    if (!parsed) return res.status(400).json({ error: "Unrecognized occurrence id" });
    const result = await storage.rescheduleOccurrence(parsed.liabilityId, parsed.date, newDueAt);
    if (!result) return res.status(404).json({ error: "Bill not found" });
    bustBillCaches(uid);
    res.json(result);
  }));

  // ---- Recurring-liability schedule & per-occurrence operations ----
  app.get("/api/liabilities/:id/schedule", asyncHandler(async (req, res) => {
    const months = Math.min(36, Math.max(1, Number(req.query.months) || 12));
    const result = await storage.getLiabilitySchedule(req.params.id, months);
    if (!result) return res.status(404).json({ error: "Recurring liability not found" });
    res.json(result);
  }));

  app.post("/api/liabilities/:id/occurrences/:date/pay", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    if (!isCalendarDay(req.params.date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    const { amount, method, paymentDate, accountId } = req.body || {};
    if (amount !== undefined && (typeof amount !== "number" || amount < 0)) return res.status(400).json({ error: "amount must be a non-negative number" });
    const paid = await payBillOccurrence(storage, req.params.id, {
      occurrenceDate: req.params.date, amount: amount ?? null,
      method, paymentDate, accountId, source: "occurrence_route",
    }, getTimezone(req));
    if (!paid.ok) return res.status(404).json({ error: "Recurring liability not found" });
    const result = await storage.getLiabilitySchedule(req.params.id);
    bustBillCaches(uid);
    res.json(result);
  }));

  app.post("/api/liabilities/:id/occurrences/:date/skip", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    if (!isCalendarDay(req.params.date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    const result = await storage.skipOccurrence(req.params.id, req.params.date);
    if (!result) return res.status(404).json({ error: "Recurring liability not found" });
    bustBillCaches(uid);
    res.json(result);
  }));

  app.patch("/api/liabilities/:id/occurrences/:date", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    if (!isCalendarDay(req.params.date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    const { movedTo, amount, notes, estimatedAmount, actualAmount } = req.body || {};
    let result;
    if (movedTo !== undefined) {
      if (!isCalendarDay(String(movedTo))) return res.status(400).json({ error: "movedTo must be YYYY-MM-DD" });
      result = await storage.rescheduleOccurrence(req.params.id, req.params.date, movedTo);
    }
    if (amount !== undefined || notes !== undefined) {
      result = await storage.setOccurrenceFields(req.params.id, req.params.date, { amount, notes });
    }
    // Estimated vs actual are separate, on purpose. Writing the estimate must
    // never masquerade as the bill having posted, and writing the actual must
    // freeze the period rather than nudge a forecast.
    if (estimatedAmount !== undefined) {
      const n = estimatedAmount === null ? null : Number(estimatedAmount);
      if (n !== null && (!Number.isFinite(n) || n < 0)) return res.status(400).json({ error: "estimatedAmount must be a non-negative number or null" });
      result = await storage.setOccurrenceEstimate(req.params.id, req.params.date, n);
    }
    if (actualAmount !== undefined) {
      const n = actualAmount === null ? null : Number(actualAmount);
      if (n !== null && (!Number.isFinite(n) || n < 0)) return res.status(400).json({ error: "actualAmount must be a non-negative number or null" });
      result = await storage.setOccurrenceActual(req.params.id, req.params.date, n);
    }
    if (!result) return res.status(404).json({ error: "Recurring liability not found (or nothing to change)" });
    bustBillCaches(uid);
    res.json(result);
  }));

  // ---- Usage / credits / fee charges on ONE billing period ----
  // The charge lands on the occurrence for that period and nowhere else, which
  // is what keeps "another $30 of credits this month" from rewriting last
  // month's bill or inflating next month's estimate.
  app.post("/api/liabilities/:id/occurrences/:date/charges", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    if (!isCalendarDay(req.params.date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    const { amount, kind, label, date, notes } = req.body || {};
    const n = Number(amount);
    if (!Number.isFinite(n) || n === 0) return res.status(400).json({ error: "amount must be a non-zero number" });
    const result = await storage.addOccurrenceCharge(req.params.id, req.params.date, {
      amount: n, kind, label, date, notes, source: "user",
    });
    if (!result) return res.status(404).json({ error: "Liability not found" });
    bustBillCaches(uid);
    res.json(result);
  }));

  app.delete("/api/liabilities/:id/occurrences/:date/charges/:chargeId", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    if (!isCalendarDay(req.params.date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    const result = await storage.removeOccurrenceCharge(req.params.id, req.params.date, req.params.chargeId);
    if (!result) return res.status(404).json({ error: "Liability not found" });
    bustBillCaches(uid);
    res.json(result);
  }));

  app.post("/api/liabilities/:id/pause", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const { until } = req.body || {};
    if (until !== undefined && until !== null && !isCalendarDay(String(until))) return res.status(400).json({ error: "until must be YYYY-MM-DD" });
    const result = await storage.pauseLiability(req.params.id, until || undefined);
    if (!result) return res.status(404).json({ error: "Recurring liability not found" });
    bustBillCaches(uid);
    res.json(result);
  }));

  app.post("/api/liabilities/:id/resume", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const result = await storage.resumeLiability(req.params.id);
    if (!result) return res.status(404).json({ error: "Recurring liability not found" });
    bustBillCaches(uid);
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
    // `String({x:1})` is "[object Object]", which is what four accounts were
    // named after a probe posted an object: the name must BE a string. The
    // money check also normalises "1,000" in place, so it runs before the
    // fields are read out.
    const textError = validateAccountTextFields(req.body);
    if (textError) return res.status(400).json({ error: textError });
    const moneyError = validateProfileMoneyFields(req.body);
    if (moneyError) return res.status(400).json({ error: moneyError });
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
    bustBillCaches(uid);
    res.status(201).json(created);
  }));

  app.patch("/api/accounts/:id", asyncHandler(async (req, res) => {
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const body = (req.body && typeof req.body === "object" && !Array.isArray(req.body)) ? req.body : {};
    {
      const textError = validateAccountTextFields(body);
      if (textError) return res.status(400).json({ error: textError });
      if (body.name !== undefined && !String(body.name).trim()) return res.status(400).json({ error: "name cannot be empty" });
      const moneyError = validateProfileMoneyFields(body);
      if (moneyError) return res.status(400).json({ error: moneyError });
    }
    // `ownerProfileId` IS the account's parent (storage writes it to
    // parentProfileId), so it gets exactly the guards a profile's parent gets.
    // An empty value clears the owner and needs none of them.
    if (body.ownerProfileId !== undefined && body.ownerProfileId !== null && body.ownerProfileId !== "") {
      if (typeof body.ownerProfileId !== "string") return res.status(400).json({ error: "ownerProfileId must be a profile id" });
      const existing = await storage.getProfile(req.params.id);
      if (!existing || !isAccountProfile(existing)) return res.status(404).json({ error: "Account not found" });
      const problem = await checkParentAssignment(uid, req.params.id, body.ownerProfileId);
      if (problem) return res.status(problem.status).json({ error: problem.error });
    }
    const updated = await (storage as any).updateAccount(req.params.id, body);
    if (!updated) return res.status(404).json({ error: "Account not found" });
    bustBillCaches(uid);
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
    bustBillCaches(uid);
    res.json({ success: true });
  }));

  // A balance CHANGE is an event with a reason, not a field overwrite: the
  // before/after pair is kept so "why is this $40 lower" stays answerable.
  app.post("/api/accounts/:id/adjust", asyncHandler(async (req, res) => {
    if (req.body?.date !== undefined && req.body?.date !== null && req.body?.date !== "" && !isCalendarDay(String(req.body.date))) {
      return res.status(400).json({ error: "date must be a real calendar day (YYYY-MM-DD)" });
    }
    const uid = cacheUserKey(req as AuthenticatedRequest);
    const { newBalance, delta, date, reason } = req.body || {};
    if (newBalance == null && delta == null) {
      return res.status(400).json({ error: "Pass newBalance (set to) or delta (move by)" });
    }
    if (newBalance != null && !Number.isFinite(Number(newBalance))) return res.status(400).json({ error: "newBalance must be a number" });
    if (delta != null && !Number.isFinite(Number(delta))) return res.status(400).json({ error: "delta must be a number" });
    const updated = await storage.adjustAccountBalance(req.params.id, {
      newBalance, delta, date, reason, source: "user",
    });
    if (!updated) return res.status(404).json({ error: "Account not found" });
    bustBillCaches(uid);
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
    res.json(paginateFull(items, req, res));
  }));
  app.get("/api/artifacts/:id", asyncHandler(async (req, res) => {
    const artifact = await storage.getArtifact(req.params.id);
    if (!artifact) return res.status(404).json({ error: "Not found" });
    res.json(artifact);
  }));
  app.post("/api/artifacts", asyncHandler(async (req, res) => {
    if (req.body.title) req.body.title = sanitize(req.body.title);
    applyActiveProfileScope(req, req.body);
    const parsed = insertArtifactSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation failed", issues: parsed.error.issues });
    const created = await storage.createArtifact(parsed.data);
    const uid_a1 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`artifacts:${uid_a1}`); bustCache(`stats:${uid_a1}`);
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
    bustCache(`artifacts:${uid_a2}`); bustCache(`stats:${uid_a2}`);
    res.json(updated);
  }));
  app.post("/api/artifacts/:id/toggle/:itemId", asyncHandler(async (req, res) => {
    const result = await storage.toggleChecklistItem(req.params.id, req.params.itemId);
    if (!result) return res.status(404).json({ error: "Not found" });
    const uid_a3 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`artifacts:${uid_a3}`); bustCache(`stats:${uid_a3}`);
    res.json(result);
  }));
  app.delete("/api/artifacts/:id", asyncHandler(async (req, res) => {
    const existing = await storage.getArtifact(req.params.id);
    if (!existing) return res.status(404).json({ error: "Artifact not found" });
    // A storage delete that returns false did NOT remove the row (a failed
    // cascade rolls back, an RLS miss matches nothing): answering 200 then
    // left the client believing the record was gone while every list still
    // showed it.
    if (!(await storage.deleteArtifact(req.params.id))) {
      return res.status(500).json({ error: "Artifact could not be deleted. Nothing was removed — please try again." });
    }
    const uid_a4 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`artifacts:${uid_a4}`); bustCache(`stats:${uid_a4}`);
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
    bustCache(`artifacts:${uid_adup}`); bustCache(`stats:${uid_adup}`);
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
    // Not CDN-cacheable: with `public, max-age=60` Vercel kept serving the
    // page for up to a minute after the owner unshared (or deleted) it —
    // production timing 2026-09-03: HIT right after unshare, 404 only 70 s
    // later. Enumeration is already throttled by the per-IP limit above.
    res.setHeader("Cache-Control", "private, no-store");
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
    const uid = cacheUserKey(req as AuthenticatedRequest, "journal:");
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
        // The canonical rule (orphans are Self's, owner chain, co-ownership)
        // instead of an inline id match that missed a pet's entry under its
        // owner and a co-owned car's under its co-owner.
        items = await filterByProfileScope(items, ids, cacheUserKey(req as AuthenticatedRequest));
      }
    } else if (fp) {
      const allProfiles = await storage.getProfiles();
      const isSelf = allProfiles.find(p => p.id === fp)?.type === "self";
      // Journal entries are personal — only show for self profile
      if (!isSelf) { items = []; }
    }
    res.json(paginateFull(items, req, res));
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
    applyActiveProfileScope(req, req.body);
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
    const uid_j1 = cacheUserKey(req as AuthenticatedRequest);
    bustCache(`stats:${uid_j1}`);
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
    } catch (e: any) {
      if (Number(e?.statusCode) >= 400 && Number(e?.statusCode) < 500) throw e;
      console.error("[memories]", e?.message || e); res.status(500).json({ error: "Failed to update memory" });
    }
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
      const userId = cacheUserKey(req as AuthenticatedRequest, "notifications:");
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
        const [allDocs, allTasks, allObs, allHabits, notifProfiles] = await Promise.all([
          storage.getDocuments(), storage.getTasks(), storage.getObligations(), storage.getHabits(),
          storage.getProfiles(),
        ]);
        const notifCtx = await profileFilterCtx(ids, notifProfiles as any[]);
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
          // Canonical rule (shared/profile-filter.ts): an unlinked item is
          // Self's, so its alerts must not vanish under a Self filter.
          return passesProfileFilter(ent.linkedProfiles, notifCtx);
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
            // People are what the scope switcher and the Info pages are
            // made of: a person you are not currently scoped to must still
            // be findable by name (to open them or switch to them), so
            // self/person/pet rows ignore the scope. Everything else —
            // assets, loans and every linked entity — stays scoped.
            if (r.type === "self" || r.type === "person" || r.type === "pet") return true;
            if (ids.includes(r.id)) return true;
            // Asset/liability profiles surface for any selected co-owner (or for
            // Self when unowned). Other profile types match by id only.
            if (isAssetOrLiability(r.type)) return itemVisibleForSelection(r.id, ids, ownerIndex, selfIds);
            return false;
          }
          return passesProfileFilter(r.linkedProfiles, { selectedIds: ids, allProfiles: allProfiles as any[], assetPartyLinks: assetLinks, liabilityProfileLinks: liabLinks });
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
        incomes, goals, paychecks, budgetsByMonth, assetPartyLinks, liabilityProfileLinks,
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
        // A backup that left these out could not restore a household's money
        // model: incomes, goals, paychecks, budgets and the payment history
        // behind every loan, card and bill were all missing from the file.
        storage.getIncomes(),
        storage.getGoals(),
        storage.getPaychecks().catch(() => [] as any[]),
        storage.getAllBudgets().catch(() => ({} as Record<string, any[]>)),
        // Co-ownership is reference data like profiles: without it a restore
        // gave every asset and loan back to Self alone.
        Promise.resolve(storage.getAssetPartyLinks?.()).then((r) => r || []).catch(() => [] as any[]),
        Promise.resolve(storage.getLiabilityProfileLinks?.()).then((r) => r || []).catch(() => [] as any[]),
      ]);
      const liabilityIds = (profiles as any[]).filter((p) => p.type === "liability").map((p) => p.id);
      let liabilityPayments: any[] = [];
      for (const id of liabilityIds) {
        try { liabilityPayments.push(...(await storage.getLiabilityPayments(id))); } catch { /* per-liability best effort */ }
      }
      // [P6.2] Optional ?profileIds= scoping. Each entity collection goes
      // through the same canonical orphan rule as the list endpoints.
      // Profiles, memories and domains are reference data with no
      // linkedProfiles — always exported in full.
      const profileIdsParam = req.query.profileIds as string | undefined;
      const exportFilterIds = profileIdsParam ? profileIdsParam.split(",").filter(Boolean) : [];
      if (exportFilterIds.length > 0) {
        const uid_ex = cacheUserKey(req as AuthenticatedRequest);
        [trackers, tasks, expenses, events, documents, habits, obligations, artifacts, journalEntries, incomes, goals] =
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
            filterByProfileScope(incomes, exportFilterIds, uid_ex),
            filterByProfileScope(goals, exportFilterIds, uid_ex),
          ]);
        const inScopeLiabilities = new Set((obligations as any[]).map((o) => o.id));
        liabilityPayments = liabilityPayments.filter((p) => inScopeLiabilities.has(p.liabilityProfileId));
        const wanted = new Set(exportFilterIds);
        budgetsByMonth = Object.fromEntries(Object.entries(budgetsByMonth).map(([m, list]) => [m, (list as any[]).filter((b) => !b.profileId || wanted.has(b.profileId))]));
      }
      const data = {
        version: 1,
        exportedAt: new Date().toISOString(),
        scope: exportFilterIds.length > 0 ? "filtered" : "all",
        ...(exportFilterIds.length > 0 ? { filteredProfileIds: exportFilterIds } : {}),
        profiles, trackers, tasks, expenses, events, documents,
        habits, obligations, artifacts, journalEntries, memories, domains,
        incomes, goals, paychecks, budgets: budgetsByMonth, liabilityPayments,
        assetPartyLinks, liabilityProfileLinks,
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
      // Restored rows must point at the profiles THIS account now has, not the
      // ids the file was exported with: a task linked to "Linda" in the old
      // account carried Linda's old id, which is another user's profile (or
      // nobody's) here — the ownership guard rejected the row, or it landed
      // unowned. Every profile created below is mapped old → new, the file's
      // Self maps to this account's own Self (there is exactly one), parents
      // are remapped (parents are created first), and every section's
      // linkedProfiles goes through the map.
      const idMap = new Map<string, string>();
      const remap = (ids: unknown): string[] =>
        (Array.isArray(ids) ? ids : []).map((id) => idMap.get(String(id))).filter((id): id is string => !!id);
      if (data.profiles && Array.isArray(data.profiles)) {
        const existingSelf = await (storage.getSelfProfile?.() ?? Promise.resolve(undefined)).catch(() => undefined);
        const byId = new Map<string, any>((data.profiles as any[]).filter((p) => p && p.id).map((p) => [String(p.id), p]));
        const ordered: any[] = [];
        const seen = new Set<string>();
        const visit = (p: any, depth = 0) => {
          if (!p || depth > 20) return;
          const key = p.id ? String(p.id) : `anon-${ordered.length}`;
          if (seen.has(key)) return;
          const parent = p.parentProfileId ? byId.get(String(p.parentProfileId)) : null;
          if (parent && parent !== p) visit(parent, depth + 1);
          seen.add(key);
          ordered.push(p);
        };
        for (const p of data.profiles) visit(p);
        for (const p of ordered) {
          if (p.type === "self") {
            if (existingSelf && p.id) idMap.set(String(p.id), existingSelf.id);
            continue; // one Self per account: the file's Self is this account's Self
          }
          await tryImport("profiles", p.name || "unnamed", async () => {
            const parentProfileId = p.parentProfileId ? idMap.get(String(p.parentProfileId)) : undefined;
            const created = await storage.createProfile({ type: p.type, name: p.name, fields: p.fields, tags: p.tags, notes: p.notes, ...(parentProfileId ? { parentProfileId } : {}) } as any);
            if (p.id && created?.id) idMap.set(String(p.id), created.id);
          });
        }
      }
      // Import trackers + entries
      // Co-ownership shares, once every profile id is known. One atomic
      // owner write per asset/loan (validated: shares ≤ 100%); a share whose
      // asset or party did not make it into this account is skipped.
      const importOwners = async (
        section: "assetPartyLinks" | "liabilityProfileLinks",
        subjectKey: "assetProfileId" | "liabilityProfileId",
        write: (subjectId: string, owners: Array<{ partyProfileId: string; ownershipPercentage: number }>) => Promise<any>,
      ) => {
        const rows: any[] = Array.isArray(data[section]) ? data[section] : [];
        const bySubject = new Map<string, any[]>();
        for (const l of rows) {
          const subject = l && l[subjectKey] ? idMap.get(String(l[subjectKey])) : undefined;
          const party = l && l.partyProfileId ? idMap.get(String(l.partyProfileId)) : undefined;
          if (!subject || !party) continue;
          const arr = bySubject.get(subject) || [];
          arr.push({ partyProfileId: party, ownershipPercentage: Number(l.ownershipPercentage ?? 100) });
          bySubject.set(subject, arr);
        }
        for (const [subject, owners] of bySubject) {
          await tryImport(section, subject, () => write(subject, owners));
        }
      };
      await importOwners("assetPartyLinks", "assetProfileId", (id, owners) => storage.setAssetOwners(id, owners));
      await importOwners("liabilityProfileLinks", "liabilityProfileId", (id, owners) => storage.setLiabilityOwners(id, owners));
      if (data.trackers && Array.isArray(data.trackers)) {
        for (const t of data.trackers) {
          await tryImport("trackers", t.name || "unnamed", async () => {
            const created = await storage.createTracker({ name: t.name, category: t.category, unit: t.unit, icon: t.icon, fields: t.fields, linkedProfiles: remap(t.linkedProfiles) } as any);
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
          // A backup restores the task as it was: a finished chore came back
          // open (and lost its clock time) because status/dueTime were dropped.
          await tryImport("tasks", t.title || "unnamed", () => storage.createTask({ title: t.title, description: t.description, priority: t.priority, dueDate: t.dueDate, dueTime: t.dueTime || undefined, status: t.status || undefined, completedAt: t.completedAt || undefined, tags: t.tags, linkedProfiles: remap(t.linkedProfiles) } as any));
        }
      }
      // Import expenses
      if (data.expenses && Array.isArray(data.expenses)) {
        for (const e of data.expenses) {
          await tryImport("expenses", e.description || "unnamed", () => storage.createExpense({ amount: e.amount, category: e.category, description: e.description, vendor: e.vendor, date: e.date, tags: e.tags, linkedProfiles: remap(e.linkedProfiles) } as any));
        }
      }
      // Import incomes, goals, paychecks and budgets — the money model the
      // export used to leave out. Liability payments are exported for the
      // record only: their liability ids do not survive a re-import.
      if (data.incomes && Array.isArray(data.incomes)) {
        for (const i of data.incomes) {
          await tryImport("incomes", i.description || "unnamed", () => storage.createIncome({ description: i.description, amount: Number(i.amount), category: i.category || "salary", frequency: i.frequency || "monthly", date: i.date || undefined, tags: i.tags || [], linkedProfiles: remap(i.linkedProfiles) } as any));
        }
      }
      if (data.goals && Array.isArray(data.goals)) {
        for (const g of data.goals) {
          await tryImport("goals", g.title || "unnamed", async () => {
            const created = await storage.createGoal({ title: g.title, type: g.type || "custom", target: Number(g.target), unit: g.unit || "", startValue: g.startValue, deadline: g.deadline || undefined, category: g.category, milestones: g.milestones || [], linkedProfiles: remap(g.linkedProfiles) } as any);
            // createGoal starts every goal at its start value and "active";
            // the backup's progress and a completed status must come back too.
            const patch: Record<string, any> = {};
            if (typeof g.current === "number" && Number.isFinite(g.current) && g.current !== created.current) patch.current = g.current;
            if (typeof g.status === "string" && g.status && g.status !== created.status) patch.status = g.status;
            if (Object.keys(patch).length > 0) await storage.updateGoal(created.id, patch);
            return created;
          });
        }
      }
      if (data.paychecks && Array.isArray(data.paychecks)) {
        for (const p of data.paychecks) {
          await tryImport("paychecks", p.source || "unnamed", () => storage.createPaycheck({ source: p.source, amount: Number(p.amount), expected_date: p.expected_date || p.expectedDate, notes: p.notes }));
        }
      }
      if (data.budgets && typeof data.budgets === "object" && !Array.isArray(data.budgets)) {
        for (const [month, list] of Object.entries(data.budgets as Record<string, any[]>)) {
          if (!/^\d{4}-\d{2}$/.test(month) || !Array.isArray(list)) continue;
          for (const b of list) {
            // A per-person budget keeps its person (remapped); an owner that did
            // not make it into this account leaves the cap account-wide.
            const budgetOwner = b?.profileId ? idMap.get(String(b.profileId)) : undefined;
            await tryImport("budgets", `${month} ${b.category || "unnamed"}`, () => storage.addBudget(month, String(b.category || ""), Number(b.amount), b.notes, budgetOwner));
          }
        }
      }
      // Import events
      if (data.events && Array.isArray(data.events)) {
        for (const e of data.events) {
          // endDate and recurrenceEnd used to be dropped: a multi-day event
          // shrank to one day and a series that had an end became endless.
          await tryImport("events", e.title || "unnamed", () => storage.createEvent({ title: e.title, date: e.date, time: e.time, endTime: e.endTime, endDate: e.endDate || undefined, allDay: e.allDay, description: e.description, location: e.location, category: e.category || "personal", recurrence: e.recurrence || "none", recurrenceEnd: e.recurrenceEnd || undefined, tags: e.tags || [], source: e.source || "manual", linkedProfiles: remap(e.linkedProfiles), linkedDocuments: [] }));
        }
      }
      // Import documents
      if (data.documents && Array.isArray(data.documents)) {
        for (const d of data.documents) {
          await tryImport("documents", d.name || "unnamed", () => storage.createDocument({ name: d.name, type: d.type, mimeType: d.mimeType, fileData: d.fileData, extractedData: d.extractedData, tags: d.tags, linkedProfiles: remap(d.linkedProfiles) } as any));
        }
      }
      // Import habits
      if (data.habits && Array.isArray(data.habits)) {
        for (const h of data.habits) {
          await tryImport("habits", h.name || "unnamed", async () => {
            // The schedule (which days, the window, the time slot) is part of the habit.
            const created = await storage.createHabit({ name: h.name, icon: h.icon, color: h.color, frequency: h.frequency, targetPerDay: h.targetPerDay, targetDays: Array.isArray(h.targetDays) ? h.targetDays : undefined, startDate: h.startDate || undefined, endDate: h.endDate || undefined, timeOfDay: h.timeOfDay || undefined, scheduledTime: h.scheduledTime || undefined, linkedProfiles: remap(h.linkedProfiles) } as any);
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
            const created = await storage.createObligation({ name: o.name, amount: o.amount, frequency: o.frequency, category: o.category, nextDueDate: o.nextDueDate, autopay: o.autopay, notes: o.notes, linkedProfiles: remap(o.linkedProfiles) } as any);
            if (o.payments) {
              for (const p of o.payments) {
                // Restoring HISTORY: raw ledger rows only, deliberately not
                // payBillOccurrence — an import must not advance due dates,
                // debit accounts, or log fresh expenses for old payments.
                await tryImport("obligationPayments", `${o.name} payment`, () => storage.createLiabilityPayment({
                  liabilityProfileId: created.id,
                  paymentDate: String(p.date || p.paymentDate || getUserToday(getTimezone(req))).slice(0, 10),
                  amount: Number(p.amount) || 0,
                  principalPortion: Number(p.amount) || 0,
                  interestPortion: 0,
                  paymentType: "standard",
                  sourceAccount: p.method || null,
                  notes: p.confirmationNumber ? `Confirmation ${p.confirmationNumber}` : null,
                } as any));
              }
            }
          });
        }
      }
      // Import artifacts
      if (data.artifacts && Array.isArray(data.artifacts)) {
        for (const a of data.artifacts) {
          await tryImport("artifacts", a.title || "unnamed", () => storage.createArtifact({ type: a.type, title: a.title, content: a.content, items: a.items?.map((i: any) => ({ text: i.text, checked: i.checked })) || [], tags: a.tags, pinned: a.pinned, linkedProfiles: remap(a.linkedProfiles), language: a.language, dataBindings: a.dataBindings, chartData: a.chartData }));
        }
      }
      // Import journal entries
      // The export writes the entries under `journal`; the import only ever
      // read `journalEntries`, so a restored backup had no journal at all.
      const journalRows = Array.isArray(data.journalEntries) ? data.journalEntries : Array.isArray(data.journal) ? data.journal : null;
      if (journalRows) {
        for (const j of journalRows) {
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
      // Pure parser (server/bank-csv.ts): header mapping, quoted fields, the
      // file's sign convention (negative debits / debit column / positives)
      // and date normalization. Credits are skipped — they are not expenses.
      const parsedCsv = parseBankCsv(csv, getUserToday(getTimezone(req)));
      if ("error" in parsedCsv) return res.status(400).json({ error: parsedCsv.error });

      // Canonical category set — the same vocabulary POST /api/expenses folds
      // to (shared/category-canon), so an import can't introduce a spelling the
      // rest of the app treats as a separate bucket.
      const ALLOWED_CATEGORIES = [...EXPENSE_CATEGORIES];

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
          if (keywords.some(k => lower.includes(k))) return canonicalExpenseCategory(cat);
        }
        return "general";
      };


      let imported = 0;
      let skipped = parsedCsv.skippedEmpty;
      const errors: string[] = [];

      // ── AI BATCH CATEGORIZATION ──────────────────────────────────────────
      // Wave 1 #1: replace per-row keyword matching with a single AI call that
      // categorises ALL rows at once. Falls back to keywordCategory on timeout
      // / error so imports never block. Cheap: ~$0.001 per 50-row CSV.
      const aiCategoryByDesc = new Map<string, string>();
      try {
        const uniqueDescs: string[] = [];
        const seen = new Set<string>();
        for (const r of parsedCsv.rows) {
          const d = r.description.trim().slice(0, 120);
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

      // Re-importing the same statement must not duplicate rows: a row that
      // matches an existing expense on day, cents and text is skipped. Kept as
      // a multiset so two identical legitimate transactions in one file still
      // both import when only one exists already.
      const existingKeys = new Map<string, number>();
      for (const e of await storage.getExpenses()) {
        const k = expenseDedupeKey(e);
        existingKeys.set(k, (existingKeys.get(k) || 0) + 1);
      }
      let duplicates = 0;

      for (const r of parsedCsv.rows) {
        try {
          const description = r.description;
          // Priority: explicit CSV column → AI batch decision → keyword fallback.
          const aiCat = aiCategoryByDesc.get(description.trim().slice(0, 120));
          // Fold through the one vocabulary so a CSV column reading "Utility"
          // lands in the same bucket as the app's "utilities".
          const category = canonicalExpenseCategory(r.category || aiCat || keywordCategory(description));

          const key = expenseDedupeKey({ date: r.date, amount: r.amount, description });
          const seenCount = existingKeys.get(key) || 0;
          if (seenCount > 0) { existingKeys.set(key, seenCount - 1); duplicates++; continue; }

          await storage.createExpense({
            amount: r.amount,
            category,
            description,
            vendor: description.split(/\s{2,}|[-–]/).shift()?.trim().slice(0, 100) || undefined,
            date: r.date,
            tags: ["bank-import"],
          });
          imported++;
        } catch (err: any) {
          errors.push(`Row ${r.row}: ${err.message || "unknown error"}`);
        }
      }

      res.json({
        success: true, imported, skipped, duplicates, skippedCredits: parsedCsv.skippedCredits,
        signConvention: parsedCsv.signConvention, errors: errors.slice(0, 10),
        totalRows: parsedCsv.rows.length + parsedCsv.skippedCredits + parsedCsv.skippedEmpty,
      });
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
      const categoryTotals = spendByCategory(expensesThisWeek);
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

      // Documents with a date to act on — expiring OR due.
      //
      // This block used to carry its own expiry-key regex and `new Date(value)`
      // parsing: yet another date vocabulary, blind to due dates and to every
      // non-ISO value. It reads the ONE Date Rule engine now, so the digest
      // sees exactly what the Executive tab and the calendar see.
      const expiringDocs = rulesFromDocuments(documents)
        .filter((rule) => isDocumentAttentionRule(rule))
        .map((rule) => ({
          name: rule.label,
          type: rule.ruleSubtype || rule.ruleType,
          date: rule.date,
          daysUntil: daysBetweenISO(todayStr, rule.date),
        }))
        .filter((r) => r.daysUntil >= -30 && r.daysUntil <= 60);

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
        // Canonical rule (orphans, owner chain, co-ownership) — the inline id
        // match dropped a co-owned car's rows from the suggestions.
        const sugCtx = await profileFilterCtx(filterIds, profiles as any[]);
        const inProfile = (lp: string[] | undefined | null) => passesProfileFilter(lp, sugCtx);
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
            if (!isCalendarDay(s)) return null;
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
        // Canonical rule (see /api/journal above).
        goals = await filterByProfileScope(goals, ids, cacheUserKey(req as AuthenticatedRequest));
      }
      res.json(paginateFull(goals, req, res));
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
      applyActiveProfileScope(req, req.body);
      const parsed = insertGoalSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid request data" });
      // insertGoalSchema strips linkedProfiles, but both storages read it off
      // the insert (defaulting to self when absent) — so the owner the body
      // named, or the active scope supplied, must be carried past the parse.
      const goalOwners = Array.isArray(req.body.linkedProfiles)
        ? (req.body.linkedProfiles as any[]).filter((x) => typeof x === "string" && x.length > 0)
        : [];
      // A spending goal's category is compared against the canonical expense
      // categories, so fold it the way the budgets do ("Groceries" → "food").
      if (parsed.data.category) parsed.data.category = budgetCategoryKey(parsed.data.category);
      const goal = await storage.createGoal({ ...parsed.data, ...(goalOwners.length > 0 ? { linkedProfiles: goalOwners } : {}) } as any);
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
      req.body = withoutUndefined({ ...req.body, ...parsed.data });
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
    if (typeof req.body.category === "string") req.body.category = budgetCategoryKey(req.body.category);
    try {
      const goal = await storage.updateGoal(req.params.id, req.body);
      if (!goal) return res.status(404).json({ error: "Goal not found" });
      res.json(goal);
    } catch (err: any) {
      if (Number(err?.statusCode) >= 400 && Number(err?.statusCode) < 500) throw err;
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
  app.post("/api/goals/:id/restore", asyncHandler(async (req, res) => {
    const ok = await storage.restoreGoal(req.params.id);
    if (!ok) return res.status(404).json({ error: "Goal not found" });
    res.json({ success: true });
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
    const incomesUid = cacheUserKey(req as AuthenticatedRequest, "incomes:");
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
      const filterCtx = await profileFilterCtx(filterProfileIds, allProfiles);
      incomes = incomes.filter((i: any) => passesProfileFilter(i.linkedProfiles || [], filterCtx));
    }
    res.json(incomes);
  }));

  // Helper: bust every cache key derived from income (cashflow / dashboard /
  // stats / enhanced). Without this, adding a paycheck wouldn't move the
  // "Income this month" or "Net cashflow" numbers until the 5-min server
  // cache expired, which made the dashboard look broken.
  const bustIncomeCaches = (uid: string) => {
    bustCache(`incomes:${uid}`);
    bustCache(`cashflow:${uid}`);
    bustCache(`stats:${uid}`);
    bustCache(`enhanced:${uid}`);
    bustCache(`profile-detail:${uid}:`);
  };

  // An income's cadence has to be one the monthly converter (shared/
  // obligation-windows toMonthlyAmount) knows: anything else it silently
  // treats as monthly, which is how `frequency: "hourly"` was stored and then
  // counted as a monthly paycheck. "custom" is the converter's documented
  // treat-as-monthly value. (insertIncomeSchema types frequency as a bare
  // string; the vocabulary belongs there eventually.)
  // Stored as the canonical word: "bi-weekly" and "fortnightly" converted
  // correctly but were stored verbatim, and the paycheck projection, the
  // calendar and the monthly-total filters switch on "biweekly" only.
  const normalizeIncomeFrequency = (raw: unknown): string => canonicalIncomeFrequency(raw) ?? String(raw ?? "").trim().toLowerCase();
  const validateIncomeFrequency = (raw: unknown): string | null => {
    if (typeof raw !== "string") return "frequency must be a string";
    if (!raw.trim()) return "frequency must not be empty";
    return canonicalIncomeFrequency(raw) ? null : `Unknown frequency "${raw}" — use once, daily, weekly, biweekly, monthly, quarterly or yearly`;
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
    {
      const amountError = validateTransactionAmount(amt);
      if (amountError) return res.status(400).json({ error: amountError });
    }
    req.body.amount = amt;
    req.body.description = sanitize(req.body.description);
    if (req.body.frequency !== undefined) {
      const frequencyError = validateIncomeFrequency(req.body.frequency);
      if (frequencyError) return res.status(400).json({ error: frequencyError });
      req.body.frequency = normalizeIncomeFrequency(req.body.frequency);
    }
    applyActiveProfileScope(req, req.body);
    // The same gate expenses / tasks / events run. Without it a string `tags`,
    // a non-array linkedProfiles or a junk date reached storage and 500'd.
    const parsed = insertIncomeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation failed", issues: parsed.error.issues });
    const income = await storage.createIncome(parsed.data);
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
    if (req.body.frequency !== undefined) {
      const frequencyError = validateIncomeFrequency(req.body.frequency);
      if (frequencyError) return res.status(400).json({ error: frequencyError });
      req.body.frequency = normalizeIncomeFrequency(req.body.frequency);
    }
    {
      const parsed = insertIncomeSchema.partial().safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Validation failed", issues: parsed.error.issues });
      req.body = { ...req.body, ...parsed.data };
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
      const { confirmation } = req.body || {};
      if (confirmation !== "DELETE") {
        return res.status(400).json({ error: "You must send confirmation: 'DELETE' to proceed." });
      }
      // Validate first, then spend the once-an-hour allowance: a mistyped
      // confirmation used to burn it, and the corrected request an instant
      // later was told to come back in an hour.
      const deleteUid = (req as AuthenticatedRequest).userId || req.ip || 'anonymous';
      if (rateLimit(`delete-all:${deleteUid}`, 1, 3600000)) {
        return res.status(429).json({ error: "Account deletion rate limited. Try again in an hour." });
      }
      const result = await storage.deleteAllUserData();
      clearAllCache();
      const failed = Object.keys((result as any).errors || {});
      // The wipe takes the Self profile with everything else, and the auth
      // middleware only auto-creates a Self once per process per user — so
      // on a warm instance the account stayed Self-less: every new task and
      // expense linked to nobody and the orphan rule had no Self to fall back
      // to. Give the account its Self back as part of the wipe.
      let selfRecreated = false;
      if (failed.length === 0) {
        try {
          await storage.createProfile({ name: "Me", type: "self", notes: "", fields: {}, tags: [] } as any);
          selfRecreated = true;
        } catch (e: any) {
          log.warn(`[delete-all] could not recreate the Self profile: ${e?.message || e}`);
        }
      }
      // Erasure is the one operation that must not claim success it can't
      // prove: any table that errored is named, and success flips off.
      res.status(failed.length > 0 ? 500 : 200).json({
        success: failed.length === 0,
        deleted: result.deleted,
        selfRecreated,
        ...(failed.length > 0 ? { errors: (result as any).errors } : {}),
      });
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
      // Resolve the wall-clock time in the USER's zone. This used to stamp the
      // server's UTC offset (always +00:00 on Vercel) onto local hours, so a
      // 6:00 AM Pacific event reached Google Calendar at 06:00 UTC — 11 PM the
      // previous evening for the user.
      const tz = getTimezone(req);
      const startInstant = zonedTimeToUTC(dateStr, startHour, startMin, tz);

      let endInstant: Date | null = null;
      const endMatch = event.endTime ? event.endTime.match(/(\d+):(\d+)\s*(AM|PM)?/i) : null;
      if (endMatch) {
        let endHour = parseInt(endMatch[1]);
        const endMin = parseInt(endMatch[2]);
        if (endMatch[3]?.toUpperCase() === "PM" && endHour !== 12) endHour += 12;
        if (endMatch[3]?.toUpperCase() === "AM" && endHour === 12) endHour = 0;
        endInstant = zonedTimeToUTC(event.endDate || dateStr, endHour, endMin, tz);
      }
      // Default to one hour, as an instant — "startHour + 1" emitted the invalid
      // "T24:00:00" for an 11 PM start.
      if (!endInstant || endInstant.getTime() <= startInstant.getTime()) {
        endInstant = new Date(startInstant.getTime() + 60 * 60000);
      }
      const startDateTime = startInstant.toISOString();
      const endDateTime = endInstant.toISOString();

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
      if (isUniqueViolation(err)) return res.status(409).json({ error: ALREADY_LINKED_MSG });
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
    // The shared payment schema allows 0 because a $0 bill can be marked
    // paid; a LOAN payment of $0 is a slip (a ledger row, a $0 expense and a
    // "paid" stamp with no money moved), so this route refuses it.
    if (!(Number(parsed.data.amount) > 0)) return res.status(400).json({ error: "Payment amount must be greater than zero" });

    // SINGLE SOURCE OF TRUTH: the server — not the client — owns the
    // principal/interest split AND the resulting balance, and it owns them in
    // exactly one place (server/liability-payments.ts) so a payment recorded
    // through chat produces the same row as one recorded through this form.
    // The occurrence stamp and due-date policy ride along too — this form used
    // to skip both, so a bill paid here still showed unpaid on its schedule.
    const d: any = parsed.data;
    const occurrenceDate = isCalendarDay(String(req.body?.occurrenceDate || ""))
      ? String(req.body.occurrenceDate) : null;
    // Pay-from-account, the same field the bills route honours. The schema
    // strips unknown keys, so `accountId` used to be dropped here and a loan
    // payment "from Chase Checking" never debited Chase Checking.
    const accountId = req.body?.accountId;
    if (accountId !== undefined && accountId !== null && typeof accountId !== "string") {
      return res.status(400).json({ error: "accountId must be a string" });
    }
    const result = await payBillOccurrence(storage, req.params.id, {
      amount: d.amount,
      paymentDate: d.paymentDate,
      occurrenceDate,
      accountId: accountId || null,
      principal: d.principalPortion || null,
      interest: d.interestPortion || null,
      fees: d.fees ?? null,
      paymentType: d.paymentType && d.paymentType !== "standard" ? d.paymentType : null,
      method: d.sourceAccount ?? null,
      notes: d.notes ?? null,
      source: "route",
    }, getTimezone(req));
    if (!result.ok) return res.status(result.reason === "payment_failed" ? 500 : 404).json({ error: "Payment failed" });
    res.json(result.payment);
  }));
  app.patch("/api/liability-payments/:id", asyncHandler(async (req, res) => {
    const body = (req.body && typeof req.body === "object" && !Array.isArray(req.body)) ? req.body : null;
    if (!body) return res.status(400).json({ error: "Request body must be a JSON object" });
    const row: any = await storage.getLiabilityPayment(req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });

    // A payment row is the head of a pipeline (server/liability-payments.ts):
    // the ledger DERIVES principal/interest/fees, the balance after and the
    // payment type from the amount and the liability's state, and the row's
    // liability is the key the occurrence stamp, the account debit and the
    // logged expense hang off. Editing any of those directly leaves the debt
    // balance, the stamp and the expense describing a payment that no longer
    // exists — so they are refused rather than desynced. `amount` and
    // `paymentDate` are edited by re-recording the payment (below);
    // notes / sourceAccount / documentId touch nothing downstream.
    const DERIVED = ["principalPortion", "interestPortion", "fees", "remainingBalanceAfter", "paymentType", "liabilityProfileId"];
    const refused = DERIVED.filter((k) => body[k] !== undefined);
    if (refused.length > 0) {
      return res.status(400).json({ error: `${refused.join(", ")} ${refused.length > 1 ? "are" : "is"} derived by the ledger and cannot be edited directly; change amount or paymentDate instead` });
    }
    const EDITABLE = ["amount", "paymentDate", "notes", "sourceAccount", "documentId"];
    const unknown = Object.keys(body).filter((k) => !EDITABLE.includes(k));
    if (unknown.length > 0) return res.status(400).json({ error: `Unknown field(s): ${unknown.join(", ")}` });

    let amount: number | undefined;
    if (body.amount !== undefined) {
      const parsedAmount = typeof body.amount === "number" ? body.amount : Number(body.amount);
      const amountError = validateTransactionAmount(parsedAmount);
      if (amountError) return res.status(400).json({ error: amountError });
      amount = parsedAmount;
    }
    const tz = getTimezone(req);
    let paymentDate: string | undefined;
    if (body.paymentDate !== undefined) {
      const d = typeof body.paymentDate === "string" ? parseUserDateTime(body.paymentDate, tz) : new Date(NaN);
      if (isNaN(d.getTime())) return res.status(400).json({ error: "paymentDate must be a valid date" });
      paymentDate = toLocalDateStr(d, tz);
    }
    const cosmetic: Record<string, any> = {};
    for (const k of ["notes", "sourceAccount", "documentId"]) {
      if (body[k] === undefined) continue;
      if (body[k] !== null && typeof body[k] !== "string") return res.status(400).json({ error: `${k} must be a string` });
      cosmetic[k] = body[k];
    }

    const uid = cacheUserKey(req as AuthenticatedRequest);
    const amountChanged = amount !== undefined && amount !== Number(row.amount);
    const dateChanged = paymentDate !== undefined && paymentDate !== String(row.paymentDate || "").slice(0, 10);
    if (!amountChanged && !dateChanged) {
      const updated = Object.keys(cosmetic).length > 0 ? await storage.updateLiabilityPayment(req.params.id, cosmetic) : row;
      if (!updated) return res.status(404).json({ error: "Not found" });
      bustBillCaches(uid);
      return res.json(updated);
    }

    // Amount / date: re-record through the one pay operation, so the balance,
    // the occurrence stamp, the source account and the logged expense all
    // describe the edited payment. unpayBillOccurrence retracts exactly what
    // payBillOccurrence wrote; the occurrence and account come from the stamp
    // the original payment left, so the same period is settled again.
    const liability: any = await storage.getProfile(row.liabilityProfileId);
    if (!liability) return res.status(404).json({ error: "Liability not found" });
    const occ = (liability.fields?.occurrences && typeof liability.fields.occurrences === "object") ? liability.fields.occurrences : {};
    const stamped = Object.entries(occ).find(([, ov]: [string, any]) => ov && ov.paymentId === row.id);
    const occurrenceDate = stamped?.[0] || String(row.paymentDate || "").slice(0, 10) || null;
    const accountId = (stamped?.[1] as any)?.accountId || null;
    const undone = await unpayBillOccurrence(storage, row.liabilityProfileId, { paymentId: row.id, source: "route" }, tz, log);
    if (!undone.ok) return res.status(404).json({ error: "Payment not found" });
    const result = await payBillOccurrence(storage, row.liabilityProfileId, {
      occurrenceDate,
      amount: amount ?? Number(row.amount),
      paymentDate: paymentDate ?? String(row.paymentDate || "").slice(0, 10),
      accountId,
      method: cosmetic.sourceAccount !== undefined ? cosmetic.sourceAccount : (row.sourceAccount ?? null),
      notes: cosmetic.notes !== undefined ? cosmetic.notes : (row.notes ?? null),
      fees: row.fees ?? null,
      paymentType: row.paymentType && row.paymentType !== "standard" ? row.paymentType : null,
      source: "route",
    }, tz, log);
    if (!result.ok) return res.status(500).json({ error: "Payment could not be re-recorded", reason: result.reason });
    let payment = result.payment;
    if (cosmetic.documentId !== undefined && payment?.id) {
      payment = (await storage.updateLiabilityPayment(payment.id, { documentId: cosmetic.documentId })) ?? payment;
    }
    bustBillCaches(uid);
    // The edited payment is a NEW row; callers holding the old id get both.
    res.json({ ...payment, previousPaymentId: row.id });
  }));
  app.delete("/api/liability-payments/:id", asyncHandler(async (req, res) => {
    // Full inverse, not a bare row delete: occurrence stamp cleared, due date
    // rolled back, debt balance restored, account credited, expense retracted.
    const row = await storage.getLiabilityPayment(req.params.id);
    if (!row) return res.status(404).json({ error: "Payment not found" });
    const result = await unpayBillOccurrence(storage, (row as any).liabilityProfileId, {
      paymentId: req.params.id, source: "route",
    }, getTimezone(req));
    if (!result.ok) return res.status(404).json({ error: "Payment not found" });
    res.json({ success: true, ...{ deletedPaymentId: result.deletedPaymentId } });
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
  // Postgres unique violation: the party is already linked to this item. A
  // second POST used to surface as a bare 500; the honest answer is 409 with
  // a pointer to the edit path.
  const isUniqueViolation = (err: any): boolean => String(err?.code || "") === "23505" || /duplicate key/i.test(String(err?.message || ""));
  const ALREADY_LINKED_MSG = "This person is already an owner here. Edit their existing share instead of adding a second link.";

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
      if (isUniqueViolation(err)) return res.status(409).json({ error: ALREADY_LINKED_MSG });
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
    const parsed = insertCaptureSchema.safeParse(applyActiveProfileScope(req, req.body || {}, "ownerProfileId"));
    if (!parsed.success) return res.status(400).json({ error: "Invalid capture", details: parsed.error.flatten() });
    // Default ownerProfileId to self when missing/null.
    let ownerProfileId = parsed.data.ownerProfileId ?? null;
    if (!ownerProfileId) {
      const self = await storage.getSelfProfile?.();
      if (self) ownerProfileId = self.id;
    }
    const capture = await storage.createCapture({ ...parsed.data, ownerProfileId });
    // A capture that could not be stored (no `captures` table on this
    // deployment) must not be reported as saved: it answered 200 with an id
    // that GET and DELETE then could not find.
    if ((capture as any)?.ephemeral) {
      return res.status(503).json({ error: "Captures are not set up on this deployment (the captures table is missing); nothing was saved" });
    }
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
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return res.status(400).json({ error: "Request body must be a JSON object" });
    }
    const updated = await storage.updateCapture(req.params.id, req.body);
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

  // Unknown API paths are 404 JSON, never the SPA shell. Without this the
  // static fallback answered `POST /api/profiles/:id/restore` (no such
  // route) with 200 + index.html, so a client believed a restore, an undo
  // or a typo'd call had succeeded when nothing happened.
  app.all(/^\/api(\/|$)/, (req: any, res: any) => {
    res.status(404).json({ error: `No API route for ${req.method} ${req.path}` });
  });

  // Global error handler — body-parser rejections (a JSON string or bare
  // number as the body, malformed JSON, a body over the size limit) carry a
  // 4xx status and are the caller's fault: they used to come back as 500
  // with the parser's own message. Everything else stays a generic 500 so
  // internal details never leak.
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = Number(err?.statusCode || err?.status);
    if (res.headersSent) return;
    if (err?.type === "entity.parse.failed" || (Number.isInteger(status) && status >= 400 && status < 500)) {
      res.status(Number.isInteger(status) && status >= 400 && status < 500 ? status : 400).json({
        error: err?.type === "entity.parse.failed" ? "Invalid JSON body" : (err?.type === "entity.too.large" ? "Request body too large" : (err?.expose ? err.message : "Bad request")),
      });
      return;
    }
    console.error(`[API Error]`, err?.message || err);
    res.status(500).json({ error: "Internal server error" });
  });

  return httpServer;
}

