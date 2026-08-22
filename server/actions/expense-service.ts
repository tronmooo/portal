// ─── Canonical expense creation ─────────────────────────────────────────────
//
// THE single pipeline for creating an expense, whatever door the request came
// through. Modeled on server/habit-completion.ts: do not implement several
// separate copies of validation, dedup, categorization, and attribution — one
// service owns the rules, and the doors differ only in the explicit inputs
// and options they pass.
//
// Doors (all of them):
//   · chat tool  create_expense       (server/ai-engine.ts executeTool)
//   · REST       POST /api/expenses   (server/routes.ts)
//   · document   auto-expense at upload (server/ai-engine.ts processFileUpload)
//   · extraction confirm               (POST /api/chat/confirm-extraction)
//   · chat fast path                   (server/ai-engine.ts tryFastPath)
//
// Rules this consolidates (each previously lived in only SOME doors):
//   · amount bounds       — shared/quick-add.ts validateTransactionAmount
//   · recurrence guard    — "$20/mo for parking" belongs in create_obligation
//     (opt-in: it reads intent, so only the chat-shaped doors want it)
//   · duplicate guard     — in-memory lock for concurrent requests plus a DB
//     window scan; the window is a PER-DOOR PARAMETER (chat retries within
//     ~2 minutes; a UI form only needs double-submit protection; extraction
//     dedupes by date+amount because one document must never yield two
//     expenses). A dedupe returns the existing row with `deduped: true` —
//     callers surface it, never silently swallow the request.
//   · category            — shared/expense-canon.ts (deliberate input wins;
//     keyword/docType/profile-type inference; optional AI categorizer is
//     INJECTED so this module stays model-free and testable)
//   · profile attribution — explicit ids win; else a name resolved with
//     exact-then-word-boundary matching ("Roy" must not match "Royale");
//     else the chat safety net that re-reads "for <Name>" from the user's
//     message and only ever attributes to an EXISTING non-self profile.
//     There is deliberately no fuzzy auto-linking: data goes where the user
//     puts it (see the disabled autoLinkToProfiles in ai-engine.ts).
//   · date                — YYYY-MM-DD, defaulting to today in the user's
//     timezone, never a hard-coded one
//   · schema              — shared/schema.ts insertExpenseSchema, always
//
// The service performs the WRITE only and returns a tool-result-shaped value
// ({...row}, {...row, deduped: true}, or {error}). The post-write contract —
// envelope verification, undo ledger, change manifest — belongs to the door's
// choke point: the chat loop composes it inline; every other door wraps this
// call in runMutation (server/mutation-outcome.ts). Bulk CSV / finance
// imports keep their own batch loops (bulk rows legitimately repeat amounts,
// so the duplicate guard would fight them) but share the category canon.
import type { IStorage } from "../storage";
import { insertExpenseSchema } from "@shared/schema";
import { validateTransactionAmount } from "@shared/quick-add";
import { resolveExpenseCategory } from "@shared/expense-canon";
import { getUserToday, DEFAULT_TIMEZONE } from "@shared/timezone";

export interface CreateExpenseArgs {
  description?: string;
  amount: unknown;
  category?: string;
  vendor?: string;
  /** YYYY-MM-DD; anything else is rejected, absent defaults to today. */
  date?: string;
  tags?: string[];
  /** Explicit profile ids to link (REST body, extraction's resolved asset). */
  linkedProfiles?: string[];
  /** A profile NAME to resolve (the chat tool's forProfile). */
  forProfile?: string;
  /** The raw user message, for the chat attribution safety net. */
  userMessage?: string;
  /** Document class hint for category inference (document door). */
  docType?: string;
}

