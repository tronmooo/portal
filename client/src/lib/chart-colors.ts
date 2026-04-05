/**
 * Shared chart color constants — uses CSS variables for dark mode adaptation.
 * Import this instead of defining local CHART_COLORS in each file.
 */
export const CHART_COLORS = {
  primary: "hsl(var(--chart-1))",
  secondary: "hsl(var(--chart-2))",
  tertiary: "hsl(var(--chart-3))",
  gold: "hsl(var(--chart-4))",
  accent: "hsl(var(--chart-5))",
  light: "hsl(var(--chart-1) / 0.2)",
  warning: "hsl(var(--destructive))",
} as const;

/** Array form for indexed access (charts, pie slices, etc.) */
export const CHART_COLOR_ARRAY = [
  CHART_COLORS.primary,
  CHART_COLORS.secondary,
  CHART_COLORS.tertiary,
  CHART_COLORS.gold,
  CHART_COLORS.accent,
] as const;
