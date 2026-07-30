import { cn } from "@/lib/utils"

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("skeleton-shimmer rounded-md", className)}
      {...props}
    />
  )
}

// ── BubbleSkeleton ───────────────────────────────────────────────────────────
// The loading state, shaped like what's arriving.
//
// A grey rectangle announces "loading". A silhouette — medallion circle, title
// bar, meta bars, inside a real bubble — makes the content look like it snapped
// into a frame that was already on screen. Same cost, completely different
// perceived speed, and it removes the layout jump when a 64px grey bar is
// replaced by a 190px card.
//
// `rows` should match the meta rows of the card it stands in for, and `--i`
// staggers the shimmer so a grid doesn't pulse in lockstep.
function BubbleSkeleton({
  rows = 2, medallion = true, height, className, index = 0, ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  rows?: number;
  medallion?: boolean;
  /** Match the grid's row height so nothing shifts when real data lands. */
  height?: number;
  index?: number;
}) {
  return (
    <div
      className={cn("bubble p-3 flex flex-col", className)}
      style={{ height, ["--i" as any]: index }}
      aria-hidden="true"
      {...props}
    >
      <div className="flex items-center gap-2">
        {medallion && <div className="skeleton-shimmer h-8 w-8 rounded-full shrink-0" />}
        <div className="skeleton-shimmer h-3 rounded-full flex-1 max-w-[60%]" />
      </div>
      <div className="skeleton-shimmer h-6 w-[55%] rounded-lg mt-3" />
      <div className="mt-3 space-y-2 flex-1">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="skeleton-shimmer h-2.5 rounded-full" style={{ width: `${88 - i * 18}%` }} />
        ))}
      </div>
      <div className="skeleton-shimmer h-5 w-16 rounded-full mt-2" />
    </div>
  )
}

/** A grid of card silhouettes — the standard list/grid loading state. */
function BubbleSkeletonGrid({
  count = 4, rows = 2, height = 178, className,
}: {
  count?: number; rows?: number; height?: number; className?: string;
}) {
  return (
    <div
      className={cn("grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3", className)}
      data-testid="bubble-skeleton-grid"
    >
      {Array.from({ length: count }).map((_, i) => (
        <BubbleSkeleton key={i} rows={rows} height={height} index={i} />
      ))}
    </div>
  )
}

export { Skeleton, BubbleSkeleton, BubbleSkeletonGrid }
