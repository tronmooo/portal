import { randomUUID } from "crypto";
import type {
  Insight, Profile, Tracker, Task, Expense, Habit, Obligation,
  JournalEntry, Document, Goal, CalendarEvent,
} from "@shared/schema";
import { MOOD_SCORES } from "@shared/schema";
import { getUserToday, addDays as tzAddDays, localDayOf, DEFAULT_TIMEZONE } from "@shared/timezone";
import { rulesFromAll, daysBetweenISO, isAlertDateRule, dateRuleAlertWords, bareDateOf } from "@shared/date-rules";
import {
  currentMonthYM,
  previousMonthYM,
  filterByWindow,
  totalSpend,
  sumByCategory,
  topCategories,
} from "@shared/spending-baseline";

// ============================================================
// INSIGHTS ENGINE — Pure data-driven analysis
// ============================================================

interface InsightsInput {
  profiles: Profile[];
  trackers: Tracker[];
  tasks: Task[];
  expenses: Expense[];
  habits: Habit[];
  obligations: Obligation[];
  journal: JournalEntry[];
  documents: Document[];
  goals: Goal[];
  events: CalendarEvent[];
}

export function generateSmartInsights(data: InsightsInput, timezone: string = DEFAULT_TIMEZONE): Insight[] {
  const insights: Insight[] = [];
  const now = new Date();
  const todayStr = getUserToday(timezone);

  // --- Spending Alerts ---
  analyzeSpending(data.expenses, now, insights, timezone);

  // --- Streak Warnings ---
  analyzeStreaks(data.habits, todayStr, insights);

  // --- Task Reminders ---
  analyzeTasks(data.tasks, now, insights, todayStr, timezone);

  // --- Document Expirations ---
  analyzeDocuments(data.documents, data.profiles, todayStr, insights);

  // --- Goal Progress ---
  analyzeGoals(data.goals, now, todayStr, insights);

  // --- Health Trends ---
  analyzeHealth(data.trackers, todayStr, now, insights);

  // --- Mood Trends ---
  analyzeMood(data.journal, now, insights);

  // --- Obligation Alerts ---
  analyzeObligations(data.obligations, now, insights, todayStr, timezone);

  // --- Upcoming Events ---
  analyzeEvents(data.events, now, insights);

  // --- Tracker Staleness ---
  analyzeTrackerStaleness(data.trackers, now, insights);

  // Sort: warning > negative > info > positive
  const severityOrder: Record<string, number> = { warning: 0, negative: 1, info: 2, positive: 3 };
  insights.sort((a, b) => (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2));

  return insights;
}

// ─── Spending ────────────────────────────────────────────────────────────────

