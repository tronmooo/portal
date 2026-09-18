// tests/qa-2026-09-18-tasks-calendar.test.ts
//
// QA 2026-09-18, tasks & calendar (F-24..F-31). Each block pins one shared
// rule that a screen reads:
//
//   F-24  a task the speaker says THEY will do is the speaker's, the named
//         person is its subject — never its owner;
//   F-25  the Tasks page tiles come from the loaded list and are "no number"
//         until it exists;
//   F-26  "+N more" reveals the agenda panel (scrolls + focuses it);
//   F-27  one occurrence label for Recent Activity and the bell;
//   F-28  a bare birthday label event repeats yearly and carries the
//         Recurring Dates kind;
//   F-29  a migrated reminder whose series has ended folds away, and its
//         bookkeeping tag is not a chip;
//   F-31  link-to chips are grouped by type; only real people can own.
import { describe, it, expect, vi } from "vitest";
import { resolveTaskActor, clauseForTask } from "@shared/task-actor";
import { taskSummaryTiles, countTasksByDay } from "@shared/task-counts";
import { revealAgendaPanel } from "../client/src/components/calendar/reveal-agenda";
import { taskOccurrenceLabel } from "@shared/task-occurrences";
import { annualLabelEvent } from "@shared/birthday-event";
import { isMigrationTag, isRetiredMigratedReminderTask, MIGRATED_REMINDER_TAG } from "@shared/legacy-reminder-tasks";
import { groupProfilesForLinking, ownerCandidates } from "@shared/profile-link-groups";
import { nextPriority } from "../client/src/pages/tasks";

// ── F-24 ─────────────────────────────────────────────────────────────────────
describe("F-24: who does the task", () => {
  const msg = "my sister Dana lives in Austin, her number is 555-0100, and i need to call her about thanksgiving next tuesday";

  it("picks the clause that produced the task", () => {
    expect(clauseForTask(msg, "Call Dana about Thanksgiving")).toBe("i need to call her about thanksgiving next tuesday");
  });

  it("'I need to call her' is the speaker's task; Dana is the subject", () => {
    expect(resolveTaskActor({ title: "Call Dana about Thanksgiving", userMessage: msg, personName: "Dana" })).toBe("self");
    expect(resolveTaskActor({ title: "Book the groomer", userMessage: "Max needs a bath, I need to book the groomer", personName: "Max" })).toBe("self");
    expect(resolveTaskActor({ title: "Text Mom back", userMessage: "remind me to text Mom back", personName: "Mom" })).toBe("self");
  });

  it("the other person keeps the task when the sentence says THEY must do it", () => {
    expect(resolveTaskActor({ title: "Call the dentist", userMessage: "Dana needs to call the dentist", personName: "Dana" })).toBe("named");
    expect(resolveTaskActor({ title: "Book the dentist", userMessage: "remind Dana to book the dentist", personName: "Dana" })).toBe("named");
    expect(resolveTaskActor({ title: "Get groomed", userMessage: "Create a task for Max to get groomed", personName: "Max" })).toBe("named");
    expect(resolveTaskActor({ title: "Take out the bins", userMessage: "Sarah Miller has to take out the bins tonight", personName: "Sarah Miller" })).toBe("named");
    // Third person beats first person inside the same clause.
    expect(resolveTaskActor({ title: "Pack for camp", userMessage: "I think Dana has to pack for camp", personName: "Dana" })).toBe("named");
  });

  it("contacting someone is something the speaker does, even with no message", () => {
    expect(resolveTaskActor({ title: "Call Dana about Thanksgiving", personName: "Dana" })).toBe("self");
    expect(resolveTaskActor({ title: "Email Sarah the photos", personName: "Sarah Miller" })).toBe("self");
  });

  it("leaves the model's attribution alone when the sentence says nothing", () => {
    expect(resolveTaskActor({ title: "Collect $50 from Hop", userMessage: "Hop owes me $50", personName: "Hop" })).toBe("unspecified");
    expect(resolveTaskActor({ title: "Buy gift for Sarah", personName: "Sarah" })).toBe("unspecified");
  });

  it("the executor files a first-person task under self with the subject linked", () => {
    const src = require("fs").readFileSync(require("path").resolve(__dirname, "../server/ai-engine.ts"), "utf8");
    const block = src.slice(src.indexOf('case "create_task": {'), src.indexOf('case "complete_task": {'));
    expect(block).toContain("resolveTaskActor(");
    expect(block).toContain("taskLinkedProfiles = [self.id, target.id]");
  });
});

