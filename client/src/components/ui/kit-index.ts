// ── Design-kit barrel ────────────────────────────────────────────────────────
// One import site for the shared design system, and — more usefully — one place
// that says what the design system *is*. If a treatment isn't exported here, it
// isn't part of the system.
//
// This list used to be twice as long. `AccentCard`, `SectionHeader`,
// `DashboardCard`, `FilterChip`, `DataTable`, `CollapseArrow`, `IconButton`,
// `PopupSection` and `ModalState` were all exported and used by *zero* files:
// nine primitives that existed only to compete with the ones the app actually
// renders. They're deleted, not deprecated — a component nothing imports can
// still be imported tomorrow, and that is exactly how the app ended up with
// five card recipes.
//
// One per job:

// Surfaces
export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
export { EntityCard, type EntityCardProps, type EntityMeta } from "@/components/ui/entity-card";
export { MetricCard, type MetricCardProps } from "@/components/ui/metric-card";

// Structure
export { SectionHeading } from "@/components/ui/section-heading";
export { PageContainer, PageHeader } from "@/components/ui/page-shell";

// Overlays
export { BubbleModal, BubbleRow } from "@/components/ui/bubble-modal";

// States
export { EmptyState } from "@/components/ui/empty-state";
export { Skeleton, BubbleSkeleton, BubbleSkeletonGrid } from "@/components/ui/skeleton";

// Visual vocabulary
export {
  Medallion, Pill, ProgressRing, MiniBars, CountUp, TrendArrow,
  toneForDays, tonePalette, type PillTone,
} from "@/components/dashboard/visuals";

// Controls
export { Button } from "@/components/ui/button";
