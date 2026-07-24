// ── Windowed — bounded first render for long panel lists ────────────────────
// Panels mount inside a dialog, so their whole list is built in one synchronous
// commit. A few hundred task rows is a multi-hundred-millisecond mount, which
// lands exactly where it is most visible: between the tap and the popup.
//
// Deliberately NOT a virtualizer. A real windowing library would be a new
// dependency and needs measured row heights; these lists are variable-height
// expandable cards inside a scroll container. Rendering a bounded first page
// and revealing the rest on demand removes the same mount cost with none of
// that machinery — and every row stays a real DOM node, so in-page find,
// screen readers and the existing tests behave exactly as before.
import { useEffect, useState } from "react";

/** Below this, windowing costs more than it saves — render everything. */
export const WINDOW_THRESHOLD = 50;

export function Windowed<T>({ items, render, pageSize = WINDOW_THRESHOLD, testId }: {
  items: T[];
  render: (item: T, index: number) => React.ReactNode;
  pageSize?: number;
  testId?: string;
}) {
  const [limit, setLimit] = useState(pageSize);
  // A filter/tab switch replaces `items` — start the new list from page 1.
  useEffect(() => { setLimit(pageSize); }, [items, pageSize]);

  if (items.length <= pageSize) return <>{items.map(render)}</>;

  const hidden = items.length - limit;
  return (
    <>
      {items.slice(0, limit).map(render)}
      {hidden > 0 && (
        <button
          onClick={() => setLimit(l => l + pageSize)}
          data-testid={testId ? `${testId}-more` : "windowed-more"}
          className="w-full mt-1 mb-1 py-1.5 text-[11px] font-medium text-muted-foreground border border-border/60 rounded-md hover:bg-muted/40"
        >
          Show {Math.min(hidden, pageSize)} more · {hidden} remaining
        </button>
      )}
    </>
  );
}
