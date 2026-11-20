// Storage double for the pay pipeline and the Auto Pay operations: profiles in
// a map, payments and expenses in arrays, and the compare-and-set occurrence
// claim the real storage has. Shared by the Auto Pay suites.
/** Storage double: the surface the pay pipeline and the Auto Pay operations use. */
export function fakeStorage(seed: any[]) {
  const profiles = new Map<string, any>(seed.map((p) => [p.id, JSON.parse(JSON.stringify(p))]));
  const expenses: any[] = [];
  let payments: any[] = [];
  let seq = 0;
  const mergeFields = (id: string, patch: Record<string, any>) => {
    const p = profiles.get(id);
    const fields = { ...(p.fields || {}) };
    for (const [k, v] of Object.entries(patch || {})) {
      if (v === null || v === undefined) delete fields[k]; else fields[k] = v;
    }
    profiles.set(id, { ...p, fields });
    return profiles.get(id);
  };
  const storage: any = {
    get expenses() { return expenses.filter((e) => !e.deletedAt); },
    get payments() { return payments; },
    getProfile: async (id: string) => profiles.get(id),
    getProfiles: async () => [...profiles.values()],
    updateProfile: async (id: string, patch: any) => (profiles.has(id) ? mergeFields(id, patch.fields || {}) : undefined),
    // The compare-and-set claim the real storage has: the occurrence is
    // stamped BEFORE the ledger row, and a second claimant is told so.
    claimBillOccurrence: async (id: string, date: string, stamp: any, extra: any) => {
      const p = profiles.get(id);
      const prior = { ...((p.fields || {}).occurrences || {}) };
      if (prior[date]?.status === "paid") return { status: "already-paid", occurrences: prior };
      mergeFields(id, { ...extra, occurrences: { ...prior, [date]: { ...(prior[date] || {}), ...stamp } } });
      return { status: "claimed", occurrences: prior };
    },
    updateOccurrenceOverride: async (id: string, date: string, patch: any) => {
      const p = profiles.get(id);
      if (!p) return null;
      const occ = { ...((p.fields || {}).occurrences || {}) };
      const merged: any = { ...(occ[date] || {}), ...patch };
      for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
      occ[date] = merged;
      mergeFields(id, { occurrences: occ });
      return { id, occurrences: occ };
    },
    rescheduleOccurrence: async (id: string, date: string, newDate: string) =>
      storage.updateOccurrenceOverride(id, date, { movedTo: newDate }),
    createLiabilityPayment: async (data: any) => {
      const row = { id: data.id || `pay-${++seq}`, ...data };
      payments = [row, ...payments];
      return row;
    },
    getLiabilityPayments: async (id: string) => payments.filter((p) => p.liabilityProfileId === id),
    getLiabilityPayment: async (id: string) => payments.find((p) => p.id === id),
    updateLiabilityPayment: async (id: string, patch: any) => {
      const row = payments.find((p) => p.id === id);
      if (!row) return undefined;
      Object.assign(row, patch);
      return row;
    },
    deleteLiabilityPayment: async (id: string) => {
      const before = payments.length;
      payments = payments.filter((p) => p.id !== id);
      return payments.length < before;
    },
    unmarkLoanPayment: async () => 0,
    adjustAccountBalance: async (id: string, input: any) => {
      const p = profiles.get(id);
      return mergeFields(id, { balance: (Number(p.fields.balance) || 0) + (Number(input.delta) || 0) });
    },
    createExpense: async (data: any) => {
      const row = { id: `exp-${expenses.length + 1}`, tags: [], linkedProfiles: [], ...data };
      expenses.push(row);
      return row;
    },
    getExpenses: async () => expenses.filter((e) => !e.deletedAt),
    updateExpense: async (id: string, patch: any) => {
      const e = expenses.find((x) => x.id === id);
      if (e) Object.assign(e, patch);
      return e;
    },
    deleteExpense: async (id: string) => {
      const e = expenses.find((x) => x.id === id);
      if (!e) return false;
      e.deletedAt = "now";
      return true;
    },
  };
  return storage;
}