// ── F-25 ─────────────────────────────────────────────────────────────────────
describe("F-25: summary tiles come from the loaded list", () => {
  const today = "2026-09-18";
  const list = [
    { status: "todo", dueDate: "2026-09-01" }, { status: "todo", dueDate: "2026-09-10" },
    { status: "todo", dueDate: "2026-09-17" }, { status: "todo", dueDate: "2026-09-16" },
    { status: "todo", dueDate: "2026-09-25" }, { status: "todo", dueDate: "2026-10-01" },
    { status: "done", completedAt: "2026-09-18T15:00:00Z" },
  ];

  it("is no number at all — not zero — before the list arrives", () => {
    expect(taskSummaryTiles(undefined, today, "UTC")).toEqual({ overdue: null, dueToday: null, upcoming: null, doneToday: null });
    expect(taskSummaryTiles(null, today, "UTC").overdue).toBeNull();
  });

  it("matches the shared bucket rule on the same list the rows render from", () => {
    const tiles = taskSummaryTiles(list, today, "UTC");
    const c = countTasksByDay(list, today, "UTC");
    expect(tiles).toEqual({ overdue: 4, dueToday: 0, upcoming: 2, doneToday: 1 });
    expect(tiles).toEqual({ overdue: c.overdue, dueToday: c.dueToday, upcoming: c.upcoming, doneToday: c.doneToday });
    expect(taskSummaryTiles([], today, "UTC")).toEqual({ overdue: 0, dueToday: 0, upcoming: 0, doneToday: 0 });
  });

  it("the page renders the tiles as plain values, not a count-up from 0", () => {
    const src = require("fs").readFileSync(require("path").resolve(__dirname, "../client/src/pages/tasks.tsx"), "utf8");
    const band = src.slice(src.indexOf('data-testid="tasks-summary"'), src.indexOf("Tab filters"));
    expect(band).not.toContain("countTo=");
    expect(band).toContain("taskSummary.doneToday");
    expect(src).toContain("taskSummaryTiles(profileFilteredTasks");
  });
});

