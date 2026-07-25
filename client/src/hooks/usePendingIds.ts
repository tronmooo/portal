// ── usePendingIds ────────────────────────────────────────────────────────────
// A list of rows sharing ONE mutation must not share ONE busy flag. Gating every
// row's button on `mutation.isPending` freezes the whole list while a single
// write is in flight — on a cold serverless instance that is seconds, and it
// reads as "the app won't let me mark the second one done" (user report,
// 2026-07-25). Track the ids actually in flight instead: only that row goes
// inert, every other row stays tappable, and several writes can overlap.
//
// Usage:
//   const pending = usePendingIds();
//   const m = useMutation({
//     onMutate: ({ id }) => { pending.start(id); ... },
//     onSettled: (_d, _e, vars) => { pending.end(vars.id); ... },
//   });
//   <button disabled={pending.has(row.id)} … />
import { useCallback, useState } from "react";

export function usePendingIds() {
  const [ids, setIds] = useState<Set<string>>(() => new Set());
  const start = useCallback((id: string) => {
    setIds(prev => { const next = new Set(prev); next.add(id); return next; });
  }, []);
  const end = useCallback((id: string) => {
    setIds(prev => { if (!prev.has(id)) return prev; const next = new Set(prev); next.delete(id); return next; });
  }, []);
  const has = useCallback((id: string) => ids.has(id), [ids]);
  return { has, start, end, size: ids.size };
}
