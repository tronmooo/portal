import { describe, expect, it } from "vitest";
import { SupabaseStorage } from "../server/supabase-storage";

type QueryResult = { data: any[]; error: null };

function makeStorage(rowsByTable: Record<string, any[]>) {
  const inFilters: Array<{ table: string; column: string; values: string[] }> = [];
  const storage: any = Object.create(SupabaseStorage.prototype);
  storage.userId = "user-1";
  storage.getProfiles = async () => [];
  storage.supabase = {
    from(table: string) {
      const result: QueryResult = { data: rowsByTable[table] ?? [], error: null };
      const builder: any = {
        select() { return builder; },
        eq() { return builder; },
        is() { return builder; },
        gte() { return builder; },
        order() { return builder; },
        or() { return builder; },
        contains() { return builder; },
        in(column: string, values: string[]) {
          inFilters.push({ table, column, values });
          return builder;
        },
        then(resolve: (value: QueryResult) => unknown) {
          return resolve(result);
        },
      };
      return builder;
    },
  };
  return { storage, inFilters };
}

describe("scoped child history queries", () => {
  it("filters tracker entries to the fetched tracker IDs", async () => {
    const { storage, inFilters } = makeStorage({
      trackers: [
        { id: "tracker-a", user_id: "user-1", name: "Weight", fields: [] },
        { id: "tracker-b", user_id: "user-1", name: "Steps", fields: [] },
      ],
      tracker_entries: [],
    });

    await storage.getTrackers(120, ["profile-1"]);

    expect(inFilters).toContainEqual({
      table: "tracker_entries",
      column: "tracker_id",
      values: ["tracker-a", "tracker-b"],
    });
  });

  it("filters habit check-ins to the fetched habit IDs", async () => {
    const { storage, inFilters } = makeStorage({
      habits: [
        { id: "habit-a", user_id: "user-1", name: "Walk" },
        { id: "habit-b", user_id: "user-1", name: "Read" },
      ],
      habit_checkins: [],
    });

    await storage.getHabits(["profile-1"]);

    expect(inFilters).toContainEqual({
      table: "habit_checkins",
      column: "habit_id",
      values: ["habit-a", "habit-b"],
    });
  });
});
