import { randomUUID } from "crypto";
import type {
  Insight, Profile, Tracker, Task, Expense, Habit, Obligation,
  JournalEntry, Document, Goal, CalendarEvent,
} from "@shared/schema";
import { getUserToday, addDays as tzAddDays, DEFAULT_TIMEZONE } from "@shared/timezone";

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
  analyzeSpending(data.expenses, now, insights);

  // --- Streak Warnings ---
  analyzeStreaks(data.habits, todayStr, insights);

  // --- Task Reminders ---
  analyzeTasks(data.tasks, now, insights);

  // --- Document Expirations ---
  analyzeDocuments(data.documents, data.profiles, now, insights);

  // --- Goal Progress ---
  analyzeGoals(data.goals, now, insights);

  // --- Health Trends ---
  analyzeHealth(data.trackers, todayStr, now, insights);

  // --- Mood Trends ---
  analyzeMood(data.journal, now, insights);

  // --- Obligation Alerts ---
  analyzeObligations(data.obligations, now, insights);

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

function analyzeSpending(expenses: Expense[], now: Date, insights: Insight[]) {
  const thisMonth = now.getMonth();
  const thisYear = now.getFullYear();
  const monthlyExpenses = expenses.filter(e => {
    const d = new Date(e.date);
    return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
  });
  const monthTotal = monthlyExpenses.reduce((s, e) => s + e.amount, 0);

  if (monthTotal > 0) {
    // Category breakdown
    const byCat: Record<string, number> = {};
    for (const e of monthlyExpenses) {
      byCat[e.category] = (byCat[e.category] || 0) + e.amount;
    }
    const sorted = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
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

    // Day-of-month spending pace
    const dayOfMonth = now.getDate();
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

  // Compare to last month
  const lastMonth = new Date(now);
  lastMonth.setMonth(lastMonth.getMonth() - 1);
  const lastMonthExpenses = expenses.filter(e => {
    const d = new Date(e.date);
    return d.getMonth() === lastMonth.getMonth() && d.getFullYear() === lastMonth.getFullYear();
  });
  const lastTotal = lastMonthExpenses.reduce((s, e) => s + e.amount, 0);
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

function analyzeTasks(tasks: Task[], now: Date, insights: Insight[]) {
  const overdue = tasks.filter(t => t.status !== "done" && t.dueDate && new Date(t.dueDate) < now);
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
  const todayStr = getUserToday();
  const dueToday = tasks.filter(t => t.status !== "done" && t.dueDate?.slice(0, 10) === todayStr);
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

function analyzeDocuments(documents: Document[], profiles: Profile[], now: Date, insights: Insight[]) {
  const expirationKeywords = ["expir", "exp date", "exp_date", "expdate", "valid until", "valid through", "valid_until", "valid_through", "expires", "expiration"];

  const checkFields = (fields: Record<string, any>, entityId: string, entityType: string, entityName: string) => {
    for (const [key, value] of Object.entries(fields)) {
      if (!value || typeof value !== "string") continue;
      const keyLower = key.toLowerCase();
      if (!expirationKeywords.some(kw => keyLower.includes(kw))) continue;
      const expDate = parseFlexDate(value);
      if (!expDate) continue;
      const diff = daysDiff(expDate, now);
      if (diff < 0) {
        insights.push({
          id: randomUUID(),
          type: "reminder",
          title: `Expired: ${entityName}`,
          description: `${key} expired ${Math.abs(diff)} day${Math.abs(diff) !== 1 ? "s" : ""} ago (${value})`,
          severity: "negative",
          relatedEntityType: entityType,
          relatedEntityId: entityId,
          data: { field: key, date: value, daysOverdue: Math.abs(diff) },
          createdAt: now.toISOString(),
        });
      } else if (diff <= 30) {
        insights.push({
          id: randomUUID(),
          type: "reminder",
          title: `${diff <= 7 ? "Expiring soon" : "Expiring"}: ${entityName}`,
          description: `${key} expires in ${diff} day${diff !== 1 ? "s" : ""} (${value})`,
          severity: diff <= 7 ? "warning" : "info",
          relatedEntityType: entityType,
          relatedEntityId: entityId,
          data: { field: key, date: value, daysUntil: diff },
          createdAt: now.toISOString(),
        });
      }
    }
  };

  for (const doc of documents) {
    if (doc.extractedData && typeof doc.extractedData === "object") {
      checkFields(doc.extractedData, doc.id, "document", doc.name);
    }
  }
  for (const profile of profiles) {
    // Skip self profile — self's expiration fields are usually driver's license data, not meaningful alerts
    if (profile.type === "self") continue;
    if (profile.fields && typeof profile.fields === "object") {
      checkFields(profile.fields as Record<string, any>, profile.id, "profile", profile.name);
    }
  }
}

// ─── Goals ───────────────────────────────────────────────────────────────────

function analyzeGoals(goals: Goal[], now: Date, insights: Insight[]) {
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

    // Deadline approaching with low progress
    if (goal.deadline) {
      const deadline = new Date(goal.deadline);
      const daysLeft = daysDiff(deadline, now);
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
    const moodScores: Record<string, number> = { amazing: 5, good: 4, neutral: 3, bad: 2, awful: 1 };
    const avg = recentJournal.reduce((s, j) => s + (moodScores[j.mood] || 3), 0) / recentJournal.length;
    if (avg <= 2.5) {
      insights.push({
        id: randomUUID(),
        type: "mood_trend",
        title: "Mood has been low this week",
        description: "Your journal entries suggest a tough stretch. Consider reaching out to someone or doing something you enjoy.",
        severity: "warning",
        data: { avgMood: avg, entries: recentJournal.length },
        createdAt: now.toISOString(),
      });
    } else if (avg >= 4) {
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

function analyzeObligations(obligations: Obligation[], now: Date, insights: Insight[]) {
  const sevenDaysOut = new Date(now.getTime() + 7 * 86400000);
  const upcoming = obligations.filter(o => {
    const due = new Date(o.nextDueDate);
    return due >= now && due <= sevenDaysOut;
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
  const overdue = obligations.filter(o => new Date(o.nextDueDate) < now);
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

function parseFlexDate(val: string): Date | null {
  if (!val || typeof val !== "string") return null;
  const trimmed = val.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const d = new Date(trimmed);
    return isNaN(d.getTime()) ? null : d;
  }
  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashMatch) {
    const d = new Date(Number(slashMatch[3]), Number(slashMatch[1]) - 1, Number(slashMatch[2]));
    return isNaN(d.getTime()) ? null : d;
  }
  const dashMatch = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (dashMatch) {
    const d = new Date(Number(dashMatch[3]), Number(dashMatch[1]) - 1, Number(dashMatch[2]));
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(trimmed);
  return isNaN(d.getTime()) ? null : d;
}

function daysDiff(dateA: Date, dateB: Date): number {
  const a = new Date(dateA); a.setHours(0, 0, 0, 0);
  const b = new Date(dateB); b.setHours(0, 0, 0, 0);
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}
