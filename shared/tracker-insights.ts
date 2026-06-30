// shared/tracker-insights.ts
// =============================================================================
// Key Findings & Tracker Insights — universal insight engine
// =============================================================================
// Replaces the health-only dashboard swimlane. Pulls signals from every kind of
// tracker plus connected data (finance, obligations, habits, net worth history)
// and surfaces only the most meaningful findings.
//
// Design contract:
//   - Returns ZERO insights when there's no data — caller must hide the section
//     entirely. Never render an empty card.
//   - Only the top-N findings ship, ranked by importance.
//   - Each finding carries: severity (positive/negative/neutral/warning),
//     direction (improving/declining/stable), and a click-through href to the
//     underlying tracker, obligation, or page.
//   - Pure, deterministic, no API calls — feed it the data it needs.
// =============================================================================

import { isInScope } from "./scope";

export type FindingSeverity = "positive" | "negative" | "neutral" | "warning" | "milestone";
export type FindingDirection = "improving" | "declining" | "stable";

export type FindingKind =
  | "tracker_trend"
  | "tracker_streak"
  | "tracker_anomaly"
  | "tracker_milestone"
  | "tracker_stale"
  | "spending_trend"
  | "savings_milestone"
  | "subscription_change"
  | "habit_completion"
  | "habit_streak"
  | "net_worth"
  | "obligation_due"
  | "obligation_action"
  | "goal_progress";

export interface KeyFinding {
  id: string;
  kind: FindingKind;
  severity: FindingSeverity;
  direction: FindingDirection;
  title: string;
  detail?: string;
  /** Where to send the user when they click — usually a hash route. */
  href: string;
  /** Stable sort weight (higher = more important). */
  importance: number;
  /** Optional emoji/icon hint. */
  icon?: string;
  /** Optional related ids for click-through fallback. */
  trackerId?: string;
  profileId?: string;
}

// =============================================================================
// COLORS (HSL strings — no hsl() wrapper, matches dashboard conventions)
// =============================================================================

export const SEVERITY_COLORS: Record<FindingSeverity, { bg: string; fg: string; border: string }> = {
  positive:  { bg: "142 60% 95%",  fg: "142 70% 32%", border: "142 60% 50%" },
  milestone: { bg: "262 70% 95%",  fg: "262 70% 42%", border: "262 70% 60%" },
  negative:  { bg: "0 80% 96%",    fg: "0 75% 42%",   border: "0 72% 60%" },
  warning:   { bg: "32 95% 94%",   fg: "25 92% 38%",  border: "32 92% 55%" },
  neutral:   { bg: "215 16% 95%",  fg: "215 12% 38%", border: "215 14% 70%" },
};

// =============================================================================
// HELPERS
// =============================================================================

interface NumericEntry { ts: number; v: number }