function analyzeSpending(expenses: Expense[], now: Date, insights: Insight[], timezone: string = DEFAULT_TIMEZONE) {
  // Bug fix: month boundaries must be evaluated in the user's timezone, not
  // server UTC. After 5pm PDT on the last day of the month, server UTC has
  // already rolled over and "this month" insights would silently drop today's
  // expenses. We compare YYYY-MM strings (timezone-stable since expenses
  // store local YYYY-MM-DD).
  // Category/total math comes from the canonical shared/spending-baseline
  // module (shared with weekly-review). Canonical deltas vs the old inline
  // copy: amounts are summed as Math.abs(Number(amount)) and empty categories
  // bucket under "uncategorized" — no practical change since the schema
  // enforces positive amounts and a non-empty category.
  const userYM = currentMonthYM(timezone);
  const monthlyExpenses = filterByWindow(expenses, { month: userYM });
  const monthTotal = totalSpend(monthlyExpenses);

  if (monthTotal > 0) {
    // Category breakdown
    const byCat = sumByCategory(monthlyExpenses);
    const sorted = topCategories(byCat);
    const topCat = sorted[0];

    insights.push({
      id: randomUUID(),
      type: "spending_trend",
      title: `$${monthTotal.toFixed(0)} spent this month`,
      description: `Top category: ${topCat[0]} ($${topCat[1].toFixed(0)}).${sorted.length > 1 ? ` Also: ${sorted.slice(1, 3).map(([c, a]) => `${c} ($${a.toFixed(0)})`).join(", ")}.` : ""}`,
      severity: monthTotal > 2000 ? "warning" : monthTotal > 1000 ? "info" : "positive",
      data: { total: monthTotal, topCategory: topCat[0], breakdown: byCat },
      createdAt: now.toISOString(),
    });

    // Day-of-month spending pace — use the user's local YYYY-MM (not server
    // UTC) so the projection doesn't reset at midnight UTC for non-UTC users.
    const [yyStr, mmStr, ddStr] = (new Date().toLocaleDateString('en-CA', { timeZone: timezone })).split('-');
    const thisYear = parseInt(yyStr, 10);
    const thisMonth = parseInt(mmStr, 10) - 1;
    const dayOfMonth = parseInt(ddStr, 10);
    const daysInMonth = new Date(thisYear, thisMonth + 1, 0).getDate();
    const pace = (monthTotal / dayOfMonth) * daysInMonth;
    if (pace > 3000) {
      insights.push({
        id: randomUUID(),
        type: "spending_trend",
        title: "High spending pace",
        description: `At this rate, you'll spend ~$${pace.toFixed(0)} by month end.`,
        severity: "warning",
        data: { projectedTotal: pace, currentTotal: monthTotal },
        createdAt: now.toISOString(),
      });
    }
  }

  // Compare to last month — canonical definition change: previously this
  // Date-parsed each expense and compared against the SERVER-local previous
  // month, while "this month" above used a user-timezone YYYY-MM string
  // compare — two different month definitions in the same function. Both now
  // use the canonical YYYY-MM string comparison from shared/spending-baseline
  // (user timezone), so boundary-dated expenses land in the same month for
  // both sides of the comparison.
  const lastYM = previousMonthYM(userYM);
  const lastTotal = totalSpend(expenses, { month: lastYM });
  if (lastTotal > 0 && monthTotal > 0) {
    const pctChange = ((monthTotal - lastTotal) / lastTotal) * 100;
    if (Math.abs(pctChange) > 20) {
      insights.push({
        id: randomUUID(),
        type: "spending_trend",
        title: pctChange > 0 ? "Spending up vs last month" : "Spending down vs last month",
        description: `${Math.abs(pctChange).toFixed(0)}% ${pctChange > 0 ? "more" : "less"} than last month ($${lastTotal.toFixed(0)}).`,
        severity: pctChange > 30 ? "warning" : pctChange > 0 ? "info" : "positive",
        data: { currentMonth: monthTotal, lastMonth: lastTotal, pctChange },
        createdAt: now.toISOString(),
      });
    }
  }
}

// ─── Streaks ─────────────────────────────────────────────────────────────────

