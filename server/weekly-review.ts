// Weekly Review generator + anomaly detection.
// - generateWeeklyReview(storage): builds a 1-week summary doc artifact (HTML)
//   covering finance, trackers, tasks, journal, habits. Runs Claude to write a
//   short narrative intro at the top.
// - detectAnomalies(storage): returns a list of high-signal anomalies
//   (category spending vs avg, tracker idle, large expense, budget breach).
//
// Both functions read from the request-scoped storage proxy so they
// automatically operate on the calling user's data.

import Anthropic from "@anthropic-ai/sdk";

function getAnthropic(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY required");
  return new Anthropic({ apiKey });
}

function fmtMoney(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch { return iso; }
}

// ============================================================
// ANOMALY DETECTION
// ============================================================

export type Anomaly = {
  id: string;
  severity: "low" | "medium" | "high";
  category: "spending" | "tracker" | "habit" | "budget" | "income";
  title: string;
  detail: string;
  amount?: number;
  vsBaseline?: number;     // percentage delta vs baseline
};

export async function detectAnomalies(storage: any): Promise<Anomaly[]> {
  const anomalies: Anomaly[] = [];

  // Pull ~90 days of data to compute baselines.
  const now = Date.now();
  const ninetyDayAgo = new Date(now - 90 * 86400000);
  const sevenDayAgo = new Date(now - 7 * 86400000);
  const thirtyDayAgo = new Date(now - 30 * 86400000);

  const [expenses, trackers, budgets] = await Promise.all([
    storage.getExpenses().catch(() => []),
    storage.getTrackers().catch(() => []),
    storage.getBudgets().catch(() => []),
  ]);

  // ── Spending category anomalies ──
  // Compute weekly avg per category over last 90 days, compare with last 7 days.
  type CatStat = { total90: number; total7: number; weeks: number };
  const catStats: Record<string, CatStat> = {};
  for (const e of expenses as any[]) {
    const d = new Date(e.date);
    if (isNaN(d.getTime()) || d < ninetyDayAgo) continue;
    const cat = String(e.category || "uncategorized");
    const amt = Math.abs(Number(e.amount || 0));
    const stat = catStats[cat] || { total90: 0, total7: 0, weeks: 13 };
    stat.total90 += amt;
    if (d >= sevenDayAgo) stat.total7 += amt;
    catStats[cat] = stat;
  }
  for (const [cat, s] of Object.entries(catStats)) {
    const weeklyAvg = s.total90 / 13;
    if (weeklyAvg < 20) continue; // ignore low-signal categories
    const pctDelta = weeklyAvg > 0 ? ((s.total7 - weeklyAvg) / weeklyAvg) * 100 : 0;
    if (s.total7 > weeklyAvg * 1.4 && s.total7 - weeklyAvg > 30) {
      anomalies.push({
        id: `spend-up-${cat}`,
        severity: pctDelta > 80 ? "high" : "medium",
        category: "spending",
        title: `${cat} spending up ${Math.round(pctDelta)}% this week`,
        detail: `${fmtMoney(s.total7)} this week vs ${fmtMoney(weeklyAvg)} weekly avg over the past 90 days.`,
        amount: s.total7,
        vsBaseline: pctDelta,
      });
    }
  }

  // ── Large single expense ──
  // Last 7 days, any single expense > 3× the user's avg expense.
  const expensesForBaseline = (expenses as any[]).filter(e => new Date(e.date) >= ninetyDayAgo);
  const allAmts = expensesForBaseline.map(e => Math.abs(Number(e.amount || 0))).filter(a => a > 0);
  const avgExp = allAmts.length > 0 ? allAmts.reduce((a, b) => a + b, 0) / allAmts.length : 0;
  for (const e of expensesForBaseline) {
    const d = new Date(e.date);
    if (d < sevenDayAgo) continue;
    const amt = Math.abs(Number(e.amount || 0));
    if (avgExp > 0 && amt > avgExp * 4 && amt > 100) {
      anomalies.push({
        id: `big-expense-${e.id || e.date}-${amt}`,
        severity: amt > avgExp * 8 ? "high" : "medium",
        category: "spending",
        title: `Unusually large expense: ${fmtMoney(amt)}`,
        detail: `${e.description || e.category || "expense"} on ${fmtDate(e.date)} (${(amt / avgExp).toFixed(1)}× your average).`,
        amount: amt,
      });
    }
  }

  // ── Budget breach ──
  // For each budget, if month-to-date spend in that category exceeds amount.
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const monthExpenses = (expenses as any[]).filter(e => new Date(e.date) >= monthStart);
  for (const b of (budgets as any[])) {
    const cat = String(b.category || "").toLowerCase();
    if (!cat) continue;
    const spent = monthExpenses
      .filter(e => String(e.category || "").toLowerCase() === cat)
      .reduce((s, e) => s + Math.abs(Number(e.amount || 0)), 0);
    const cap = Number(b.amount || 0);
    if (cap > 0 && spent > cap) {
      const overPct = ((spent - cap) / cap) * 100;
      anomalies.push({
        id: `budget-${b.category}`,
        severity: overPct > 50 ? "high" : "medium",
        category: "budget",
        title: `${b.category} budget exceeded by ${Math.round(overPct)}%`,
        detail: `Spent ${fmtMoney(spent)} of ${fmtMoney(cap)} budget this month.`,
        amount: spent - cap,
        vsBaseline: overPct,
      });
    } else if (cap > 0 && spent > cap * 0.85) {
      anomalies.push({
        id: `budget-warn-${b.category}`,
        severity: "low",
        category: "budget",
        title: `${b.category} budget at ${Math.round((spent / cap) * 100)}%`,
        detail: `Spent ${fmtMoney(spent)} of ${fmtMoney(cap)} budget this month.`,
        amount: spent,
      });
    }
  }

  // ── Tracker idle ──
  // If a tracker has 30+ days of historical data but no entries in the last 14 days, flag.
  for (const t of (trackers as any[])) {
    const entries = Array.isArray(t.entries) ? t.entries : [];
    if (entries.length < 5) continue;
    const sorted = [...entries].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const latestTs = new Date(sorted[0].timestamp).getTime();
    const oldestTs = new Date(sorted[sorted.length - 1].timestamp).getTime();
    const span = latestTs - oldestTs;
    if (span < 30 * 86400000) continue;
    const sinceDays = Math.floor((now - latestTs) / 86400000);
    if (sinceDays >= 14) {
      anomalies.push({
        id: `tracker-idle-${t.id}`,
        severity: sinceDays > 30 ? "medium" : "low",
        category: "tracker",
        title: `${t.name} hasn't been logged in ${sinceDays} days`,
        detail: `You usually log this regularly. Last entry: ${fmtDate(sorted[0].timestamp)}.`,
      });
    }
  }

  // Sort high → medium → low.
  const sevRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  anomalies.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
  return anomalies;
}

