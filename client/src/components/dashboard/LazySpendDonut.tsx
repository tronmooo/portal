// Lazy wrapper around SpendDonut — keeps recharts out of the dashboard chunk.
// See SpendDonut.tsx for why. The fallback is an empty box of the same height
// so the surrounding card never reflows while the chart chunk arrives.
import { lazy, Suspense } from "react";
import type { SpendDonutProps } from "@/components/dashboard/SpendDonut";

const SpendDonutImpl = lazy(() => import("@/components/dashboard/SpendDonut"));

export function LazySpendDonut(props: SpendDonutProps) {
  const boxHeight = typeof props.height === "number" ? `${props.height}px` : props.height;
  return (
    <Suspense fallback={<div style={{ height: boxHeight }} />}>
      <SpendDonutImpl {...props} />
    </Suspense>
  );
}

export default LazySpendDonut;