export interface CreateExpenseOptions {
  /** Scope for the concurrent-duplicate lock (userId; falls back to door). */
  lockUser?: string;
  /** DB duplicate window in ms. 0 disables the window scan. Default 120000. */
  dedupWindowMs?: number;
  /** Extraction rule: any existing expense on the same date within a cent of
   *  the same amount is the same expense (one document, one expense). */
  dedupByDateAmount?: boolean;
  /** Bounce recurring phrasing ("$20/mo") toward create_obligation. */
  rejectRecurring?: boolean;
  /** IANA timezone for the default date. */
  timezone?: string;
  /** Injected AI categorizer (the REST door passes aiPickIndex); consulted
   *  only when text/docType/profile inference found nothing. */
  aiCategorize?: (input: { description: string; vendor?: string; amount: number }) => Promise<string | null>;
}

export type CreateExpenseResult = Record<string, any> & { error?: string; deduped?: boolean };

// In-memory guard against concurrent duplicate creation, scoped per lock key.
// (Same construction as the ai-engine dedup lock; owned here so every door
// shares one map.)
const recentCreations = new Map<string, number>();
const LOCK_WINDOW_MS = 30_000;
function lockKey(user: string, key: string): string { return `${user}:${key}`; }
function isLocked(user: string, key: string): boolean {
  const at = recentCreations.get(lockKey(user, key));
  return at !== undefined && Date.now() - at < LOCK_WINDOW_MS;
}
function lock(user: string, key: string): void {
  recentCreations.set(lockKey(user, key), Date.now());
  if (recentCreations.size > 2000) {
    const cutoff = Date.now() - LOCK_WINDOW_MS;
    for (const [k, at] of recentCreations) if (at < cutoff) recentCreations.delete(k);
  }
}

const RECURRING_RE = /(\/mo\b|\/yr\b|\bper month\b|\bper year\b|\bevery month\b|\beach month\b|\bevery year\b|\bmonthly\b|\byearly\b)/i;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Exact-then-word-boundary profile resolution: "Roy" matches "Roy" and
 *  "Roy Smith", never "Royale". Returns null rather than guessing. */
function resolveProfileByName(profiles: Array<{ id: string; name: string; type?: string }>, name: string, opts: { nonSelfOnly?: boolean } = {}): { id: string; name: string; type?: string } | null {
  const search = name.toLowerCase().trim();
  if (!search) return null;
  const pool = opts.nonSelfOnly ? profiles.filter((p) => p.type !== "self") : profiles;
  const exact = pool.find((p) => p.name.toLowerCase() === search);
  if (exact) return exact;
  const wordRe = new RegExp(`(^|\\b)${escapeRe(search)}(\\b|$)`);
  return pool.find((p) => wordRe.test(p.name.toLowerCase())) ?? null;
}

