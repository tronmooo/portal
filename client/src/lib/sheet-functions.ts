// Custom Portol functions for spreadsheets, exposed via fast-formula-parser's
// `functions` config option. Wired into <Spreadsheet createFormulaParser={…}>.
//
// Usage in a cell:
//   =NETWORTH()              → user's current net worth (assets − liabilities)
//   =ASSETS()                → total asset value across all profiles
//   =LIABILITIES()           → total liabilities across all profiles
//   =MONTHLYSPEND()          → total spend in the current month
//   =MONTHLYINCOME()         → total monthly income
//   =BUDGET("Groceries")     → current month's budget for a category
//   =SPENT("Groceries")      → spending so far this month for a category
//   =TRACKER("Weight")       → latest primary value for a tracker by name
//   =DAYSUNTIL("2026-12-31") → integer days from today (negative if past)
//   =GOAL("Run a 10K")       → progress percentage 0–100 of a named goal
//
// Names match exactly (case-insensitive); fuzzy match falls back to substring.

import { localTodayISO } from "@/lib/dates";
import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "@/lib/queryClient";

// ── Snapshot shape ──
type Snapshot = {
  netWorth: number;
  assets: number;
  liabilities: number;
  monthlySpend: number;
  monthlyIncome: number;
  budgets: Array<{ category: string; amount: number; spent?: number }>;
  trackers: Array<{ name: string; latest: number | null; unit?: string }>;
  goals: Array<{ name: string; progress: number }>;
};

const EMPTY: Snapshot = {
  netWorth: 0, assets: 0, liabilities: 0,
  monthlySpend: 0, monthlyIncome: 0,
  budgets: [], trackers: [], goals: [],
};

// Pull latest primary numeric field from a tracker's most recent entry.
function pickLatestTrackerValue(tr: any): number | null {
  const entries = Array.isArray(tr?.entries) ? tr.entries : [];
  if (entries.length === 0) return null;
  // Sort entries newest first by timestamp.
  const sorted = [...entries].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const latest = sorted[0];
  if (!latest) return null;
  const fields = Array.isArray(tr?.fields) ? tr.fields : [];
  const primary = fields.find((f: any) => f.isPrimary && f.type === "number") || fields.find((f: any) => f.type === "number");
  if (primary && latest.values?.[primary.name] != null) {
    const n = Number(latest.values[primary.name]);
    if (isFinite(n)) return n;
  }
  // Fallback: first numeric value in the entry.
  for (const v of Object.values(latest.values || {})) {
    const n = Number(v);
    if (isFinite(n) && v !== "" && v !== null) return n;
  }
  return null;
}

// Hook that loads the snapshot once (and refreshes every 60s) so formulas have data.
export function useSheetSnapshot(enabled: boolean = true): Snapshot {
  const [snap, setSnap] = useState<Snapshot>(EMPTY);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const load = async () => {
      try {
        const [enhRes, budRes, trkRes, incRes, goalRes] = await Promise.all([
          apiRequest("GET", "/api/dashboard-enhanced").then(r => r.json()).catch(() => null),
          apiRequest("GET", "/api/budgets").then(r => r.json()).catch(() => []),
          apiRequest("GET", "/api/trackers").then(r => r.json()).catch(() => []),
          apiRequest("GET", "/api/incomes").then(r => r.json()).catch(() => []),
          apiRequest("GET", "/api/goals").then(r => r.json()).catch(() => []),
        ]);

        if (cancelled) return;

        const enh = enhRes || {};
        const assets = Number(enh.totalAssetValue || 0);
        const liabilities = Number(enh.totalLiabilities || 0);
        const monthlySpend = Number(enh.financeSnapshot?.totalMonthlySpend ?? enh.totalMonthlySpend ?? 0);
        const monthlyIncome = (Array.isArray(incRes) ? incRes : []).reduce((s: number, i: any) => s + Number(i.amount || 0), 0);

        // Budgets — current month's amounts. Compute spent per category from monthlyExpenseRecords if present.
        const monthExpenses: any[] = enh.monthlyExpenseRecords || [];
        const budgets = (Array.isArray(budRes) ? budRes : []).map((b: any) => {
          const cat = String(b.category || "").trim();
          const spent = monthExpenses
            .filter((e: any) => String(e.category || "").toLowerCase() === cat.toLowerCase())
            .reduce((s: number, e: any) => s + Math.abs(Number(e.amount || 0)), 0);
          return { category: cat, amount: Number(b.amount || 0), spent };
        });

        const trackers = (Array.isArray(trkRes) ? trkRes : []).map((t: any) => ({
          name: String(t.name || ""),
          latest: pickLatestTrackerValue(t),
          unit: t.unit,
        }));

        const goals = (Array.isArray(goalRes) ? goalRes : []).map((g: any) => {
          const target = Number(g.targetValue || 0);
          const current = Number(g.currentValue || 0);
          const progress = target > 0 ? Math.max(0, Math.min(100, (current / target) * 100)) : 0;
          return { name: String(g.name || ""), progress };
        });

        setSnap({
          netWorth: assets - liabilities,
          assets, liabilities,
          monthlySpend, monthlyIncome,
          budgets, trackers, goals,
        });
      } catch {
        // swallow — formulas just return 0 on failure
      }
    };

    load();
    const id = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled]);

  return snap;
}

// Build the `functions` map that fast-formula-parser accepts.
// Each function receives args already coerced from tokens — strings come quoted-stripped.
export function buildSheetFunctions(snap: Snapshot): Record<string, (...args: any[]) => any> {
  const norm = (s: any) => String(s ?? "").trim().toLowerCase();
  const findBy = <T extends { name?: string; category?: string }>(arr: T[], key: string, prop: "name" | "category"): T | undefined => {
    const k = norm(key);
    return arr.find(x => norm((x as any)[prop]) === k) ||
           arr.find(x => norm((x as any)[prop]).includes(k));
  };

  return {
    NETWORTH: () => snap.netWorth,
    ASSETS: () => snap.assets,
    LIABILITIES: () => snap.liabilities,
    MONTHLYSPEND: () => snap.monthlySpend,
    MONTHLYINCOME: () => snap.monthlyIncome,
    CASHFLOW: () => snap.monthlyIncome - snap.monthlySpend,

    BUDGET: (category: any) => {
      const b = findBy(snap.budgets, category, "category");
      return b?.amount ?? 0;
    },
    SPENT: (category: any) => {
      const b = findBy(snap.budgets, category, "category");
      return b?.spent ?? 0;
    },
    REMAINING: (category: any) => {
      const b = findBy(snap.budgets, category, "category");
      return (b?.amount ?? 0) - (b?.spent ?? 0);
    },

    TRACKER: (name: any) => {
      const t = findBy(snap.trackers, name, "name");
      return t?.latest ?? 0;
    },

    GOAL: (name: any) => {
      const g = findBy(snap.goals, name, "name");
      return g?.progress ?? 0;
    },

    DAYSUNTIL: (dateStr: any) => {
      const target = new Date(String(dateStr));
      if (isNaN(target.getTime())) return 0;
      const now = new Date();
      const ms = target.getTime() - now.getTime();
      return Math.ceil(ms / (1000 * 60 * 60 * 24));
    },

    DAYSSINCE: (dateStr: any) => {
      const past = new Date(String(dateStr));
      if (isNaN(past.getTime())) return 0;
      const now = new Date();
      const ms = now.getTime() - past.getTime();
      return Math.floor(ms / (1000 * 60 * 60 * 24));
    },

    TODAY_ISO: () => localTodayISO(),
  };
}