// ============================================================
// WEEKLY REVIEW
// ============================================================

export async function generateWeeklyReview(storage: any): Promise<{
  artifactId: string;
  title: string;
  highlights: number;
}> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const monthAgo = new Date(now.getTime() - 30 * 86400000);
  const weekAgoStr = weekAgo.toISOString().slice(0, 10);
  const monthAgoStr = monthAgo.toISOString().slice(0, 10);

  // Pull data in parallel.
  const [tasks, expenses, trackers, journal, habits, anomalies] = await Promise.all([
    storage.getTasks().catch(() => []),
    storage.getExpenses().catch(() => []),
    storage.getTrackers().catch(() => []),
    storage.getJournalEntries().catch(() => []),
    storage.getHabits().catch(() => []),
    detectAnomalies(storage).catch(() => []),
  ]);

  // Tasks completed this week
  const tasksDoneThisWeek = (tasks as any[]).filter((t: any) => {
    if (t.status !== "done") return false;
    const completed = t.completedAt || t.updatedAt || t.createdAt;
    return completed && new Date(completed) >= weekAgo;
  });
  const tasksOpen = (tasks as any[]).filter((t: any) => t.status !== "done").length;

  // Spending this week + by category
  const expWeek = (expenses as any[]).filter((e: any) => e.date >= weekAgoStr);
  const totalSpend = expWeek.reduce((s: number, e: any) => s + Math.abs(Number(e.amount || 0)), 0);
  const byCat: Record<string, number> = {};
  for (const e of expWeek) {
    const cat = String(e.category || "uncategorized");
    byCat[cat] = (byCat[cat] || 0) + Math.abs(Number(e.amount || 0));
  }
  const topCats = Object.entries(byCat)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // Tracker entries this week
  const trkSummary = (trackers as any[]).map((t: any) => {
    const entries = (t.entries || []).filter((e: any) => new Date(e.timestamp) >= weekAgo);
    return { name: t.name, count: entries.length };
  }).filter(t => t.count > 0).sort((a, b) => b.count - a.count);

  // Journal entries this week
  const journalThisWeek = (journal as any[]).filter((j: any) => new Date(j.timestamp || j.createdAt || j.date) >= weekAgo);

  // Habit streaks
  const habitSummary = (habits as any[]).map((h: any) => ({
    name: h.name,
    streak: h.streak || 0,
  })).filter(h => h.streak > 0).sort((a, b) => b.streak - a.streak).slice(0, 5);

  // ── AI narrative intro ──
  let narrative = "";
  try {
    const ctx = {
      tasksDone: tasksDoneThisWeek.length,
      tasksOpen,
      totalSpend: Math.round(totalSpend),
      topCategories: topCats.map(([c, a]) => ({ category: c, amount: Math.round(a) })),
      trackersLogged: trkSummary.length,
      journalEntries: journalThisWeek.length,
      anomaliesCount: anomalies.length,
    };
    const client = getAnthropic();
    const resp = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system:
        "You write a 2–3 sentence personal weekly recap based on the user's data. Be warm, specific, and motivating without being saccharine. Reference 1–2 concrete numbers from the data. No headings, no bullets — just flowing prose.",
      messages: [{ role: "user", content: `Here's my data:\n${JSON.stringify(ctx, null, 2)}\n\nWrite my weekly recap.` }],
    });
    const block = resp.content?.find((b: any) => b.type === "text") as any;
    narrative = (block?.text || "").trim();
  } catch {
    narrative = `You completed ${tasksDoneThisWeek.length} task${tasksDoneThisWeek.length === 1 ? "" : "s"} and spent ${fmtMoney(totalSpend)} this week.`;
  }

  // ── Build HTML doc body ──
  const dateRange = `${fmtDate(weekAgo.toISOString())} – ${fmtDate(now.toISOString())}`;
  const parts: string[] = [];
  parts.push(`<h1>Weekly Review</h1>`);
  parts.push(`<p><em>${dateRange}</em></p>`);
  parts.push(`<p>${escapeHtml(narrative)}</p>`);

  // Highlights
  parts.push(`<h2>Highlights</h2>`);
  parts.push(`<ul>`);
  parts.push(`<li><strong>${tasksDoneThisWeek.length}</strong> task${tasksDoneThisWeek.length === 1 ? "" : "s"} completed (${tasksOpen} still open)</li>`);
  parts.push(`<li><strong>${fmtMoney(totalSpend)}</strong> spent across ${expWeek.length} transaction${expWeek.length === 1 ? "" : "s"}</li>`);
  if (trkSummary.length > 0) parts.push(`<li><strong>${trkSummary.reduce((s, t) => s + t.count, 0)}</strong> tracker entries across ${trkSummary.length} tracker${trkSummary.length === 1 ? "" : "s"}</li>`);
  if (journalThisWeek.length > 0) parts.push(`<li><strong>${journalThisWeek.length}</strong> journal entr${journalThisWeek.length === 1 ? "y" : "ies"}</li>`);
  parts.push(`</ul>`);

  // Spending breakdown
  if (topCats.length > 0) {
    parts.push(`<h2>Spending</h2>`);
    parts.push(`<ul>`);
    for (const [cat, amt] of topCats) {
      const pct = totalSpend > 0 ? Math.round((amt / totalSpend) * 100) : 0;
      parts.push(`<li><strong>${escapeHtml(cat)}</strong>: ${fmtMoney(amt)} <em>(${pct}%)</em></li>`);
    }
    parts.push(`</ul>`);
  }

  // Tasks this week
  if (tasksDoneThisWeek.length > 0) {
    parts.push(`<h2>Tasks Completed</h2>`);
    parts.push(`<ul>`);
    for (const t of tasksDoneThisWeek.slice(0, 15)) {
      parts.push(`<li>${escapeHtml(t.title || "(untitled)")}</li>`);
    }
    if (tasksDoneThisWeek.length > 15) parts.push(`<li><em>+${tasksDoneThisWeek.length - 15} more</em></li>`);
    parts.push(`</ul>`);
  }

  // Trackers
  if (trkSummary.length > 0) {
    parts.push(`<h2>Trackers</h2>`);
    parts.push(`<ul>`);
    for (const t of trkSummary.slice(0, 10)) {
      parts.push(`<li><strong>${escapeHtml(t.name)}</strong>: ${t.count} entr${t.count === 1 ? "y" : "ies"}</li>`);
    }
    parts.push(`</ul>`);
  }

  // Habits
  if (habitSummary.length > 0) {
    parts.push(`<h2>Habit Streaks</h2>`);
    parts.push(`<ul>`);
    for (const h of habitSummary) {
      parts.push(`<li><strong>${escapeHtml(h.name)}</strong>: ${h.streak} day${h.streak === 1 ? "" : "s"}</li>`);
    }
    parts.push(`</ul>`);
  }

  // Anomalies
  if (anomalies.length > 0) {
    parts.push(`<h2>Things to Watch</h2>`);
    parts.push(`<ul>`);
    for (const a of anomalies.slice(0, 8)) {
      parts.push(`<li><strong>${escapeHtml(a.title)}</strong> — ${escapeHtml(a.detail)}</li>`);
    }
    parts.push(`</ul>`);
  }

  parts.push(`<hr/>`);
  parts.push(`<p><em>Generated automatically. Edit freely — autosave will preserve your changes.</em></p>`);

  const html = parts.join("\n");
  const title = `Weekly Review · ${dateRange}`;

  // Create artifact via storage.
  const artifact = await storage.createArtifact({
    type: "doc",
    title,
    content: html,
    items: [],
    tags: ["weekly-review", "auto-generated"],
    pinned: false,
    source: "weekly-review-cron",
  });

  return {
    artifactId: artifact.id,
    title,
    highlights: tasksDoneThisWeek.length + expWeek.length + journalThisWeek.length,
  };
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
