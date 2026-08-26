// Level 2 of the review: what the document MEANS.
//
// The pane used to open on "REVIEW EXTRACTED DATA · 75" and leave the reader to
// work out from seventy-five rows what they were even looking at. This says it
// in four lines: what this is, what it is about, who else is in it, and how sure
// the app is.

import { FileText, AlertTriangle } from "lucide-react";
import type { ActionPlan, TargetRef } from "@shared/extraction-actions";

/** "Property: 123 Evergreen Ln", or just the name when we have no type for it. */
function label(t: TargetRef | undefined): string {
  if (!t?.name) return "";
  const kind = t.profileType
    ? t.profileType.charAt(0).toUpperCase() + t.profileType.slice(1)
    : "";
  return kind ? `${kind}: ${t.name}` : t.name;
}

function ConfidencePill({ value }: { value: number }) {
  // Three tiers, matching shared/semantic-document.confidenceTier — the same
  // thresholds that decide whether an action starts ticked, so the badge and
  // the behaviour can never tell the user different stories.
  const tier = value >= 0.85 ? "high" : value >= 0.55 ? "medium" : "low";
  const cls = tier === "high"
    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
    : tier === "medium"
      ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
      : "bg-muted text-muted-foreground";
  const text = tier === "high" ? "Confident" : tier === "medium" ? "Fairly sure" : "Unsure";
  return (
    <span className={`text-[11px] px-1.5 py-0.5 rounded ${cls}`} data-testid="understanding-confidence">
      {text}
    </span>
  );
}

export function DocumentUnderstanding({
  plan,
  degraded,
}: {
  plan?: ActionPlan;
  /** Set when the reasoning stage could not interpret the document. */
  degraded?: string;
}) {
  if (degraded) {
    return (
      <div
        className="flex items-start gap-2 px-2.5 py-2 bg-amber-500/10 border-b border-border/60"
        data-testid="understanding-degraded"
      >
        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="text-[11px] leading-tight text-muted-foreground">
          <span className="text-foreground font-medium">Couldn't work out what this document means</span>
          {` — ${degraded}. Everything it found is below; route each row yourself.`}
        </div>
      </div>
    );
  }
  if (!plan) return null;

  const u = plan.understanding;
  const related = u.relatedEntities.filter((e) => e.name);

  return (
    <div className="px-2.5 py-2 border-b border-border/60" data-testid="document-understanding">
      <div className="flex items-center gap-1.5 flex-wrap">
        <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium" data-testid="understanding-type">
          {u.documentType || "Document"}
        </span>
        <ConfidencePill value={u.confidence} />
      </div>

      {u.primarySubject?.name && (
        <div className="text-[11px] text-muted-foreground leading-tight mt-0.5" data-testid="understanding-subject">
          About <span className="text-foreground">{label(u.primarySubject)}</span>
          {u.primarySubject.matchReason && !u.primarySubject.id && (
            <span className="text-amber-600 dark:text-amber-400"> · no matching record</span>
          )}
        </div>
      )}

      {related.length > 0 && (
        <div className="text-[11px] text-muted-foreground leading-tight" data-testid="understanding-related">
          Also mentions {related.map((e) => e.name).join(" · ")}
        </div>
      )}

      {u.recurrenceSummary && (
        <div className="text-[11px] text-muted-foreground leading-tight" data-testid="understanding-recurrence">
          Recurring: {u.recurrenceSummary}
        </div>
      )}

      {u.summary && (
        <div className="text-[11px] text-muted-foreground leading-tight mt-0.5 italic">{u.summary}</div>
      )}
    </div>
  );
}
