// ── Design-kit barrel ────────────────────────────────────────────────────────
// One import site for the shared design system. Pages/components should pull
// cards, headers, modals, and primitives from here so the app stays one visual
// language. (Named kit-index to avoid colliding with any generated ui/index.)
export { AccentCard, SectionHeader } from "@/components/ui/accent-card";
export { EmptyState } from "@/components/ui/empty-state";
export { MetricCard } from "@/components/ui/metric-card";
export { ModalShell, PopupSection, ModalState, type ModalWidth } from "@/components/ui/modal-shell";
export {
  FilterChip, StatusBadge, CollapseArrow, IconButton, DashboardCard, DataTable,
  type StatusTone, type DataTableColumn,
} from "@/components/ui/kit";
export { Button } from "@/components/ui/button";
// Button presets — semantic aliases so intent is explicit at call sites.
export { Button as PrimaryButton } from "@/components/ui/button"; // variant="default"
export { Button as SecondaryButton } from "@/components/ui/button"; // variant="outline"