export async function createExpenseRecord(
  storage: IStorage,
  args: CreateExpenseArgs,
  opts: CreateExpenseOptions = {},
): Promise<CreateExpenseResult> {
  const description = String(args.description || "").trim();
  const vendor = args.vendor ? String(args.vendor) : undefined;

  // 1. Recurrence guard — scoped to THIS expense's own text, never the whole
  //    message (a batch's one recurring item must not poison the rest).
  if (opts.rejectRecurring && RECURRING_RE.test(`${description} ${vendor || ""}`)) {
    return { error: "This sounds recurring — use create_obligation instead, or rephrase as a one-time spend." };
  }

  // 2. Amount.
  const amount = typeof args.amount === "number" && isFinite(args.amount) ? args.amount : parseFloat(String(args.amount));
  if (!amount || amount <= 0) {
    return { error: `Invalid expense amount: ${args.amount}. Please provide a positive number.` };
  }
  const amountError = validateTransactionAmount(amount);
  if (amountError) return { error: amountError };

  // 3. Duplicate guard.
  const lockUser = opts.lockUser || "anon";
  const dedupKey = `expense:${description.toLowerCase()}:${amount}:${args.date || ""}:${(args.forProfile || "").toLowerCase()}`;
  if (isLocked(lockUser, dedupKey)) {
    return { error: "Duplicate expense detected — skipped" };
  }
  const windowMs = opts.dedupWindowMs ?? 120_000;
  if (windowMs > 0 || opts.dedupByDateAmount) {
    const existing = await storage.getExpenses();
    const cutoff = Date.now() - windowMs;
    const dup = existing.find((e: any) => {
      if (opts.dedupByDateAmount) {
        if ((!args.date || e.date === args.date) && Math.abs(Number(e.amount) - amount) < 0.005) return true;
      }
      if (windowMs <= 0) return false;
      if (new Date(e.createdAt).getTime() < cutoff) return false;
      return e.amount === amount &&
        String(e.description || "").toLowerCase().includes(description.toLowerCase().slice(0, 20));
    });
    if (dup) {
      return {
        ...dup,
        deduped: true,
        message: `An identical expense already exists ($${dup.amount} ${dup.description}) — I didn't log it twice.`,
      };
    }
  }

  // 4. Profile attribution (before category — the profile's type is a hint).
  let linkedProfiles: string[] = Array.isArray(args.linkedProfiles) ? args.linkedProfiles.filter(Boolean) : [];
  let attributedProfileType: string | undefined;
  if (linkedProfiles.length === 0 && (args.forProfile || args.userMessage)) {
    const profiles = await storage.getProfiles();
    if (args.forProfile) {
      const target = resolveProfileByName(profiles, args.forProfile);
      if (target) {
        linkedProfiles = [target.id];
        attributedProfileType = target.type;
      }
    }
    // Attribution safety net: the model dropped forProfile but the message
    // says "…$40 for Robert". Only an existing NON-self profile can be
    // recovered this way — this must never invent an owner.
    if (linkedProfiles.length === 0 && args.userMessage) {
      const raw = String(args.userMessage);
      const amtStr = String(amount).replace(/\.0+$/, "");
      const idx = raw.indexOf(amtStr);
      if (idx >= 0) {
        const m = raw.slice(idx, idx + 70).match(/\bfor\s+([A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]+)?)/);
        const cand = m?.[1]?.trim();
        if (cand) {
          const target = resolveProfileByName(profiles, cand, { nonSelfOnly: true });
          if (target) {
            linkedProfiles = [target.id];
            attributedProfileType = target.type;
          }
        }
      }
    }
  } else if (linkedProfiles.length > 0) {
    try {
      const p = await storage.getProfile(linkedProfiles[0]);
      attributedProfileType = p?.type;
    } catch { /* hint only */ }
  }

  // 5. Category: deliberate input → text/docType/profile inference → injected
  //    AI categorizer → "general".
  let category = resolveExpenseCategory(args.category, {
    description, vendor, docType: args.docType, profileType: attributedProfileType,
  });
  if (category === "general" && opts.aiCategorize) {
    try {
      const picked = await opts.aiCategorize({ description, vendor, amount });
      if (picked) {
        category = resolveExpenseCategory(picked, {});
      }
    } catch { /* inference is best-effort */ }
  }

  // 6. Date: strict YYYY-MM-DD, defaulting to today in the user's timezone.
  const today = getUserToday(opts.timezone || DEFAULT_TIMEZONE);
  const date = typeof args.date === "string" && /^\d{4}-\d{2}-\d{2}/.test(args.date) ? args.date.slice(0, 10) : today;

  // 7. Schema, always — every door stores the same shape.
  const parsed = insertExpenseSchema.safeParse({
    amount,
    category,
    description: description || "Expense",
    date,
    vendor,
    tags: args.tags || [],
    linkedProfiles,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message || "Expense validation failed" };
  }

  const expense = await storage.createExpense(parsed.data);
  lock(lockUser, dedupKey);
  if (linkedProfiles.length > 0) {
    for (const pid of linkedProfiles) {
      await storage.linkProfileTo(pid, "expense", expense.id).catch(() => { /* junction is best-effort */ });
    }
  }
  return expense;
}