function entriesAsNumeric(tracker: any): NumericEntry[] {
  if (!tracker || !Array.isArray(tracker.entries)) return [];
  const fields: any[] = tracker.fields || [];
  const numericFieldName: string | null = (() => {
    for (const f of fields) {
      if (f?.type === "number" || f?.dataType === "number") return f.name;
    }
    // Fallback: first field with a numeric value across entries.
    for (const e of tracker.entries) {
      if (!e?.values) continue;
      for (const [k, v] of Object.entries(e.values)) {
        if (typeof v === "number" && Number.isFinite(v)) return k;
      }
    }
    return null;
  })();
  if (!numericFieldName) return [];
  const out: NumericEntry[] = [];
  for (const e of tracker.entries) {
    const raw = e?.values?.[numericFieldName];
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) continue;
    const ts = e?.timestamp ? new Date(e.timestamp).getTime() : NaN;
    if (!Number.isFinite(ts)) continue;
    out.push({ ts, v: n });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

function avg(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function pctChange(from: number, to: number): number {
  if (from === 0) return to === 0 ? 0 : 100;
  return ((to - from) / Math.abs(from)) * 100;
}
function fmtNum(n: number, digits = 0): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}
function classifyDirection(deltaPct: number, favorable: "up" | "down" | "neutral"): FindingDirection {
  const eps = 2; // ±2 % considered stable
  if (Math.abs(deltaPct) < eps) return "stable";
  if (favorable === "up") return deltaPct > 0 ? "improving" : "declining";
  if (favorable === "down") return deltaPct < 0 ? "improving" : "declining";
  return "stable";
}

/** Trackers whose values are *better when lower* (weight loss intent, BP, expenses, debt). */
function trackerFavorableDirection(tracker: any): "up" | "down" | "neutral" {
  const name = String(tracker?.name || "").toLowerCase();
  const cat = String(tracker?.category || "").toLowerCase();
  // Health metrics typically lower-is-better
  if (name.includes("weight") || name.includes("bmi")) return "down";
  if (name.includes("blood pressure") || name.includes("bp") || name.includes("systolic") || name.includes("diastolic")) return "down";
  if (name.includes("resting heart") || name.includes("rhr")) return "down";
  if (name.includes("cholesterol") || name.includes("ldl")) return "down";
  if (name.includes("a1c") || name.includes("glucose")) return "down";
  // Lower-is-better finance/lifestyle
  if (cat === "finance" && (name.includes("debt") || name.includes("spending") || name.includes("expense"))) return "down";
  if (name.includes("screen time")) return "down";
  // Higher-is-better
  if (name.includes("step") || name.includes("walking") || name.includes("exercise") || name.includes("workout")) return "up";
  if (name.includes("sleep")) return "up";
  if (name.includes("savings") || name.includes("net worth") || name.includes("income") || name.includes("credit score")) return "up";
  if (name.includes("water") || name.includes("hydration")) return "up";
  if (name.includes("read") || name.includes("study") || name.includes("meditat")) return "up";
  return "neutral";
}

// =============================================================================
// TRACKER FINDINGS
// =============================================================================

function findingsFromTracker(tracker: any, now: number): KeyFinding[] {
  const out: KeyFinding[] = [];
  const numeric = entriesAsNumeric(tracker);
  if (numeric.length === 0) return out;
  const name = tracker.name || "Tracker";
  const unit = tracker.unit || "";
  const favorable = trackerFavorableDirection(tracker);
  const href = `#/trackers?open=${tracker.id}`;
  const last = numeric[numeric.length - 1];
  const lastAgeDays = Math.floor((now - last.ts) / 86400000);

  // ── 1) 60-day trend ─────────────────────────────────────────────────────────
  const sixtyAgo = now - 60 * 86400000;
  const recent = numeric.filter(p => p.ts >= sixtyAgo);
  if (recent.length >= 4) {
    const firstHalfCutoff = sixtyAgo + 30 * 86400000;
    const earlier = recent.filter(p => p.ts < firstHalfCutoff);
    const later = recent.filter(p => p.ts >= firstHalfCutoff);
    if (earlier.length >= 2 && later.length >= 2) {
      const e0 = avg(earlier.map(p => p.v));
      const e1 = avg(later.map(p => p.v));
      const delta = e1 - e0;
      const deltaPct = pctChange(e0, e1);
      if (Math.abs(deltaPct) >= 5) {
        const direction = classifyDirection(deltaPct, favorable);
        const severity: FindingSeverity =
          direction === "improving" ? "positive" :
          direction === "declining" ? "negative" : "neutral";
        const verb = delta > 0 ? "increased" : "decreased";
        const absDelta = Math.abs(delta);
        const detail = `${fmtNum(e0, 1)}${unit ? " " + unit : ""} → ${fmtNum(e1, 1)}${unit ? " " + unit : ""} (${Math.round(Math.abs(deltaPct))}%)`;
        out.push({
          id: `trend::${tracker.id}::60d`,
          kind: "tracker_trend",
          severity,
          direction,
          title: `${name} ${verb} ${fmtNum(absDelta, absDelta < 10 ? 1 : 0)}${unit ? " " + unit : ""} over 60 days`,
          detail,
          href,
          importance: 70 + Math.min(20, Math.round(Math.abs(deltaPct))),
          trackerId: tracker.id,
        });
      }
    }
  }

  // ── 2) "In range" streak — only fires for known clinical metrics ────────────
  const isBP = /blood pressure|bp/i.test(name);
  const isSleep = /sleep/i.test(name);
  const isWeight = /weight/i.test(name);
  if (isBP) {
    const thirtyAgo = now - 30 * 86400000;
    const within = numeric.filter(p => p.ts >= thirtyAgo);
    if (within.length >= 6) {
      const inRange = within.every(p => p.v <= 130 && p.v >= 90);
      if (inRange) {
        out.push({
          id: `streak::${tracker.id}::bp30`,
          kind: "tracker_streak",
          severity: "milestone",
          direction: "stable",
          title: `Blood pressure has stayed in range for 30 days`,
          detail: `Last ${within.length} readings between 90 and 130`,
          href,
          importance: 88,
          trackerId: tracker.id,
        });
      }
    }
  }
  if (isSleep) {
    // 7-day run below 7h target
    const sortedDesc = [...numeric].sort((a, b) => b.ts - a.ts);
    const last7 = sortedDesc.slice(0, 7);
    if (last7.length >= 5 && last7.every(p => p.v < 7)) {
      out.push({
        id: `streak::${tracker.id}::sleep_low`,
        kind: "tracker_anomaly",
        severity: "warning",
        direction: "declining",
        title: `Sleep below 7h for ${last7.length} consecutive nights`,
        detail: `Average ${fmtNum(avg(last7.map(p => p.v)), 1)} hr`,
        href,
        importance: 92,
        trackerId: tracker.id,
      });
    }
  }

  // ── 3) Anomaly — last reading is >2σ from mean of prior 14 ──────────────────
  if (numeric.length >= 8) {
    const prior = numeric.slice(-15, -1);
    const m = avg(prior.map(p => p.v));
    const variance = avg(prior.map(p => (p.v - m) ** 2));
    const stdev = Math.sqrt(variance);
    if (stdev > 0 && Math.abs(last.v - m) > 2 * stdev) {
      const direction = classifyDirection(pctChange(m, last.v), favorable);
      out.push({
        id: `anomaly::${tracker.id}`,
        kind: "tracker_anomaly",
        severity: direction === "improving" ? "positive" : direction === "declining" ? "warning" : "neutral",
        direction,
        title: `${name} reading unusually ${last.v > m ? "high" : "low"}`,
        detail: `${fmtNum(last.v, 1)}${unit ? " " + unit : ""} vs typical ${fmtNum(m, 1)}${unit ? " " + unit : ""}`,
        href,
        importance: 75,
        trackerId: tracker.id,
      });
    }
  }

  // ── 4) Stale tracker — only surface if it has historical importance ─────────
  if (lastAgeDays >= 14 && numeric.length >= 5) {
    out.push({
      id: `stale::${tracker.id}`,
      kind: "tracker_stale",
      severity: "neutral",
      direction: "stable",
      title: `${name} hasn't been logged in ${lastAgeDays} days`,
      detail: `Last entry: ${fmtNum(last.v, 1)}${unit ? " " + unit : ""}`,
      href,
      importance: 40,
      trackerId: tracker.id,
    });
  }

  return out;
}

// =============================================================================
// FINANCE / HABITS / NET WORTH / OBLIGATIONS — non-tracker findings
// =============================================================================

function findingsFromFinance(financeSnapshot: any): KeyFinding[] {
  const out: KeyFinding[] = [];
  if (!financeSnapshot) return out;
  const total = Number(financeSnapshot.totalMonthlySpend) || 0;
  const last = Number(financeSnapshot.lastMonthTotal) || 0;
  if (last > 0 && total > 0) {
    const delta = pctChange(last, total);
    if (Math.abs(delta) >= 10) {
      const up = delta > 0;
      out.push({
        id: "finance::spend_change",
        kind: "spending_trend",
        severity: up ? "warning" : "positive",
        direction: up ? "declining" : "improving",
        title: `Spending ${up ? "increased" : "decreased"} ${Math.round(Math.abs(delta))}% this month`,
        detail: `$${fmtNum(last, 0)} → $${fmtNum(total, 0)} vs last month`,
        href: "#/finance",
        importance: 78,
        icon: up ? "💸" : "💰",
      });
    }
  }
  return out;
}

function findingsFromHabits(habits: any[]): KeyFinding[] {
  const out: KeyFinding[] = [];
  for (const h of habits || []) {
    const streak = Number(h?.currentStreak) || 0;
    const longest = Number(h?.longestStreak) || 0;
    if (streak >= 7 && streak >= longest) {
      out.push({
        id: `habit::${h.id}::record`,
        kind: "habit_streak",
        severity: "milestone",
        direction: "improving",
        title: `${h.name || "Habit"} hit a new ${streak}-day streak`,
        detail: `Previous best: ${longest} days`,
        href: "#/habits",
        importance: 65,
        icon: "🔥",
      });
    } else if (streak >= 14) {
      out.push({
        id: `habit::${h.id}::active`,
        kind: "habit_streak",
        severity: "positive",
        direction: "improving",
        title: `${h.name || "Habit"} — ${streak}-day streak`,
        href: "#/habits",
        importance: 50,
        icon: "🔥",
      });
    }
    // Completion-rate improvement
    const checkins = Array.isArray(h?.checkins) ? h.checkins : [];
    if (checkins.length >= 30) {
      const now = Date.now();
      const prior30 = checkins.filter((c: any) => {
        const t = new Date(c.timestamp || c.date).getTime();
        return t >= now - 60 * 86400000 && t < now - 30 * 86400000;
      }).length;
      const last30 = checkins.filter((c: any) => {
        const t = new Date(c.timestamp || c.date).getTime();
        return t >= now - 30 * 86400000;
      }).length;
      const before = Math.round((prior30 / 30) * 100);
      const after = Math.round((last30 / 30) * 100);
      if (before > 0 && after - before >= 15) {
        out.push({
          id: `habit::${h.id}::completion_up`,
          kind: "habit_completion",
          severity: "positive",
          direction: "improving",
          title: `${h.name || "Habit"} completion improved ${before}% → ${after}%`,
          href: "#/habits",
          importance: 60,
        });
      }
    }
  }
  return out;
}

function findingsFromNetWorth(history: Array<{ snapshotDate: string; netWorth: number }>): KeyFinding[] {
  const out: KeyFinding[] = [];
  if (!Array.isArray(history) || history.length < 2) return out;
  const sorted = [...history].sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate));
  const latest = sorted[sorted.length - 1];
  const qStart = sorted.find(s => {
    const d = new Date(latest.snapshotDate);
    d.setMonth(d.getMonth() - 3);
    return s.snapshotDate >= d.toISOString().slice(0, 10);
  }) || sorted[0];
  const delta = latest.netWorth - qStart.netWorth;
  if (Math.abs(delta) >= 1000) {
    const up = delta > 0;
    out.push({
      id: "networth::quarter",
      kind: "net_worth",
      severity: up ? "positive" : "warning",
      direction: up ? "improving" : "declining",
      title: `Net worth ${up ? "increased" : "decreased"} $${fmtNum(Math.abs(delta), 0)} this quarter`,
      detail: `$${fmtNum(qStart.netWorth, 0)} → $${fmtNum(latest.netWorth, 0)}`,
      href: "#/assets",
      importance: 85,
      icon: up ? "📈" : "📉",
    });
  }
  return out;
}

