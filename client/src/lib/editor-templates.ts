// Starter templates for the doc/sheet editor. The Doc template's content is
// raw HTML (Tiptap-compatible) and gets sanitized through DOMPurify before
// being saved. The Sheet template returns a sparse cells map keyed "row,col".

import type { SheetCell, SheetData } from "@shared/schema";

export interface DocTemplate {
  id: string;
  label: string;
  description: string;
  type: "doc";
  title: string;
  html: string;
}

export interface SheetTemplate {
  id: string;
  label: string;
  description: string;
  type: "sheet";
  title: string;
  rows: number;
  cols: number;
  cells: Record<string, SheetCell>;
}

export type EditorTemplate = DocTemplate | SheetTemplate;

// ── Helpers to build sheet cells terselyq ────────────────────────────────────
function cell(value: string | number): SheetCell {
  return typeof value === "string" && value.startsWith("=") ? { f: value } : { v: value };
}
function row(cellsByCol: Record<number, SheetCell>): Record<number, SheetCell> {
  return cellsByCol;
}
function buildSheet(rowsArr: Array<Record<number, SheetCell>>, rows: number, cols: number) {
  const cells: Record<string, SheetCell> = {};
  rowsArr.forEach((rowMap, r) => {
    Object.entries(rowMap).forEach(([col, c]) => {
      cells[`${r},${col}`] = c;
    });
  });
  return { rows, cols, cells };
}

// ── Doc templates ────────────────────────────────────────────────────────────
const meetingNotes: DocTemplate = {
  id: "meeting-notes",
  label: "Meeting notes",
  description: "Attendees, agenda, decisions, action items.",
  type: "doc",
  title: "Meeting notes",
  html: `
    <h1>Meeting notes</h1>
    <p><strong>Date:</strong> </p>
    <p><strong>Attendees:</strong> </p>
    <h2>Agenda</h2>
    <ul><li>Item 1</li><li>Item 2</li></ul>
    <h2>Discussion</h2>
    <p></p>
    <h2>Decisions</h2>
    <ul><li></li></ul>
    <h2>Action items</h2>
    <ul><li>[ ] Owner — task — due date</li></ul>
  `,
};

const weeklyReview: DocTemplate = {
  id: "weekly-review",
  label: "Weekly review",
  description: "Wins, challenges, focus, top 3 next week.",
  type: "doc",
  title: "Weekly review",
  html: `
    <h1>Weekly review</h1>
    <p><strong>Week of:</strong> </p>
    <h2>Wins</h2>
    <ul><li></li><li></li><li></li></ul>
    <h2>Challenges</h2>
    <ul><li></li></ul>
    <h2>What I learned</h2>
    <p></p>
    <h2>Top 3 priorities next week</h2>
    <ol><li></li><li></li><li></li></ol>
  `,
};

const dailyJournal: DocTemplate = {
  id: "daily-journal",
  label: "Daily journal",
  description: "Mood, gratitude, today's three things.",
  type: "doc",
  title: "Journal entry",
  html: `
    <h1>Journal — </h1>
    <h2>How am I feeling?</h2>
    <p></p>
    <h2>Three things I'm grateful for</h2>
    <ol><li></li><li></li><li></li></ol>
    <h2>Today, I want to…</h2>
    <ul><li></li><li></li><li></li></ul>
    <h2>Notes</h2>
    <p></p>
  `,
};

const projectPlan: DocTemplate = {
  id: "project-plan",
  label: "Project plan",
  description: "Goal, scope, milestones, risks.",
  type: "doc",
  title: "Project plan",
  html: `
    <h1>Project plan</h1>
    <h2>Goal</h2>
    <p></p>
    <h2>Scope</h2>
    <ul><li>In scope: </li><li>Out of scope: </li></ul>
    <h2>Milestones</h2>
    <ol><li>M1 — </li><li>M2 — </li><li>M3 — </li></ol>
    <h2>Risks &amp; mitigations</h2>
    <ul><li></li></ul>
    <h2>Open questions</h2>
    <ul><li></li></ul>
  `,
};