// ── F-26 ─────────────────────────────────────────────────────────────────────
describe("F-26: '+N more' reveals the agenda panel", () => {
  it("scrolls the panel into view and focuses it", () => {
    const el = { scrollIntoView: vi.fn(), focus: vi.fn() } as unknown as HTMLElement;
    expect(revealAgendaPanel(el, (fn) => fn())).toBe(true);
    expect((el as any).scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "nearest" });
    expect((el as any).focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("is a no-op without a panel", () => {
    expect(revealAgendaPanel(null, (fn) => fn())).toBe(false);
  });

  it("the month grid's more-button calls it", () => {
    const src = require("fs").readFileSync(require("path").resolve(__dirname, "../client/src/components/CalendarView.tsx"), "utf8");
    const i = src.indexOf("btn-more-${day.date}");
    expect(src.slice(i - 600, i)).toContain("revealAgendaPanel(agendaRef.current)");
    expect(src).toContain('<aside ref={agendaRef} tabIndex={-1}');
  });
});

// ── F-27 ─────────────────────────────────────────────────────────────────────
describe("F-27: one occurrence label for a repeating task", () => {
  const now = new Date("2026-09-18T12:00:00");
  it("names the occurrence of a repeating task, bare title for a one-off", () => {
    expect(taskOccurrenceLabel({ title: "Put out the trash", dueDate: "2026-09-16", tags: ["recur:weekly"] }, now)).toBe("Put out the trash (Sep 16)");
    expect(taskOccurrenceLabel({ title: "Mow the lawn", dueDate: "2025-08-18", tags: ["recur:weekly", "rdone:2"] }, now)).toBe("Mow the lawn (Aug 18, 2025)");
    expect(taskOccurrenceLabel({ title: "Renew passport", dueDate: "2026-09-16", tags: [] }, now)).toBe("Renew passport");
    expect(taskOccurrenceLabel({ title: "Undated chore", dueDate: null, tags: ["recur:daily"] }, now)).toBe("Undated chore");
  });

  it("Recent Activity and the bell both read it", () => {
    const fs = require("fs"); const path = require("path");
    for (const f of ["server/supabase-storage.ts", "server/storage.ts"]) {
      const src = fs.readFileSync(path.resolve(__dirname, "..", f), "utf8");
      expect(src).toContain("`Completed: ${taskOccurrenceLabel(t)}`");
      expect(src).not.toContain("`Completed: ${t.title}`");
    }
    const notif = fs.readFileSync(path.resolve(__dirname, "../server/notification-service.ts"), "utf8");
    expect(notif).toContain("title: `Overdue: ${occurrence}`");
  });
});

// ── F-28 ─────────────────────────────────────────────────────────────────────
describe("F-28: a birthday told to the chat repeats yearly", () => {
  it("a bare label is yearly and carries the Recurring Dates kind", () => {
    expect(annualLabelEvent("Dana's Birthday")).toEqual({ kind: "birthday", name: "Dana", recurrence: "yearly", tags: ["rdate", "rd:kind:birthday"] });
    expect(annualLabelEvent("🎂 Dana's Birthday", ["family"])?.tags).toEqual(["family", "rdate", "rd:kind:birthday"]);
    expect(annualLabelEvent("Our Anniversary")?.kind).toBe("anniversary");
  });
  it("a party or errand is not a label", () => {
    expect(annualLabelEvent("Dana's 40th Birthday Bash")).toBeNull();
    expect(annualLabelEvent("Buy Dana a birthday card")).toBeNull();
    expect(annualLabelEvent("")).toBeNull();
  });
  it("the event executor applies it", () => {
    const src = require("fs").readFileSync(require("path").resolve(__dirname, "../server/ai-engine.ts"), "utf8");
    const block = src.slice(src.indexOf('case "create_event": {'), src.indexOf('case "update_event": {'));
    expect(block).toContain("annualLabelEvent(input.title)");
    expect(block).toContain("evtRecurrence = annual.recurrence");
    expect(block).toContain("tags: evtTags");
  });
});

// ── F-29 ─────────────────────────────────────────────────────────────────────
describe("F-29: retired migrated reminders fold away", () => {
  const today = "2026-09-18";
  it("a migrated reminder whose series ended is retired; a live or hand-made one is not", () => {
    expect(isRetiredMigratedReminderTask({ tags: [MIGRATED_REMINDER_TAG, "recur:daily", "runtil:2026-08-11"] }, today)).toBe(true);
    expect(isRetiredMigratedReminderTask({ tags: [MIGRATED_REMINDER_TAG, "recur:daily", "runtil:2026-12-31"] }, today)).toBe(false);
    expect(isRetiredMigratedReminderTask({ tags: [MIGRATED_REMINDER_TAG] }, today)).toBe(false);
    expect(isRetiredMigratedReminderTask({ tags: ["recur:daily", "runtil:2026-08-11"] }, today)).toBe(false);
    expect(isRetiredMigratedReminderTask({ tags: null }, today)).toBe(false);
  });
  it("the migration's tag is not a chip", () => {
    expect(isMigrationTag("migrated:reminder")).toBe(true);
    expect(isMigrationTag("work")).toBe(false);
  });
  it("the Tasks page applies both", () => {
    const src = require("fs").readFileSync(require("path").resolve(__dirname, "../client/src/pages/tasks.tsx"), "utf8");
    expect(src).toContain("isRetiredMigratedReminderTask(t, todayStr)");
    expect(src).toContain("userTags(task.tags).filter(tag => !isMigrationTag(tag))");
  });
});

// ── F-30 ─────────────────────────────────────────────────────────────────────
describe("F-30: inline row edits", () => {
  it("priority cycles low → medium → high → low", () => {
    expect(nextPriority("low")).toBe("medium");
    expect(nextPriority("medium")).toBe("high");
    expect(nextPriority("high")).toBe("low");
    expect(nextPriority(undefined)).toBe("high");
  });
  it("the row carries a due-date picker and a priority control", () => {
    const src = require("fs").readFileSync(require("path").resolve(__dirname, "../client/src/pages/tasks.tsx"), "utf8");
    expect(src).toContain("input-task-due-inline-${task.id}");
    expect(src).toContain("btn-task-priority-${task.id}");
    expect(src).toContain("patchMutation.mutate({ dueDate: next || null })");
  });
});

// ── F-31 ─────────────────────────────────────────────────────────────────────
describe("F-31: event owner and grouped link chips", () => {
  const profiles = [
    { id: "ram", name: "tires for my Dodge ram", type: "asset" },
    { id: "dana", name: "Dana", type: "person" },
    { id: "me", name: "Me", type: "self" },
    { id: "rent", name: "Rent", type: "liability" },
    { id: "car", name: "Honda Civic", type: "vehicle" },
    { id: "home", name: "12 Elm St", type: "property" },
    { id: "max", name: "Max", type: "pet" },
    { id: "adam", name: "Adam", type: "person" },
    { id: "weird", name: "Mystery", type: "widget" },
  ];

  it("only real people can be the owner, self first then by name", () => {
    expect(ownerCandidates(profiles).map((p) => p.id)).toEqual(["me", "adam", "dana", "max"]);
  });

  it("groups and labels the chips by type, sorted inside each group", () => {
    const groups = groupProfilesForLinking(profiles);
    expect(groups.map((g) => g.label)).toEqual(["People", "Vehicles", "Places", "Bills & accounts", "Assets", "Other"]);
    expect(groups[0].items.map((p) => p.id)).toEqual(["me", "adam", "dana", "max"]);
    expect(groups.find((g) => g.id === "assets")?.items.map((p) => p.name)).toEqual(["tires for my Dodge ram"]);
    expect(groups.find((g) => g.id === "other")?.items.map((p) => p.id)).toEqual(["weird"]);
    expect(groupProfilesForLinking([])).toEqual([]);
  });

  it("the New Event dialog has a For field and grouped chips", () => {
    const src = require("fs").readFileSync(require("path").resolve(__dirname, "../client/src/components/CalendarView.tsx"), "utf8");
    expect(src).toContain('data-testid="select-event-owner"');
    expect(src).toContain("event-link-group-${g.id}");
    expect(src).toContain("useActiveCreateProfileId(profiles)");
  });
});