function findingsFromObligations(obligations: any[]): KeyFinding[] {
  const out: KeyFinding[] = [];
  const now = Date.now();
  for (const o of obligations || []) {
    if (!o?.nextDueDate) continue;
    if (o.status === "paused" || o.status === "cancelled") continue;
    const due = new Date(o.nextDueDate).getTime();
    const days = Math.round((due - now) / 86400000);
    if (days < 0 || days > 14) continue;
    // Surface medication refills and high-impact obligations only.
    const kind = String(o.kind || "").toLowerCase();
    const isMedication = kind === "medication";
    const isAppointment = kind === "appointment";
    if (!isMedication && !isAppointment) continue;
    out.push({
      id: `obligation::${o.id}::action`,
      kind: "obligation_action",
      severity: days <= 3 ? "warning" : "neutral",
      direction: "stable",
      title: `${o.name || "Reminder"} due in ${days <= 0 ? "today" : `${days} day${days === 1 ? "" : "s"}`}`,
      detail: isMedication ? "Refill" : "Appointment",
      href: "#/obligations",
      importance: 80 - days,
      icon: isMedication ? "💊" : "🩺",
    });
  }
  // Subscription cost change — sum monthly subscriptions
  const subs = (obligations || []).filter((o: any) => String(o.kind).toLowerCase() === "subscription" && o.status === "active");
  if (subs.length >= 1) {
    const total = subs.reduce((s: number, o: any) => s + (Number(o.amount) || 0), 0);
    // We can't compute month-over-month without history; just note count when meaningful.
    if (subs.length >= 5) {
      out.push({
        id: "subs::count",
        kind: "subscription_change",
        severity: "neutral",
        direction: "stable",
        title: `${subs.length} active subscriptions totaling $${fmtNum(total, 0)}/mo`,
        href: "#/obligations",
        importance: 45,
        icon: "🔁",
      });
    }
  }
  return out;
}