const tripPlanner: DocTemplate = {
  id: "trip-planner",
  label: "Trip planner",
  description: "Itinerary, packing list, budget.",
  type: "doc",
  title: "Trip planner",
  html: `
    <h1>Trip — </h1>
    <p><strong>Dates:</strong> </p>
    <p><strong>Destination:</strong> </p>
    <h2>Itinerary</h2>
    <ul><li>Day 1: </li><li>Day 2: </li></ul>
    <h2>Packing list</h2>
    <ul><li>Passport / ID</li><li>Charger</li><li>Toiletries</li></ul>
    <h2>Budget</h2>
    <ul><li>Flights: </li><li>Lodging: </li><li>Food: </li></ul>
    <h2>Reservations</h2>
    <p></p>
  `,
};

// ── Sheet templates ──────────────────────────────────────────────────────────
const monthlyBudget: SheetTemplate = {
  id: "monthly-budget",
  label: "Monthly budget",
  description: "Income, expenses by category, totals.",
  type: "sheet",
  title: "Monthly budget",
  ...buildSheet([
    row({ 0: cell("Category"), 1: cell("Budgeted"), 2: cell("Actual"), 3: cell("Difference") }),
    row({ 0: cell("Rent / Mortgage"), 1: cell(0), 2: cell(0), 3: cell("=B2-C2") }),
    row({ 0: cell("Groceries"), 1: cell(0), 2: cell(0), 3: cell("=B3-C3") }),
    row({ 0: cell("Utilities"), 1: cell(0), 2: cell(0), 3: cell("=B4-C4") }),
    row({ 0: cell("Transport"), 1: cell(0), 2: cell(0), 3: cell("=B5-C5") }),
    row({ 0: cell("Restaurants"), 1: cell(0), 2: cell(0), 3: cell("=B6-C6") }),
    row({ 0: cell("Subscriptions"), 1: cell(0), 2: cell(0), 3: cell("=B7-C7") }),
    row({ 0: cell("Entertainment"), 1: cell(0), 2: cell(0), 3: cell("=B8-C8") }),
    row({ 0: cell("Other"), 1: cell(0), 2: cell(0), 3: cell("=B9-C9") }),
    row({ 0: cell("Total"), 1: cell("=SUM(B2:B9)"), 2: cell("=SUM(C2:C9)"), 3: cell("=SUM(D2:D9)") }),
  ], 30, 8),
};

const expenseLog: SheetTemplate = {
  id: "expense-log",
  label: "Expense log",
  description: "Date, vendor, category, amount, notes.",
  type: "sheet",
  title: "Expense log",
  ...buildSheet([
    row({ 0: cell("Date"), 1: cell("Vendor"), 2: cell("Category"), 3: cell("Amount"), 4: cell("Notes") }),
  ], 60, 6),
};

const workoutLog: SheetTemplate = {
  id: "workout-log",
  label: "Workout log",
  description: "Date, exercise, sets, reps, weight, notes.",
  type: "sheet",
  title: "Workout log",
  ...buildSheet([
    row({ 0: cell("Date"), 1: cell("Exercise"), 2: cell("Sets"), 3: cell("Reps"), 4: cell("Weight (lb)"), 5: cell("Notes") }),
  ], 60, 7),
};

const taskTracker: SheetTemplate = {
  id: "task-tracker",
  label: "Task tracker",
  description: "Task, owner, status, due date, priority.",
  type: "sheet",
  title: "Task tracker",
  ...buildSheet([
    row({ 0: cell("Task"), 1: cell("Owner"), 2: cell("Status"), 3: cell("Due"), 4: cell("Priority") }),
  ], 60, 6),
};

// ── Public API ───────────────────────────────────────────────────────────────
export const DOC_TEMPLATES: DocTemplate[] = [
  meetingNotes, weeklyReview, dailyJournal, projectPlan, tripPlanner,
];
export const SHEET_TEMPLATES: SheetTemplate[] = [
  monthlyBudget, expenseLog, workoutLog, taskTracker,
];

export function getTemplatesByType(type: "doc" | "sheet"): EditorTemplate[] {
  return type === "doc" ? DOC_TEMPLATES : SHEET_TEMPLATES;
}
