// ── Wellness tab ─────────────────────────────────────────────────────────────
// A readout, not a logbook.
//
// Every number on this page arrives on its own — from a connected health source,
// from a lab report the Photo AI pipeline read, or from records that already
// exist elsewhere in the app (medication obligations, appointments, documents,
// profile fields). There is no hydration ring to fill, no streak to keep and no
// "you haven't logged this in 24 days": nothing here is the user's chore.
//
// Data rules this page enforces (the layout is worthless if the numbers lie):
//   * ONE SUBJECT. Health data never blends. The page reads exactly one person
//     — the selected profile, or "me" — so two different heights can no longer
//     average into one body. Trackers, obligations and documents are filtered
//     to that person (orphans, which predate profile linking, belong to self).
//   * ONE METRIC PER MEASUREMENT. Everything resolves through the canonical
//     registry (shared/wellness-canon.ts), so "HDL", "HDL Cholesterol" and
//     "Lipid Panel — HDL" are one series, not three cards.
//   * IMPOSSIBLE VALUES ARE NOT SHOWN. A reading outside a metric's physically
//     possible range is dropped on read (and now rejected on write), so an
//     HbA1c of 179 % can't sit next to a real one.
//
// Reads still ride the SAME shared TanStack Query keys as the Trackers grid and
// the dashboard, so anything logged anywhere still shows up here.
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useProfileScope } from "@/hooks/useProfileScope";
import { useHubChrome } from "@/components/hub/hub-context";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
import { apiRequest, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { parseLocalDate } from "@/lib/format";
import { withFullLimit } from "@/lib/list-limit";
import { useToast } from "@/hooks/use-toast";
import { HeartPulse } from "lucide-react";
import type { Tracker, Profile, Obligation, Document as Doc } from "@shared/schema";
import { isHealthDocument } from "@shared/health-documents";
import { isMedicationTracker } from "@shared/medication-doses";
import { trackerNamesMatch } from "@shared/tracker-identity";
import { readField } from "@/lib/profile-fields";
import {
  collectMetrics, todaySignals, labPanels, activityHistory, wellnessScore,
  weeklyBrief, sourceState, mergedDuplicates, resolveWellnessSubject, belongsToSubject, bodyVitals,
} from "@shared/wellness-readout";
import {
  WellnessOverview,
  type WellnessMed, type WellnessAppt, type WellnessDoc, type WellnessListItem,
} from "@/components/wellness/WellnessOverview";

// Split a "Vitamin D 2000IU" style string into name + dose (best-effort).
function splitDose(name: string): { name: string; dose?: string } {
  const m = name.match(/^(.*?)[\s—-]*(\d[\d.,]*\s?(?:mg|mcg|iu|ml|g|units?|tabs?)\b.*)$/i);
  return m ? { name: m[1].trim(), dose: m[2].trim() } : { name };
}

const shortDate = (v?: string | null): string | undefined => {
  if (!v) return undefined;
  const d = parseLocalDate(v) ?? new Date(v);
  return isNaN(d.getTime()) ? undefined : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

export default function WellnessPage() {
  const embedded = useHubChrome();
  const { toast } = useToast();
  const { mode: filterMode, selectedIds: filterIds } = useProfileScope();
  const profileParam = filterMode === "selected" && filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";

  // ── Shared queries (identical keys everywhere → connected views) ──
  const { data: trackers = [] } = useQuery<Tracker[]>({
    queryKey: ["/api/trackers", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/trackers${profileParam}`).then((r) => r.json()),
  });
  const { data: obligations = [] } = useQuery<Obligation[]>({
    queryKey: ["/api/obligations", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", withFullLimit(`/api/obligations${profileParam}`)).then((r) => r.json()),
  });
  const { data: documents = [] } = useQuery<Doc[]>({
    queryKey: ["/api/documents", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", withFullLimit(`/api/documents${profileParam}`)).then((r) => r.json()).catch(() => []),
  });
  const { data: profiles = [] } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then((r) => r.json()),
  });

  // ── The subject: exactly one person ──────────────────────────────────────
  // "Everyone" is a perfectly good filter for bills. For a body it is not:
  // under it this page averaged two people's heights (70 in and 67 in) into one
  // BMI. So the subject is the selected person when one is selected, and "me"
  // otherwise — never a blend.
  const { subject, isSelf: subjectIsSelf } = resolveWellnessSubject(
    (Array.isArray(profiles) ? profiles : []) as any[],
    filterMode === "selected" ? filterIds : [],
  );
  const ownedBySubject = (linked?: string[] | null) => belongsToSubject(linked, subject, subjectIsSelf);

  const myTrackers = (Array.isArray(trackers) ? trackers : []).filter((t: any) => ownedBySubject(t.linkedProfiles));
  const myObligations = (Array.isArray(obligations) ? obligations : []).filter((o: any) => ownedBySubject(o.linkedProfiles));
  const myDocuments = (Array.isArray(documents) ? documents : []).filter((d: any) => ownedBySubject(d.linkedProfiles));

  // ── The readout ──────────────────────────────────────────────────────────
  // "Today" is the browser's day: the readout's freshness windows (today /
  // last night) must agree with the clock the person is looking at.
  //
  // Documents feed it too: a lab report's values live on the document's
  // extractedData, and Labs said "No lab values" beside an uploaded Vitamin D
  // result because only trackers were read. The readout resolves those values
  // through the same canon and dedupes them against any tracker entry the
  // extraction also logged (shared/wellness-readout collectDocumentMetrics).
  const metrics = collectMetrics(myTrackers, { timezone: BROWSER_TIMEZONE, documents: myDocuments });
  const signals = todaySignals(metrics);
  const panels = labPanels(metrics);
  const body = bodyVitals(metrics);
  const workouts = activityHistory(myTrackers);
  const score = wellnessScore(metrics);
  const brief = weeklyBrief({ metrics, workouts, labs: panels });
  const sources = sourceState(metrics);
  const duplicates = mergedDuplicates(metrics);

  // ── Care ─────────────────────────────────────────────────────────────────
  // Medications show WHEN THEY RUN OUT, not a daily checkbox. Knowing a refill
  // is due is useful; ticking a box every morning is the chore this page is
  // getting rid of.
  const isSupplement = (o: any) => /supplement|vitamin|omega|probiotic|magnesium|zinc|fish oil|creatine/i.test(`${o.name} ${o.category}`);
  const medsFromBills: WellnessMed[] = myObligations
    .filter((o: any) => o.kind === "medication" && o.status !== "cancelled")
    .sort((a: any, b: any) => String(a.nextDueDate || "").localeCompare(String(b.nextDueDate || "")))
    .map((o: any) => {
      const { name, dose } = splitDose(o.name);
      const refillRaw = o.fields?.refillDate || o.fields?.refill || (isSupplement(o) ? null : o.nextDueDate);
      const refill = shortDate(refillRaw);
      return {
        id: o.id, name,
        dose: dose || (o.fields?.dose as string | undefined),
        refill: refill ? `Refills ${refill}` : undefined,
        schedule: o.frequency,
      };
    });
  // A medication in this app IS a tracker (category "medication", its entries
  // the dose ledger — shared/medication-doses). Care read only the bills
  // table, so a person with Vitamin D and Multivitamin trackers was told "No
  // medications". Trackers fill the list; a bill for the same drug is merged.
  const medsFromTrackers: WellnessMed[] = myTrackers
    .filter((t: any) => isMedicationTracker(t))
    .filter((t: any) => !medsFromBills.some((m) => trackerNamesMatch(m.name, t.name)))
    .map((t: any) => {
      const { name, dose } = splitDose(String(t.name || ""));
      const last = (t.entries || []).slice(-1)[0];
      const doseText = dose || (last?.values?.dosage != null ? String(last.values.dosage) : undefined);
      const schedule = String(last?.values?.frequency || t.unit || "").trim() || undefined;
      return { id: t.id, name, dose: doseText, schedule };
    });
  const medications: WellnessMed[] = [...medsFromBills, ...medsFromTrackers].slice(0, 12);

  const appointments: WellnessAppt[] = myObligations
    .filter((o: any) => o.kind === "appointment" && o.status !== "cancelled" && o.nextDueDate)
    .sort((a: any, b: any) => String(a.nextDueDate).localeCompare(String(b.nextDueDate)))
    .slice(0, 8)
    .map((o: any) => ({
      id: o.id, title: o.name,
      // parseLocalDate: a date-only value is local midnight, not UTC midnight
      // (which showed the previous day in the Americas).
      date: shortDate(o.nextDueDate) || "",
      time: /T\d|:/.test(o.nextDueDate)
        ? new Date(o.nextDueDate).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: BROWSER_TIMEZONE })
        : undefined,
    }));

  // Health documents BY TYPE (shared/health-documents.ts). The old name-regex
  // filed two homeowners insurance policies under health records.
  const healthDocs: WellnessDoc[] = myDocuments
    .filter((d: any) => isHealthDocument(d))
    .slice(0, 8)
    .map((d: any) => ({
      id: d.id,
      name: d.title || d.name,
      date: shortDate(d.expirationDate || d.createdAt),
      type: d.type,
    }));

  // Allergies + conditions from the SUBJECT's profile only.
  const splitList = (v: any): string[] =>
    Array.isArray(v) ? v.map(String) : (typeof v === "string" ? v.split(/[,;]/).map((s) => s.trim()).filter(Boolean) : []);
  const allergies: WellnessListItem[] = subject
    ? splitList(readField((subject as any).fields, "allergies")).map((a, i) => ({ id: `al-${i}`, name: a })).slice(0, 8)
    : [];
  const conditions: WellnessListItem[] = subject
    ? splitList(
        readField((subject as any).fields, "conditions") ??
        readField((subject as any).fields, "medicalConditions") ??
        readField((subject as any).fields, "medical conditions"),
      ).map((c, i) => ({ id: `co-${i}`, name: c })).slice(0, 8)
    : [];

  // ── AI brief (opt-in) ────────────────────────────────────────────────────
  // The weekly brief above is computed from the data for free on every load.
  // This turns the same facts into prose, and is called only when asked, so a
  // visit costs no tokens.
  const [aiNarrative, setAiNarrative] = useState<string | null>(null);
  const aiBrief = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/wellness/insights${profileParam}`, {});
      return res.json();
    },
    onSuccess: (data: any) => setAiNarrative(typeof data?.narrative === "string" ? data.narrative : null),
    onError: () => toast({ title: "Couldn't generate the brief", variant: "destructive" }),
  });

  return (
    // The hub <main> is overflow-hidden, so every hub page owns its scroll
    // container (see dashboard/trackers/finance/…) and clears the 60px nav.
    <div
      className={`h-full overflow-y-auto overflow-x-hidden pb-24 ${embedded ? "px-3 md:px-6 py-3" : "container mx-auto px-3 sm:px-4 py-4 max-w-7xl"}`}
      style={{ WebkitOverflowScrolling: "touch" }}
    >
      {!embedded && (
        <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2"><HeartPulse className="w-5 h-5 text-red-500" /> Wellness</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Read back from your health data — nothing to log</p>
          </div>
          <MultiProfileFilter onChange={() => {}} compact />
        </div>
      )}

      <WellnessOverview
        subjectName={subject && !subjectIsSelf ? subject.name : null}
        score={score}
        signals={signals}
        brief={brief}
        aiNarrative={aiNarrative}
        onAiBrief={() => aiBrief.mutate()}
        aiBriefLoading={aiBrief.isPending}
        panels={panels}
        body={body}
        medications={medications}
        appointments={appointments}
        documents={healthDocs}
        allergies={allergies}
        conditions={conditions}
        workouts={workouts}
        sources={sources}
        duplicates={duplicates}
      />
    </div>
  );
}