// =============================================================================
// AGGREGATE
// =============================================================================

export interface InsightInputs {
  trackers?: any[];
  obligations?: any[];
  habits?: any[];
  financeSnapshot?: any;
  netWorthHistory?: Array<{ snapshotDate: string; netWorth: number }>;
  /** Filter scope — when set, drop findings unrelated to these profiles. */
  scopedProfileIds?: string[];
}

export function computeKeyFindings(input: InsightInputs, now: number = Date.now()): KeyFinding[] {
  const all: KeyFinding[] = [];
  for (const t of input.trackers || []) {
    if (input.scopedProfileIds && input.scopedProfileIds.length > 0) {
      const linked: string[] = Array.isArray(t?.linkedProfiles) ? t.linkedProfiles : [];
      // Canonical scope primitive. selfIds is empty here (findings have no
      // profile list) and orphans stay out of a scoped findings view —
      // preserving the previous behavior without a hand-rolled intersection.
      if (!isInScope(linked, { selectedIds: input.scopedProfileIds, selfIds: new Set() }, "out_of_scope")) continue;
    }
    all.push(...findingsFromTracker(t, now));
  }
  all.push(...findingsFromFinance(input.financeSnapshot));
  all.push(...findingsFromHabits(input.habits || []));
  all.push(...findingsFromNetWorth(input.netWorthHistory || []));
  all.push(...findingsFromObligations(input.obligations || []));

  // Dedupe by id, keep highest importance.
  const byId = new Map<string, KeyFinding>();
  for (const f of all) {
    const prev = byId.get(f.id);
    if (!prev || f.importance > prev.importance) byId.set(f.id, f);
  }
  return [...byId.values()].sort((a, b) => b.importance - a.importance);
}

export const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  positive: "Positive",
  milestone: "Milestone",
  negative: "Decline",
  warning: "Warning",
  neutral: "Note",
};

export const DIRECTION_LABEL: Record<FindingDirection, string> = {
  improving: "Improving",
  declining: "Declining",
  stable: "Stable",
};
