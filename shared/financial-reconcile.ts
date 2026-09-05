// ── Account reconciliation: "is this the same account?" ──────────────────────
//
// Every source that can tell us about an account — a connected bank feed, an
// uploaded statement, a ChatGPT export, a CSV, the AI reading a sentence, a
// form — first becomes ONE canonical `AccountObservation`. Then one matcher
// decides whether that observation describes an account profile the user
// already has, so "Fidelity", "Fidelity Brokerage" and "Fidelity Account 2"
// never coexist for one brokerage.
//
// Source adapters in, one model out. The adapters here are pure shape
// converters; the I/O that produces their inputs lives with each source.
//
// Pinned by tests/financial-assets.test.ts.

import { accountKindMeta, accountKindOf, isDebtAccountKind, type AccountKind } from "./account-kinds";
import { accountCurrency, accountInstitution, accountLastFour, isAccountProfile } from "./finance-accounts";
import { classifyAccountKind, type ClassificationConfidence, type FinanceDataSource } from "./financial-assets";

/** One source's description of one real-world account, normalized. */
export interface AccountObservation {
  source: FinanceDataSource;
  /** The source's own id for the account (financial_accounts.id, an import unique_id, a document id). */
  sourceRef?: string | null;
  name?: string | null;
  institution?: string | null;
  /** Kind as the source states it; classifyAccountKind fills the gap. */
  kindHint?: string | null;
  providerCategory?: string | null;
  providerSubcategory?: string | null;
  lastFour?: string | null;
  currency?: string | null;
  /** Positive magnitude in MAJOR units (dollars). */
  balance?: number | null;
  availableBalance?: number | null;
  /** YYYY-MM-DD or ISO. */
  asOf?: string | null;
  ownerProfileId?: string | null;
}

/** The observation with its kind resolved. */
export interface ResolvedObservation extends AccountObservation {
  kind: AccountKind;
  kindConfidence: ClassificationConfidence;
}

export function resolveObservationKind(obs: AccountObservation): ResolvedObservation {
  const c = classifyAccountKind({
    hint: obs.kindHint, name: obs.name, institution: obs.institution,
    providerCategory: obs.providerCategory, providerSubcategory: obs.providerSubcategory,
  });
  return { ...obs, kind: c.kind, kindConfidence: c.confidence };
}

// ─── Adapters ────────────────────────────────────────────────────────────────

/** A connected (Stripe Financial Connections) account record → observation. Balance arrives in MINOR units, signed. */
export function observationFromConnectedAccount(a: {
  id: string; institutionName?: string | null; accountName?: string | null; accountDisplayName?: string | null;
  accountCategory?: string | null; accountSubcategory?: string | null; accountType?: string | null;
  lastFour?: string | null; currency?: string | null; currentBalance?: number | null; availableBalance?: number | null;
  balanceAsOf?: string | null;
}, minorPerMajor = 100): AccountObservation {
  const toMajor = (m: number | null | undefined) => (m == null ? null : Math.abs(Number(m)) / minorPerMajor);
  return {
    source: "api",
    sourceRef: a.id,
    name: a.accountDisplayName || a.accountName || null,
    institution: a.institutionName ?? null,
    kindHint: a.accountSubcategory && a.accountSubcategory !== "other" ? a.accountSubcategory : (a.accountType === "investment" ? "investment" : null),
    providerCategory: a.accountCategory ?? null,
    providerSubcategory: a.accountSubcategory ?? null,
    lastFour: a.lastFour ?? null,
    currency: (a.currency ?? "usd").toLowerCase(),
    balance: toMajor(a.currentBalance),
    availableBalance: toMajor(a.availableBalance),
    asOf: a.balanceAsOf ?? null,
  };
}

/** A ChatGPT / CSV import row → observation. */
export function observationFromImportAccount(row: {
  unique_id?: string; name: string; type?: string | null; balance?: number | null; currency?: string | null; institution?: string | null; notes?: string | null;
}): AccountObservation {
  return {
    source: "import",
    sourceRef: row.unique_id ?? null,
    name: row.name,
    institution: row.institution ?? null,
    kindHint: row.type ?? null,
    currency: (row.currency ?? "USD").toLowerCase(),
    balance: row.balance == null ? null : Math.abs(Number(row.balance)),
  };
}

