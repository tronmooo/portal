// Display-level bill dedupe. Lives in its own module (rather than beside the
// Bills UI in components/dashboard/BriefingPopups.tsx) so callers that only
// need the helper — the Executive briefing computes its bill counts on every
// render — don't drag the whole popup bundle onto the first-paint path.
const normName = (s: any) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** "Verizon Phone Bill payment" and "Phone Bill payment" at the same $86.50 are
 *  one bill entered twice. Collapses rows only when the amounts match exactly
 *  AND the normalized names match or nest — "rent the 1st" ($2,500) vs "rent"
 *  ($300) stays two rows for the user to reconcile. The row with the more
 *  specific (longer) name survives. */
export function dedupeBills(rows: any[]): any[] {
  const out: any[] = [];
  for (const b of rows || []) {
    const n = normName(b.name);
    const idx = out.findIndex(o => Number(o.amount) === Number(b.amount) && (() => {
      const m = normName(o.name);
      return m === n || (n && m && (m.includes(n) || n.includes(m)));
    })());
    if (idx === -1) out.push(b);
    else if (n.length > normName(out[idx].name).length) out[idx] = b;
  }
  return out;
}
