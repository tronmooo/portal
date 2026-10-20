// Insights: data-backed observations only. Each card comes from
// buildInsights (shared/tracker-analytics), which emits a sentence only when
// the numbers behind it exist — so an empty list is an honest answer.

import { useMemo } from "react";
import { Lightbulb } from "lucide-react";
import { buildInsights } from "@shared/tracker-analytics";
import type { TrackerModel } from "./model";
import { InsightCard, TrackerEmptyState } from "./primitives";

export function useTrackerInsights(model: TrackerModel) {
  return useMemo(() => (model.field ? buildInsights({
    field: model.field, label: model.label, unit: model.unit, mode: model.mode, polarity: model.polarity,
    points: model.points, entries: model.entries, today: model.today,
    goal: model.goal ? { target: model.goal.target, direction: model.goal.direction } : null,
    isNutrition: model.isNutrition,
  }) : []), [model]);
}

export function InsightsTab({ model }: { model: TrackerModel }) {
  const insights = useTrackerInsights(model);
  if (insights.length === 0) {
    return (
      <TrackerEmptyState icon={Lightbulb} title="No insights yet"
        body="Insights appear when there's enough data to back them up — a week-over-week change needs three logged days in each week, a streak needs three days in a row."
        progress={{ have: Math.min(model.points.length, 7), need: 7 }} />
    );
  }
  return (
    <div className="space-y-2.5" data-testid="td-insights">
      {insights.map((ins, i) => <InsightCard key={ins.id} insight={ins} i={i} />)}
    </div>
  );
}
