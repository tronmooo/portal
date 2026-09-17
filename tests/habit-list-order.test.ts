import { describe, it, expect } from "vitest";
import { SupabaseStorage } from "../server/supabase-storage";

// Regression: "I marked my bathroom habit off and it disappeared."
//
// Checking a habit in UPDATEs its row (current_streak / longest_streak). An
// unordered SELECT returns heap order, so the updated row moved within the
// list — and the dashboard, which renders only the first few habits, dropped
// the habit the user had just tapped. The habit was fine (1 of 3); it had just
// fallen off the visible end of the list.
//
// The contract: the habits query is explicitly ordered on columns a check-in
// never touches, so a habit's position is stable across check-ins.

function makeStorage() {
  const orders: Array<{ table: string; column: string; ascending: boolean }> = [];
  const rows = [
    { id: "h-1", name: "Bathroom", target_per_day: 3, created_at: "2026-01-01T00:00:00Z", frequency: "daily" },
    { id: "h-2", name: "Brush Teeth", target_per_day: 2, created_at: "2026-02-01T00:00:00Z", frequency: "daily" },
  ];

  const builder = (table: string, data: any[]): any => {
    const self: any = {
      select: () => self,
      eq: () => self,
      is: () => self,
      in: () => self,
      gte: () => self,
      order: (column: string, opts?: { ascending?: boolean }) => {
        orders.push({ table, column, ascending: opts?.ascending !== false });
        return self;
      },
      then: (resolve: any, reject: any) => Promise.resolve({ data, error: null }).then(resolve, reject),
    };
    return self;
  };

  const storage: any = Object.create(SupabaseStorage.prototype);
  storage.userId = "user-1";
  storage.supabase = { from: (table: string) => builder(table, table === "habits" ? rows : []) };
  storage.memo = (_key: string, fn: () => any) => fn();
  storage._fk = () => "";
  storage.pushdownIds = async () => undefined;
  storage._applyProfileFilter = (q: any) => q;
  return { storage, orders };
}

describe("getHabits — stable list order", () => {
  it("orders the habits query deterministically so a check-in cannot reshuffle the list", async () => {
    const { storage, orders } = makeStorage();
    const habits = await storage.getHabits();

    const habitOrders = orders.filter((o) => o.table === "habits");
    expect(habitOrders.map((o) => o.column)).toEqual(["created_at", "id"]);
    // Oldest first, with id as the tiebreak for rows created in the same tick.
    expect(habitOrders.every((o) => o.ascending)).toBe(true);
    expect(habits.map((h: any) => h.id)).toEqual(["h-1", "h-2"]);
  });
});