/** What the AI (or a form) said in one turn → observation. */
export function observationFromInput(input: {
  name?: string | null; accountKind?: string | null; institution?: string | null; balance?: number | null;
  accountNumberLast4?: string | null; currency?: string | null; balanceAsOf?: string | null; description?: string | null;
}, source: FinanceDataSource = "ai"): AccountObservation {
  return {
    source,
    name: input.name ?? null,
    institution: input.institution ?? null,
    kindHint: input.accountKind ?? null,
    lastFour: input.accountNumberLast4 ? String(input.accountNumberLast4).slice(-4) : null,
    currency: (input.currency ?? "usd").toLowerCase(),
    balance: input.balance == null ? null : Math.abs(Number(input.balance)),
    asOf: input.balanceAsOf ?? null,
  };
}

// ─── Matching ────────────────────────────────────────────────────────────────

export interface MatchScore {
  profileId: string;
  profileName: string;
  score: number;
  confidence: ClassificationConfidence;
  reasons: string[];
}

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Words that describe the KIND, not the identity: "Fidelity Brokerage" ≈ "Fidelity". */
const GENERIC_WORDS = new Set([
  "account", "accounts", "brokerage", "checking", "savings", "investment", "investments", "retirement", "cash",
  "card", "credit", "bank", "the", "my", "our", "joint", "individual", "personal", "main", "primary",
  "wallet", "fund", "plan", "ira", "roth", "401k", "hsa", "cd", "money", "market", "crypto", "portfolio",
  "traditional", "taxable", "trading", "1", "2", "3", "one", "two", "new", "old",
]);

const INSTITUTION_ALIASES: Array<[RegExp, string]> = [
  [/\b(bofa|bank of america)\b/, "bank of america"],
  [/\b(wells|wells fargo)\b/, "wells fargo"],
  [/\b(citi|citibank)\b/, "citi"],
  [/\b(amex|american express)\b/, "american express"],
  [/\b(schwab|charles schwab)\b/, "schwab"],
  [/\b(fidelity|fidelity investments)\b/, "fidelity"],
  [/\b(vanguard|the vanguard group)\b/, "vanguard"],
  [/\b(td ameritrade|ameritrade)\b/, "td ameritrade"],
  [/\b(etrade|e\*trade|e trade)\b/, "etrade"],
  [/\b(capital one|capitalone)\b/, "capital one"],
  [/\b(chase|jpmorgan chase|jp morgan)\b/, "chase"],
];

export function canonicalInstitution(s: unknown): string {
  const n = norm(s);
  if (!n) return "";
  for (const [re, canon] of INSTITUTION_ALIASES) if (re.test(n)) return canon;
  return n.replace(/\b(inc|llc|corp|corporation|co|bank|na|n a|financial|investments|securities)\b/g, "").replace(/\s+/g, " ").trim() || n;
}

function identityTokens(name: unknown): string[] {
  return norm(name).split(" ").filter((t) => t && !GENERIC_WORDS.has(t));
}

/** Institution mentioned anywhere in a profile: its field, or its name. */
function profileInstitution(p: any): string {
  const explicit = canonicalInstitution(accountInstitution(p));
  if (explicit) return explicit;
  const n = norm(p?.name);
  for (const [re, canon] of INSTITUTION_ALIASES) if (re.test(n)) return canon;
  return "";
}

function observationInstitution(o: AccountObservation): string {
  const explicit = canonicalInstitution(o.institution);
  if (explicit) return explicit;
  const n = norm(o.name);
  for (const [re, canon] of INSTITUTION_ALIASES) if (re.test(n)) return canon;
  return "";
}

/**
 * Score how likely `profile` is the same real-world account as `obs`.
 *
 * Signals, strongest first:
 *   last four digits agree            +0.45   (disagree: −0.6, decisive)
 *   institution agrees                +0.30   (disagree when both known: −0.4)
 *   kind agrees (or same side/group)  +0.15 / +0.05 (opposite side: −0.5)
 *   identity words in the name agree  +0.10 per word, max +0.20
 *   currency agrees                   +0.05  (disagree: −0.3)
 *   owner agrees                      +0.05  (disagree: −0.2)
 *   balance within 2%                 +0.10  (a same-day statement)
 * Score ≥ 0.75 is a confident match, ≥ 0.5 needs the user to confirm.
 */