function analyzeStreaks(habits: Habit[], todayStr: string, insights: Insight[]) {
  for (const habit of habits) {
    const checkedInToday = habit.checkins?.some(c => c.date === todayStr);

    // Streak at risk
    if (!checkedInToday && habit.currentStreak >= 3) {
      insights.push({
        id: randomUUID(),
        type: "habit_streak",
        title: `${habit.name} streak at risk!`,
        description: `${habit.currentStreak}-day streak — check in today to keep it alive.`,
        severity: habit.currentStreak >= 7 ? "warning" : "info",
        relatedEntityType: "habit",
        relatedEntityId: habit.id,
        data: { current: habit.currentStreak, longest: habit.longestStreak },
        createdAt: new Date().toISOString(),
      });
    }

    // Milestone celebrations
    if (habit.currentStreak > 0 && [7, 14, 21, 30, 60, 90, 100, 365].includes(habit.currentStreak)) {
      insights.push({
        id: randomUUID(),
        type: "streak",
        title: `${habit.currentStreak}-day ${habit.name} milestone!`,
        description: `You've maintained your ${habit.name} habit for ${habit.currentStreak} days straight.${habit.currentStreak === habit.longestStreak ? " This is your personal best!" : ""}`,
        severity: "positive",
        relatedEntityType: "habit",
        relatedEntityId: habit.id,
        data: { current: habit.currentStreak },
        createdAt: new Date().toISOString(),
      });
    }
  }
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

function analyzeTasks(tasks: Task[], now: Date, insights: Insight[], todayStr: string, timezone: string) {
  // Compare calendar days in the user's zone: a task due TODAY is not overdue.
  const overdue = tasks.filter(t => {
    if (t.status === "done") return false;
    const dueDay = localDayOf(t.dueDate, timezone);
    return !!dueDay && dueDay < todayStr;
  });
  if (overdue.length > 0) {
    insights.push({
      id: randomUUID(),
      type: "reminder",
      title: `${overdue.length} overdue task${overdue.length > 1 ? "s" : ""}`,
      description: overdue.slice(0, 3).map(t => t.title).join(", ") + (overdue.length > 3 ? ` +${overdue.length - 3} more` : ""),
      severity: "negative",
      data: { taskIds: overdue.map(t => t.id), count: overdue.length },
      createdAt: now.toISOString(),
    });
  }

  // Tasks due today
  const dueToday = tasks.filter(t => t.status !== "done" && localDayOf(t.dueDate, timezone) === todayStr);
  if (dueToday.length > 0) {
    insights.push({
      id: randomUUID(),
      type: "reminder",
      title: `${dueToday.length} task${dueToday.length > 1 ? "s" : ""} due today`,
      description: dueToday.map(t => t.title).join(", "),
      severity: "info",
      data: { taskIds: dueToday.map(t => t.id) },
      createdAt: now.toISOString(),
    });
  }

  // High-priority tasks
  const highPriority = tasks.filter(t => t.status !== "done" && t.priority === "high");
  if (highPriority.length > 0) {
    insights.push({
      id: randomUUID(),
      type: "reminder",
      title: `${highPriority.length} high-priority task${highPriority.length > 1 ? "s" : ""}`,
      description: highPriority.slice(0, 3).map(t => t.title).join(", "),
      severity: "warning",
      data: { taskIds: highPriority.map(t => t.id) },
      createdAt: now.toISOString(),
    });
  }
}

// ─── Documents ───────────────────────────────────────────────────────────────

function analyzeDocuments(documents: Document[], profiles: Profile[], todayStr: string, insights: Insight[]) {
  // The ONE Date Rule engine, the same selection the bell makes
  // (`isAlertDateRule`). This used to be a private ten-spelling expiry keyword
  // list over `extractedData`/`fields`, which every insurance policy's
  // `renewal_date` and every membership's `contract_end_date` slipped past,
  // and it counted days from the SERVER clock: at 5 PM Pacific a document
  // expiring today already read "expired 1 day ago".
  const now = new Date();
  for (const rule of rulesFromAll({ profiles, documents })) {
    if (!rule.active || !isAlertDateRule(rule)) continue;
    const diff = daysBetweenISO(todayStr, rule.date);
    if (diff > 30) continue;
    const [pastTitle, soonTitle, laterTitle, futureVerb, pastVerb] = dateRuleAlertWords(rule.ruleType);
    const isDoc = rule.sourceEntityType === "document";
    const key = rule.sourcePath || rule.sourceField;
    const name = rule.subtitle || rule.label;
    const shown = rule.rawValue || rule.date;
    const base = {
      id: randomUUID(),
      type: "reminder" as const,
      relatedEntityType: isDoc ? "document" : "profile",
      relatedEntityId: rule.sourceEntityId,
      createdAt: now.toISOString(),
    };
    if (diff < 0) {
      insights.push({
        ...base,
        title: `${pastTitle}: ${name}`,
        description: `${key} ${pastVerb} ${Math.abs(diff)} day${Math.abs(diff) !== 1 ? "s" : ""} ago (${shown})`,
        severity: "negative",
        data: { field: key, date: shown, daysOverdue: Math.abs(diff), ruleType: rule.ruleType },
      });
    } else {
      insights.push({
        ...base,
        title: `${diff <= 7 ? soonTitle : laterTitle}: ${name}`,
        description: `${key} ${futureVerb} ${diff === 0 ? "today" : `in ${diff} day${diff !== 1 ? "s" : ""}`} (${shown})`,
        severity: diff <= 7 ? "warning" : "info",
        data: { field: key, date: shown, daysUntil: diff, ruleType: rule.ruleType },
      });
    }
  }
}

// ─── Goals ───────────────────────────────────────────────────────────────────

function analyzeGoals(goals: Goal[], now: Date, todayStr: string, insights: Insight[]) {
  for (const goal of goals) {
    if (goal.status !== "active") continue;

    const progress = goal.target > 0 ? (goal.current / goal.target) * 100 : 0;

    // Nearly complete
    if (progress >= 80 && progress < 100) {
      insights.push({
        id: randomUUID(),
        type: "suggestion",
        title: `Almost there: ${goal.title}`,
        description: `${progress.toFixed(0)}% complete (${goal.current}/${goal.target} ${goal.unit}). Keep pushing!`,
        severity: "positive",
        relatedEntityType: "goal",
        relatedEntityId: goal.id,
        data: { progress, current: goal.current, target: goal.target },
        createdAt: now.toISOString(),
      });
    }

    // Deadline approaching with low progress. Calendar days from the USER's
    // today: counted from the server clock, a goal due today had already
    // "passed" by 5 PM Pacific and the card never showed on its last day.
    const deadlineDay = goal.deadline ? bareDateOf(goal.deadline) : null;
    if (deadlineDay) {
      const daysLeft = daysBetweenISO(todayStr, deadlineDay);
      if (daysLeft >= 0 && daysLeft <= 7 && progress < 50) {
        insights.push({
          id: randomUUID(),
          type: "reminder",
          title: `Goal deadline approaching: ${goal.title}`,
          description: `Only ${daysLeft} day${daysLeft !== 1 ? "s" : ""} left but only ${progress.toFixed(0)}% complete.`,
          severity: "warning",
          relatedEntityType: "goal",
          relatedEntityId: goal.id,
          data: { daysLeft, progress },
          createdAt: now.toISOString(),
        });
      } else if (daysLeft < 0 && progress < 100) {
        insights.push({
          id: randomUUID(),
          type: "reminder",
          title: `Goal overdue: ${goal.title}`,
          description: `Deadline was ${Math.abs(daysLeft)} days ago, ${progress.toFixed(0)}% complete.`,
          severity: "negative",
          relatedEntityType: "goal",
          relatedEntityId: goal.id,
          data: { daysOverdue: Math.abs(daysLeft), progress },
          createdAt: now.toISOString(),
        });
      }
    }

    // Completed goal
    if (progress >= 100) {
      insights.push({
        id: randomUUID(),
        type: "streak",
        title: `Goal completed: ${goal.title}`,
        description: `You've reached your target of ${goal.target} ${goal.unit}!`,
        severity: "positive",
        relatedEntityType: "goal",
        relatedEntityId: goal.id,
        data: { progress: 100, target: goal.target },
        createdAt: now.toISOString(),
      });
    }
  }
}

// ─── Health ──────────────────────────────────────────────────────────────────

function analyzeHealth(trackers: Tracker[], todayStr: string, now: Date, insights: Insight[]) {
  // Weight trends
  const weightTracker = trackers.find(t => t.name.toLowerCase().includes("weight") && t.category === "health");
  if (weightTracker && weightTracker.entries.length >= 3) {
    // Filter to realistic weight values (50-600 lbs) to avoid junk data skewing trends
    const validEntries = weightTracker.entries.filter(e => {
      const w = parseFloat(e.values.weight || e.values.value || "0");
      return w > 50 && w < 600;
    });
    const recent = validEntries.slice(-5);
    if (recent.length < 2) { /* skip */ } else {
    const firstVal = parseFloat(recent[0].values.weight || recent[0].values.value || "0");
    const lastVal = parseFloat(recent[recent.length - 1].values.weight || recent[recent.length - 1].values.value || "0");
    const diff = lastVal - firstVal;
    if (Math.abs(diff) > 0.5) {
      insights.push({
        id: randomUUID(),
        type: "health_correlation",
        title: diff < 0 ? "Weight trending down" : "Weight trending up",
        description: `${Math.abs(diff).toFixed(1)} lbs ${diff < 0 ? "decrease" : "increase"} over the last ${recent.length} entries.${diff < 0 ? " Great progress!" : ""}`,
        severity: diff < 0 ? "positive" : "info",
        relatedEntityType: "tracker",
        relatedEntityId: weightTracker.id,
        data: { change: diff, entries: recent.length },
        createdAt: now.toISOString(),
      });
    }
  } // end if recent.length >= 2
  } // end if weightTracker

  // Blood pressure alerts
  const bpTracker = trackers.find(t => t.name.toLowerCase().includes("blood pressure") || t.name.toLowerCase().includes("bp"));
  if (bpTracker && bpTracker.entries.length > 0) {
    const latest = bpTracker.entries[bpTracker.entries.length - 1];
    const sys = parseFloat(latest.values.systolic);
    const dia = parseFloat(latest.values.diastolic);
    if (sys >= 140 || dia >= 90) {
      insights.push({
        id: randomUUID(),
        type: "anomaly",
        title: "Elevated blood pressure",
        description: `Latest reading: ${sys}/${dia} — above recommended range.`,
        severity: "warning",
        relatedEntityType: "tracker",
        relatedEntityId: bpTracker.id,
        data: { systolic: sys, diastolic: dia },
        createdAt: now.toISOString(),
      });
    }
  }

  // Fitness streaks
  const fitnessTrackers = trackers.filter(t => t.category === "fitness");
  if (fitnessTrackers.length > 0) {
    const allEntries = fitnessTrackers.flatMap(t => t.entries).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    let streak = 0;
    const todayFitness = getUserToday();
    for (let i = 0; i < 30; i++) {
      const dayStr = tzAddDays(todayFitness, -i);
      if (allEntries.some(e => e.timestamp.slice(0, 10) === dayStr)) streak++;
      else if (i > 0) break;
    }
    if (streak >= 2) {
      insights.push({
        id: randomUUID(),
        type: "streak",
        title: `${streak}-day fitness streak`,
        description: `${streak >= 7 ? "Incredible consistency!" : streak >= 3 ? "Building momentum." : "Keep it going!"}`,
        severity: "positive",
        data: { streak },
        createdAt: now.toISOString(),
      });
    }
  }

  // Today's calories burned
  let totalCalsBurned = 0;
  for (const t of trackers) {
    for (const e of t.entries) {
      if (e.timestamp.slice(0, 10) === todayStr && e.computed?.caloriesBurned) {
        totalCalsBurned += e.computed.caloriesBurned;
      }
    }
  }
  if (totalCalsBurned > 0) {
    insights.push({
      id: randomUUID(),
      type: "health_correlation",
      title: `${totalCalsBurned} calories burned today`,
      description: totalCalsBurned > 500 ? "Great active day!" : "Every bit counts.",
      severity: "positive",
      data: { caloriesBurned: totalCalsBurned },
      createdAt: now.toISOString(),
    });
  }
}

// ─── Mood ────────────────────────────────────────────────────────────────────

function analyzeMood(journal: JournalEntry[], now: Date, insights: Insight[]) {
  const recentJournal = journal.filter(j => (now.getTime() - new Date(j.createdAt).getTime()) < 7 * 86400000);
  if (recentJournal.length >= 3) {
    // Bug #33: insights-engine had its OWN 1-5 mood-score table that disagreed
    // with the canonical MOOD_SCORES (1-8 scale, includes 'great', 'okay',
    // 'terrible'). Two consequences:
    //   - Moods like 'great', 'okay', 'terrible' silently scored 0 → default 3
    //     → wrongly dragged the weekly average toward neutral.
    //   - The thresholds (≤2.5 low / ≥4 great) were tuned for 1-5 scale and
    //     would never fire correctly with 1-8 inputs.
    // We now use the shared MOOD_SCORES and rescale the trigger thresholds to
    // the 1-8 range: low ≤ 3.5 (≈ 2.2 on the old 1-5 scale) and great ≥ 6
    // (≈ 4.0 on the old 1-5 scale).
    const avg = recentJournal.reduce((s, j) => s + (MOOD_SCORES[j.mood] || 4), 0) / recentJournal.length;
    if (avg <= 3.5) {
      insights.push({
        id: randomUUID(),
        type: "mood_trend",
        title: "Mood has been low this week",
        description: "Your journal entries suggest a tough stretch. Consider reaching out to someone or doing something you enjoy.",
        severity: "warning",
        data: { avgMood: avg, entries: recentJournal.length },
        createdAt: now.toISOString(),
      });
    } else if (avg >= 6) {
      insights.push({
        id: randomUUID(),
        type: "mood_trend",
        title: "Great mood this week",
        description: "You've been feeling positive. Keep doing what's working!",
        severity: "positive",
        data: { avgMood: avg, entries: recentJournal.length },
        createdAt: now.toISOString(),
      });
    }
  }
}

// ─── Obligations ─────────────────────────────────────────────────────────────

function analyzeObligations(obligations: Obligation[], now: Date, insights: Insight[], todayStr: string, timezone: string) {
  // nextDueDate is a date-only string. `new Date("YYYY-MM-DD") < now` is true
  // from 00:00 UTC on, so a bill due TODAY was reported as overdue (and left
  // out of "due this week") for the whole day. Compare calendar days instead.
  const weekOut = tzAddDays(todayStr, 7);
  const upcoming = obligations.filter(o => {
    const dueDay = localDayOf(o.nextDueDate, timezone);
    return !!dueDay && dueDay >= todayStr && dueDay <= weekOut;
  });
  if (upcoming.length > 0) {
    const totalDue = upcoming.reduce((s, o) => s + o.amount, 0);
    insights.push({
      id: randomUUID(),
      type: "obligation_due",
      title: `$${totalDue.toFixed(0)} in bills due this week`,
      description: upcoming.map(o => `${o.name}: $${o.amount}`).join(", "),
      severity: "warning",
      data: { obligations: upcoming.map(o => o.id), total: totalDue },
      createdAt: now.toISOString(),
    });
  }

  // Overdue bills
  const overdue = obligations.filter(o => {
    const dueDay = localDayOf(o.nextDueDate, timezone);
    return !!dueDay && dueDay < todayStr;
  });
  if (overdue.length > 0) {
    const totalOverdue = overdue.reduce((s, o) => s + o.amount, 0);
    insights.push({
      id: randomUUID(),
      type: "obligation_due",
      title: `${overdue.length} overdue bill${overdue.length > 1 ? "s" : ""}`,
      description: `$${totalOverdue.toFixed(0)} overdue: ${overdue.map(o => o.name).join(", ")}`,
      severity: "negative",
      data: { obligations: overdue.map(o => o.id), total: totalOverdue },
      createdAt: now.toISOString(),
    });
  }
}

// ─── Events ──────────────────────────────────────────────────────────────────

function analyzeEvents(events: CalendarEvent[], now: Date, insights: Insight[]) {
  const todayStrEvents = getUserToday();
  const todayEvents = events.filter(e => e.date.slice(0, 10) === todayStrEvents);
  if (todayEvents.length > 0) {
    insights.push({
      id: randomUUID(),
      type: "reminder",
      title: `${todayEvents.length} event${todayEvents.length > 1 ? "s" : ""} today`,
      description: todayEvents.map(e => `${e.title}${e.time ? ` at ${e.time}` : ""}`).join(", "),
      severity: "info",
      data: { eventIds: todayEvents.map(e => e.id) },
      createdAt: now.toISOString(),
    });
  }
}

// ─── Tracker Staleness ───────────────────────────────────────────────────────

function analyzeTrackerStaleness(trackers: Tracker[], now: Date, insights: Insight[]) {
  // Only flag trackers that have entries but are stale — skip zero-entry trackers
  const stale = trackers.filter(t => {
    if (t.entries.length === 0) return false; // Never had data — don't flag as stale
    const last = new Date(t.entries[t.entries.length - 1].timestamp);
    return (now.getTime() - last.getTime()) > 3 * 86400000;
  });
  if (stale.length > 0) {
    insights.push({
      id: randomUUID(),
      type: "suggestion",
      title: "Trackers need attention",
      description: `${stale.map(t => t.name).join(", ")} haven't been updated in 3+ days.`,
      severity: "info",
      data: { trackerIds: stale.map(t => t.id) },
      createdAt: new Date().toISOString(),
    });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function daysDiff(dateA: Date, dateB: Date): number {
  const a = new Date(dateA); a.setHours(0, 0, 0, 0);
  const b = new Date(dateB); b.setHours(0, 0, 0, 0);
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}
