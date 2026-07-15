// Per-document 30-day snooze for expiring-document alerts. Client-side
// (localStorage) so no schema field is needed. Values are { docId: expiry-ms };
// entries past their expiry are dropped on read. Shared by the dashboard KPI
// section and the briefing's Document Expirations popup so a dismiss in one
// place hides the alert everywhere. The key is listed in
// USER_SCOPED_LOCAL_KEYS (queryClient.ts) so sign-out scrubs it.
export const DOC_SNOOZE_LS_KEY = "portol_doc_snooze_v1";

export function loadDocSnoozeMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(DOC_SNOOZE_LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, number>;
    const now = Date.now();
    let dirty = false;
    for (const k of Object.keys(parsed)) {
      if (parsed[k] <= now) { delete parsed[k]; dirty = true; }
    }
    if (dirty) localStorage.setItem(DOC_SNOOZE_LS_KEY, JSON.stringify(parsed));
    return parsed;
  } catch { return {}; }
}

export function saveDocSnoozeMap(m: Record<string, number>) {
  try { localStorage.setItem(DOC_SNOOZE_LS_KEY, JSON.stringify(m)); } catch {}
}