export function scoreAccountMatch(obs: ResolvedObservation, profile: any): MatchScore {
  const reasons: string[] = [];
  let score = 0;

  const pLast4 = accountLastFour(profile);
  if (obs.lastFour && pLast4) {
    if (obs.lastFour === pLast4) { score += 0.45; reasons.push(`ends in ${pLast4}`); }
    else { score -= 0.6; reasons.push("different account number"); }
  }

  const oInst = observationInstitution(obs);
  const pInst = profileInstitution(profile);
  if (oInst && pInst) {
    if (oInst === pInst) { score += 0.3; reasons.push(`both at ${pInst}`); }
    else { score -= 0.4; reasons.push(`${oInst} vs ${pInst}`); }
  }

  const pKind = accountKindOf(profile);
  if (obs.kind !== "other" && obs.kindConfidence !== "none") {
    const oMeta = accountKindMeta(obs.kind);
    const pMeta = accountKindMeta(pKind);
    if (isDebtAccountKind(obs.kind) !== isDebtAccountKind(pKind)) { score -= 0.5; reasons.push("one is money owed, the other money held"); }
    else if (obs.kind === pKind) { score += 0.15; reasons.push(`both ${pMeta.label.toLowerCase()}`); }
    else if (oMeta.group === pMeta.group) { score += 0.05; reasons.push(`both ${pMeta.group}`); }
    else if (pKind !== "other" && obs.kindConfidence === "high") { score -= 0.15; reasons.push(`${oMeta.label} vs ${pMeta.label}`); }
  }

  const oWords = identityTokens(obs.name);
  const pWords = new Set(identityTokens(profile?.name));
  const shared = oWords.filter((w) => pWords.has(w));
  if (shared.length > 0) { score += Math.min(0.2, shared.length * 0.1); reasons.push(`name shares "${shared.join(" ")}"`); }

  const oCur = String(obs.currency ?? "usd").toLowerCase();
  const pCur = accountCurrency(profile);
  if (oCur === pCur) score += 0.05; else { score -= 0.3; reasons.push(`${oCur.toUpperCase()} vs ${pCur.toUpperCase()}`); }

  if (obs.ownerProfileId && profile?.parentProfileId) {
    if (obs.ownerProfileId === profile.parentProfileId) { score += 0.05; reasons.push("same owner"); }
    else { score -= 0.2; reasons.push("different owner"); }
  }

  const pBal = Number(profile?.fields?.balance ?? profile?.fields?.currentBalance ?? profile?.fields?.currentValue);
  if (obs.balance != null && Number.isFinite(pBal) && pBal > 0) {
    if (Math.abs(pBal - obs.balance) / pBal <= 0.02) { score += 0.1; reasons.push("same balance"); }
  }

  const rounded = Math.round(Math.max(0, Math.min(1, score)) * 100) / 100;
  return {
    profileId: String(profile?.id ?? ""),
    profileName: String(profile?.name ?? ""),
    score: rounded,
    confidence: rounded >= 0.75 ? "high" : rounded >= 0.5 ? "medium" : rounded >= 0.3 ? "low" : "none",
    reasons,
  };
}

export interface MatchResult {
  best: MatchScore | null;
  candidates: MatchScore[];
  /** high → link silently; medium → ask; low/none → create. */
  decision: "link" | "confirm" | "create";
}

/**
 * Find the account profile an observation describes, if any.
 *
 * Only account profiles on the SAME side of the balance sheet are considered,
 * and profiles already claimed by another source row (`excludeIds`) are
 * skipped so two connected accounts never both land on one profile.
 */
export function findAccountMatch(obs: AccountObservation, profiles: readonly any[], excludeIds?: ReadonlySet<string> | null): MatchResult {
  const resolved = resolveObservationKind(obs);
  const wantDebt = isDebtAccountKind(resolved.kind);
  const pool = (profiles || []).filter((p) =>
    isAccountProfile(p) && !excludeIds?.has(p.id) &&
    (resolved.kind === "other" || isDebtAccountKind(accountKindOf(p)) === wantDebt));
  const candidates = pool.map((p) => scoreAccountMatch(resolved, p))
    .filter((c) => c.score >= 0.3)
    .sort((a, b) => b.score - a.score);
  const best = candidates[0] ?? null;
  // A confident match must also be UNAMBIGUOUS: two profiles tied at the top is a question, not an answer.
  const runnerUp = candidates[1];
  const ambiguous = !!(best && runnerUp && best.score - runnerUp.score < 0.1 && runnerUp.score >= 0.5);
  const decision: MatchResult["decision"] =
    best && best.confidence === "high" && !ambiguous ? "link"
      : best && (best.confidence === "medium" || ambiguous) ? "confirm"
        : "create";
  return { best, candidates: candidates.slice(0, 5), decision };
}

/** A sensible profile name for a brand-new account from an observation. */
export function suggestedAccountName(obs: AccountObservation): string {
  const kind = resolveObservationKind(obs).kind;
  const label = accountKindMeta(kind).label;
  const inst = String(obs.institution ?? "").trim();
  const name = String(obs.name ?? "").trim();
  if (name && (!inst || norm(name).includes(norm(inst)) || identityTokens(name).length > 0)) return name;
  if (inst && kind !== "other") return `${inst} ${label}`;
  if (inst) return inst;
  return name || label;
}
