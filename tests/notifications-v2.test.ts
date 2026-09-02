// ── Notifications v2 unit tests ──────────────────────────────────────────────
// Custom (persisted) rows merge into the computed bell list under the
// 'custom:' id namespace, and notification_prefs mutes filter the output.
import { describe, it, expect } from "vitest";
import { buildNotifications, NOTIFICATION_PREFS_PREF, DISMISSED_NOTIFICATIONS_PREF } from "../server/notification-service";

function stubStorage(overrides: Record<string, any> = {}): any {
  const prefs = new Map<string, string>();
  return {
    _prefs: prefs,
    getDocuments: async () => [],
    getProfiles: async () => [],
    getTasks: async () => [],
    getObligations: async () => [],
    getHabits: async () => [],
    listReminders: async () => [],
    listUserNotifications: async () => [],
    getPreference: async (k: string) => prefs.get(k) ?? null,
    setPreference: async (k: string, v: string) => { prefs.set(k, v); },
    ...overrides,
  };
}

const OVERDUE_TASK = {
  id: "t1", title: "File taxes", status: "todo", priority: "high",
  dueDate: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10),
};

describe("buildNotifications — custom rows", () => {
  it("merges custom rows under the custom: namespace with read state", async () => {
    const storage = stubStorage({
      listUserNotifications: async () => [
        { id: "abc", title: "Insurance renewal", message: "Renew by August", severity: "warning", readAt: null },
        { id: "def", title: "FYI", message: "", severity: "info", readAt: "2026-07-10T00:00:00Z" },
      ],
    });
    const list = await buildNotifications(storage, "America/New_York");
    const custom = list.filter((n) => n.type === "custom");
    expect(custom.map((n) => n.id).sort()).toEqual(["custom:abc", "custom:def"]);
    expect(custom.find((n) => n.id === "custom:abc")!.read).toBe(false);
    expect(custom.find((n) => n.id === "custom:def")!.read).toBe(true);
  });

  it("clamps unknown severities to info", async () => {
    const storage = stubStorage({
      listUserNotifications: async () => [{ id: "x", title: "Weird", message: "", severity: "apocalyptic", readAt: null }],
    });
    const list = await buildNotifications(storage, "America/New_York");
    expect(list.find((n) => n.id === "custom:x")!.severity).toBe("info");
  });

  it("survives a storage without the custom table (best-effort)", async () => {
    const storage = stubStorage({ listUserNotifications: async () => { throw new Error("no table"); } });
    await expect(buildNotifications(storage, "America/New_York")).resolves.toEqual([]);
  });
});

describe("buildNotifications — notification_prefs mutes", () => {
  it("drops muted severities and types", async () => {
    const storage = stubStorage({
      getTasks: async () => [OVERDUE_TASK], // computed critical task_overdue
      listUserNotifications: async () => [
        { id: "n1", title: "Custom info", message: "", severity: "info", readAt: null },
      ],
    });
    // No mutes: both present.
    let list = await buildNotifications(storage, "America/New_York");
    expect(list.some((n) => n.type === "task_overdue")).toBe(true);
    expect(list.some((n) => n.type === "custom")).toBe(true);

    // Mute info severity: the custom info row disappears, the critical stays.
    storage._prefs.set(NOTIFICATION_PREFS_PREF, JSON.stringify({ muted_severities: ["info"] }));
    list = await buildNotifications(storage, "America/New_York");
    expect(list.some((n) => n.type === "task_overdue")).toBe(true);
    expect(list.some((n) => n.type === "custom")).toBe(false);

    // Mute the task_overdue type instead.
    storage._prefs.set(NOTIFICATION_PREFS_PREF, JSON.stringify({ muted_types: ["task_overdue"] }));
    list = await buildNotifications(storage, "America/New_York");
    expect(list.some((n) => n.type === "task_overdue")).toBe(false);
    expect(list.some((n) => n.type === "custom")).toBe(true);
  });

  it("ignores an unparseable prefs value", async () => {
    const storage = stubStorage({ getTasks: async () => [OVERDUE_TASK] });
    storage._prefs.set(NOTIFICATION_PREFS_PREF, "{not json");
    const list = await buildNotifications(storage, "America/New_York");
    expect(list.some((n) => n.type === "task_overdue")).toBe(true);
  });
});

// D34: dismissal is applied at the source, not only in the bell's own filter.
// The chat read the unfiltered list and called a just-dismissed notification
// "currently active".
describe("buildNotifications — dismissed ids", () => {
  it("drops a dismissed computed notification and keeps the rest", async () => {
    const storage = stubStorage({
      getTasks: async () => [OVERDUE_TASK, { ...OVERDUE_TASK, id: "t2", title: "Renew tags" }],
    });
    let list = await buildNotifications(storage, "America/New_York");
    expect(list.map((n) => n.id).sort()).toEqual(["task-overdue-t1", "task-overdue-t2"]);
    storage._prefs.set(DISMISSED_NOTIFICATIONS_PREF, JSON.stringify(["task-overdue-t1"]));
    list = await buildNotifications(storage, "America/New_York");
    expect(list.map((n) => n.id)).toEqual(["task-overdue-t2"]);
  });
  it("a malformed preference dismisses nothing", async () => {
    const storage = stubStorage({ getTasks: async () => [OVERDUE_TASK] });
    storage._prefs.set(DISMISSED_NOTIFICATIONS_PREF, "{not json");
    const list = await buildNotifications(storage, "America/New_York");
    expect(list.length).toBe(1);
  });
});
