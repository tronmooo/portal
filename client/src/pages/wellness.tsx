// ── Wellness tab (Health→Wellness redesign, 2026-07) ─────────────────────────
// The health command center. It renders <WellnessOverview> from data pulled off
// the SAME shared TanStack Query keys the Trackers grid and Executive dashboard
// use — ["/api/trackers", mode, ...ids], ["/api/habits", …], ["/api/stats", …],
// obligations, events, documents, profiles. Because reads share those keys and
// writes invalidate them, anything logged here or anywhere else stays in sync
// across every view (that's the "update once, shows everywhere" requirement).
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useProfileScope } from "@/hooks/useProfileScope";
import { useHubChrome } from "@/components/hub/hub-context";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
import { apiRequest, queryClient, BROWSER_TIMEZONE } from "@/lib/queryClient";
import { hashNavigate } from "@/lib/hashNavigate";
import { useToast } from "@/hooks/use-toast";
import { HeartPulse, Plus } from "lucide-react";
import { ModalShell } from "@/components/ui/modal-shell";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import type { Tracker, Profile, Obligation, Document as Doc, CalendarEvent } from "@shared/schema";
import {
  extractVitals, readMetric, computeWellnessScore, countWellnessTrackers,
} from "@/lib/wellness-metrics";
import { getCanonicalGroup } from "@/lib/tracker-health";
import { readField } from "@/lib/profile-fields";
import {
  WellnessOverview,
  type WellnessMed, type WellnessSupp, type WellnessAppt,
} from "@/components/wellness/WellnessOverview";

const HYDRATION_GOAL = 100; // oz/day — matches the reference dial
const CALORIE_GOAL = 2300;  // kcal/day
const todayCA = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD (local)

// Split a "Vitamin D 2000IU" style string into name + dose (best-effort).
function splitDose(name: string): { name: string; dose?: string } {
  const m = name.match(/^(.*?)[\s—-]*(\d[\d.,]*\s?(?:mg|mcg|iu|ml|g|units?|tabs?)\b.*)$/i);
  return m ? { name: m[1].trim(), dose: m[2].trim() } : { name };
}

function relTime(iso?: string): string | undefined {
  if (!iso) return undefined;
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return undefined;
  const min = Math.round(diff / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export default function WellnessPage() {
  const embedded = useHubChrome();
  const { toast } = useToast();
  const { mode: filterMode, selectedIds: filterIds } = useProfileScope();
  const profileParam = filterMode === "selected" && filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";
  const today = todayCA();

  // ── Shared queries (identical keys everywhere → connected views) ──
  const { data: trackers = [] } = useQuery<Tracker[]>({
    queryKey: ["/api/trackers", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/trackers${profileParam}`).then((r) => r.json()),
  });
  const { data: habits = [] } = useQuery<any[]>({
    queryKey: ["/api/habits", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/habits${profileParam}`).then((r) => r.json()),
  });
  const { data: stats } = useQuery<any>({
    queryKey: ["/api/stats", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/stats${profileParam}`).then((r) => r.json()),
  });
  const { data: obligations = [] } = useQuery<Obligation[]>({
    queryKey: ["/api/obligations", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/obligations${profileParam}`).then((r) => r.json()),
  });
  const { data: events = [] } = useQuery<CalendarEvent[]>({
    queryKey: ["/api/events", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/events${profileParam}`).then((r) => r.json()).catch(() => []),
  });
  const { data: documents = [] } = useQuery<Doc[]>({
    queryKey: ["/api/documents"],
    queryFn: () => apiRequest("GET", "/api/documents").then((r) => r.json()).catch(() => []),
  });
  const { data: profiles = [] } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then((r) => r.json()),
  });

  // ── Habit check-in toggle — the SAME mutation shape the dashboard habit
  // popup uses, invalidating ["/api/habits"] + ["/api/stats"] so the dashboard
  // ring and Trackers habit view update in lockstep. ──
  const [togglingHabitId, setTogglingHabitId] = useState<string | null>(null);
  const toggleHabit = useMutation({
    mutationFn: async ({ id, next }: { id: string; next: boolean }) => {
      const h = (habits || []).find((x: any) => x.id === id);
      const existing = (h?.checkins || []).find((c: any) => c.date === today);
      if (next) {
        if (!existing) await apiRequest("POST", `/api/habits/${id}/checkin`, { date: today });
      } else if (existing) {
        await apiRequest("DELETE", `/api/habits/${id}/checkin/${existing.id}`);
      }
    },
    onMutate: ({ id }) => setTogglingHabitId(id),
    onError: () => toast({ title: "Failed to update habit", variant: "destructive" }),
    onSettled: () => {
      setTogglingHabitId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/habits"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
    },
  });

  // ── Quick-log tracker entry: shared tracker-entry mutation → propagates ──
  const quickLog = useMutation({
    mutationFn: async ({ trackerId, field, amount }: { trackerId: string; field: string; amount: number }) =>
      apiRequest("POST", `/api/trackers/${trackerId}/entries`, { values: { [field]: amount } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      toast({ title: "Logged" });
    },
    onError: () => toast({ title: "Couldn't log entry", variant: "destructive" }),
  });

  // ── Medication mark-taken: POST the obligation's pay endpoint to record a
  // payment dated today (untoggle deletes the latest). Invalidates obligations
  // + stats + enhanced so the dashboard "N due today" and bills feed match. ──
  const [togglingMedId, setTogglingMedId] = useState<string | null>(null);
  const toggleMed = useMutation({
    mutationFn: async ({ id, next }: { id: string; next: boolean }) => {
      if (next) await apiRequest("POST", `/api/obligations/${id}/pay`, { date: today });
      else await apiRequest("DELETE", `/api/obligations/${id}/last-payment`, {});
    },
    onMutate: ({ id }) => setTogglingMedId(id),
    onError: () => toast({ title: "Couldn't update medication", variant: "destructive" }),
    onSettled: () => {
      setTogglingMedId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
    },
  });

  // ── Inline quick-log dialog for point-in-time metrics (weight / mood /
  // sleep / steps) that need a value, not a fixed increment. ──
  const [logKind, setLogKind] = useState<null | "weight" | "mood" | "sleep" | "steps">(null);
  const [logValue, setLogValue] = useState("");

  // ── Derive everything from the shared data ──
  const vitals = extractVitals(trackers);
  const wellnessScore = computeWellnessScore(trackers);
  const trackerCount = countWellnessTrackers(trackers);

  const sleep = vitals.sleep;
  const steps = vitals.steps;
  const hydration = vitals.hydration;
  const calories = vitals.calories;
  const restingHr = vitals.restingHeartRate.value != null ? vitals.restingHeartRate : vitals.heartRate;
  const streak = Array.isArray(stats?.streaks) && stats.streaks.length > 0
    ? Math.max(...stats.streaks.map((s: any) => Number(s.days) || 0))
    : (stats?.journalStreak ?? null);

  // Habits (today's completion via checkins).
  const activeHabits = (habits || []).filter((h: any) => !h.archivedAt);
  const habitCards = activeHabits.map((h: any) => ({
    id: h.id, name: h.name,
    done: (h.checkins || []).some((c: any) => c.date === today),
  }));
  const habitsCompleted = habitCards.filter((h) => h.done).length;

  // Today's schedule (calendar events dated today).
  const schedule = (Array.isArray(events) ? events : [])
    .filter((e: any) => String(e.date || "").slice(0, 10) === today)
    .sort((a: any, b: any) => String(a.time || "").localeCompare(String(b.time || "")))
    .map((e: any) => ({ id: e.id, time: e.allDay ? "All day" : (e.time || "—"), title: e.title }));

  // Medications + supplements from obligations (kind=medication). "Due" when the
  // next occurrence is today or past; taken-state lives in payments.
  const medObligations = (Array.isArray(obligations) ? obligations : [])
    .filter((o: any) => o.kind === "medication" && o.status !== "cancelled");
  const isSupplement = (o: any) => /supplement|vitamin|omega|probiotic|magnesium|zinc|fish oil|creatine/i.test(`${o.name} ${o.category}`);
  const takenToday = (o: any) => (o.payments || []).some((p: any) => String(p.date || "").slice(0, 10) === today);
  const medications: WellnessMed[] = medObligations.filter((o: any) => !isSupplement(o)).slice(0, 8).map((o: any) => {
    const { name, dose } = splitDose(o.name);
    return {
      id: o.id, name, dose: dose || (o.fields?.dose as string | undefined),
      time: o.nextDueDate ? new Date(o.nextDueDate).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: BROWSER_TIMEZONE }) : undefined,
      taken: takenToday(o),
    };
  });
  const supplements: WellnessSupp[] = medObligations.filter(isSupplement).slice(0, 8).map((o: any) => {
    const { name, dose } = splitDose(o.name);
    return { id: o.id, name, dose, schedule: o.frequency };
  });

  // Upcoming appointments (obligations kind=appointment, future first).
  const appointments: WellnessAppt[] = (Array.isArray(obligations) ? obligations : [])
    .filter((o: any) => o.kind === "appointment" && o.status !== "cancelled" && o.nextDueDate)
    .sort((a: any, b: any) => String(a.nextDueDate).localeCompare(String(b.nextDueDate)))
    .slice(0, 6)
    .map((o: any) => ({
      id: o.id, title: o.name,
      date: new Date(o.nextDueDate).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: BROWSER_TIMEZONE }),
      time: /T\d|:/.test(o.nextDueDate) ? new Date(o.nextDueDate).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: BROWSER_TIMEZONE }) : undefined,
    }));

  // Health documents (medical / lab / insurance / prescription / vaccination).
  const healthDocs = (Array.isArray(documents) ? documents : [])
    .filter((d: any) => !d.deletedAt && /medical|lab|health|insurance|prescription|vaccin|immuniz|blood|clinical/i.test(`${d.type} ${d.name} ${(d.tags || []).join(" ")}`))
    .slice(0, 6)
    .map((d: any) => ({
      id: d.id, name: d.title || d.name,
      date: (d.expirationDate || d.createdAt) ? new Date(d.expirationDate || d.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: BROWSER_TIMEZONE }) : undefined,
    }));

  // Conditions + allergies from the scoped person/self profiles' fields.
  const scopedPeople = (Array.isArray(profiles) ? profiles : []).filter((p: any) => {
    if (!["person", "self"].includes(p.type)) return false;
    if (filterMode === "selected" && filterIds.length > 0) return filterIds.includes(p.id);
    return true;
  });
  const splitList = (v: any): string[] =>
    Array.isArray(v) ? v.map(String) : (typeof v === "string" ? v.split(/[,;]/).map((s) => s.trim()).filter(Boolean) : []);
  const allergies = scopedPeople.flatMap((p: any) =>
    splitList(readField(p.fields, "allergies")).map((a, i) => ({ id: `${p.id}-al-${i}`, name: a, note: p.type === "self" ? undefined : p.name }))
  ).slice(0, 6);
  const conditions = scopedPeople.flatMap((p: any) => {
    const raw = readField(p.fields, "conditions") ?? readField(p.fields, "medicalConditions") ?? readField(p.fields, "medical conditions");
    return splitList(raw).map((c, i) => ({ id: `${p.id}-co-${i}`, name: c, note: p.type === "self" ? undefined : p.name }));
  }).slice(0, 6);

  // Lab results — cholesterol/glucose/lipid trackers, latest reading + status.
  const labs = (Array.isArray(trackers) ? trackers : [])
    .filter((t: any) => /cholesterol|glucose|lipid|a1c|hdl|ldl|triglyceride|vitamin d|tsh|thyroid/i.test(`${t.name} ${t.category}`))
    .filter((t: any) => (t.entries || []).length > 0)
    .slice(0, 5)
    .map((t: any) => {
      const m = readMetric([t], [/.*/]);
      return {
        id: t.id, name: t.name,
        date: m.loggedAt ? new Date(m.loggedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: BROWSER_TIMEZONE }) : undefined,
        status: m.value != null ? `${m.value}${m.unit ? " " + m.unit : ""}` : undefined,
      };
    });

  // Recent activity from stats (already health/tracker-flavored).
  const recentActivity = (Array.isArray(stats?.recentActivity) ? stats.recentActivity : [])
    .slice(0, 6)
    .map((r: any, i: number) => ({ id: String(i), text: r.description || r.type, when: relTime(r.timestamp) }));

  // Vitals overview rows.
  const fmtVital = (m: any, dp = 0) => m.value != null ? `${Number(m.value).toLocaleString("en-US", { maximumFractionDigits: dp })}${m.unit ? " " + m.unit : ""}` : "—";
  const vitalRows = [
    vitals.bloodPressureSys.value != null && { label: "Blood Pressure", value: `${vitals.bloodPressureSys.value}/${vitals.bloodPressureDia.value ?? "—"} mmHg`, change: null },
    (vitals.heartRate.value != null) && { label: "Heart Rate", value: fmtVital(vitals.heartRate), change: vitals.heartRate.changePct },
    vitals.bodyTemp.value != null && { label: "Body Temp", value: fmtVital(vitals.bodyTemp, 1), change: null },
    vitals.weight.value != null && { label: "Weight", value: fmtVital(vitals.weight, 1), change: vitals.weight.changePct },
    vitals.glucose.value != null && { label: "Blood Sugar", value: fmtVital(vitals.glucose), change: vitals.glucose.changePct },
    vitals.bmi.value != null && { label: "BMI", value: fmtVital(vitals.bmi, 1), change: null },
  ].filter(Boolean) as Array<{ label: string; value: string; change: number | null }>;

  // Exercise & activity — count workouts logged this week across fitness
  // trackers, plus any computed calories burned.
  const weekAgo = Date.now() - 7 * 86400000;
  const fitnessTrackers = (Array.isArray(trackers) ? trackers : []).filter((t: any) => getCanonicalGroup(t.category) === "Fitness");
  let workouts = 0, caloriesBurned = 0, activeMin = 0;
  for (const t of fitnessTrackers) {
    for (const e of (t.entries || [])) {
      if (new Date(e.timestamp).getTime() < weekAgo) continue;
      workouts++;
      caloriesBurned += Number(e.computed?.caloriesBurned) || 0;
      const dur = Number(e.values?.duration ?? e.values?.minutes ?? e.computed?.durationMinutes);
      if (Number.isFinite(dur)) activeMin += dur;
    }
  }
  const activity = {
    workouts: workouts || undefined,
    activeMin: activeMin || undefined,
    caloriesBurned: caloriesBurned ? Math.round(caloriesBurned) : undefined,
  };

  // AI wellness insights — honest, derived from the real data.
  const insights: string[] = [];
  if (sleep.value != null) insights.push(sleep.value >= 7 ? `You slept ${sleep.value.toFixed(1)}h last night — right in the healthy range.` : `You slept ${sleep.value.toFixed(1)}h last night — aim for 7–9h.`);
  if (hydration.value != null && hydration.value < HYDRATION_GOAL) insights.push(`You're at ${Math.round(hydration.value)} of ${HYDRATION_GOAL} oz of water today — a bit more to hit your goal.`);
  if (restingHr.value != null && restingHr.value <= 60) insights.push(`Your resting heart rate (${restingHr.value} bpm) is excellent.`);
  if (habitCards.length > 0) insights.push(`You've completed ${habitsCompleted} of ${habitCards.length} habits today.`);
  if (vitals.weight.changePct != null && Math.abs(vitals.weight.changePct) >= 0.5) insights.push(`Weight is ${vitals.weight.changePct < 0 ? "down" : "up"} ${Math.abs(vitals.weight.changePct).toFixed(1)}% since your last log.`);

  // Health reminders — from active medication/appointment obligations + hydration.
  const reminders: string[] = [];
  const dueMedCount = medications.filter((m) => !m.taken).length;
  if (dueMedCount > 0) reminders.push(`${dueMedCount} medication${dueMedCount > 1 ? "s" : ""} still to take today.`);
  if (hydration.value != null && hydration.value < HYDRATION_GOAL) reminders.push(`Drink ${HYDRATION_GOAL - Math.round(hydration.value)} more oz of water.`);
  if (appointments.length > 0) reminders.push(`${appointments.length} upcoming appointment${appointments.length > 1 ? "s" : ""}.`);

  // The matched tracker metric behind each quick-log kind.
  const metricForKind = (kind: "weight" | "mood" | "sleep" | "steps") =>
    kind === "weight" ? vitals.weight : kind === "mood" ? vitals.mood : kind === "sleep" ? sleep : steps;
  const logMeta: Record<"weight" | "mood" | "sleep" | "steps", { label: string; unit: string; step: string; placeholder: string }> = {
    weight: { label: "Weight", unit: vitals.weightUnit, step: "0.1", placeholder: "176.5" },
    mood: { label: "Mood", unit: "/ 10", step: "1", placeholder: "8" },
    sleep: { label: "Sleep", unit: "hours", step: "0.1", placeholder: "7.5" },
    steps: { label: "Steps", unit: "steps", step: "1", placeholder: "8000" },
  };

  const onQuickLog = (kind: "hydration" | "weight" | "mood" | "sleep" | "steps") => {
    if (kind === "hydration") {
      // Fast +8oz — no value prompt needed for an additive metric.
      if (hydration.trackerId && hydration.primaryField) {
        quickLog.mutate({ trackerId: hydration.trackerId, field: hydration.primaryField, amount: 8 });
      } else {
        toast({ title: "No hydration tracker yet", description: "Ask the AI in chat to start one." });
      }
      return;
    }
    // Point-in-time metrics open an inline value dialog.
    const m = metricForKind(kind);
    if (!m.trackerId) {
      toast({ title: `No ${logMeta[kind].label.toLowerCase()} tracker yet`, description: "Ask the AI in chat to start one." });
      hashNavigate("/trackers");
      return;
    }
    setLogValue(m.value != null ? String(m.value) : "");
    setLogKind(kind);
  };

  const submitQuickLog = () => {
    if (!logKind) return;
    const m = metricForKind(logKind);
    const amount = parseFloat(logValue);
    if (!m.trackerId || !m.primaryField || !Number.isFinite(amount)) {
      toast({ title: "Enter a number", variant: "destructive" });
      return;
    }
    quickLog.mutate({ trackerId: m.trackerId, field: m.primaryField, amount });
    setLogKind(null);
    setLogValue("");
  };

  return (
    <div className={embedded ? "px-3 sm:px-4 py-3" : "container mx-auto px-3 sm:px-4 py-4 max-w-7xl"}>
      {!embedded && (
        <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2"><HeartPulse className="w-5 h-5 text-red-500" /> Wellness</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Your health at a glance{trackerCount > 0 ? ` · ${trackerCount} tracker${trackerCount > 1 ? "s" : ""}` : ""}
            </p>
          </div>
          <MultiProfileFilter onChange={() => {}} compact />
        </div>
      )}

      <WellnessOverview
        wellnessScore={wellnessScore}
        wellnessScoreLabel={wellnessScore == null ? undefined : wellnessScore >= 80 ? "Good" : wellnessScore >= 60 ? "Fair" : "Needs care"}
        sleepHours={sleep.value}
        sleepSeries={sleep.series}
        steps={steps.value}
        stepsSeries={steps.series}
        restingHr={restingHr.value}
        restingHrSeries={restingHr.series}
        hydrationOz={hydration.value}
        hydrationGoal={HYDRATION_GOAL}
        calories={calories.value}
        caloriesGoal={CALORIE_GOAL}
        streak={streak}
        insights={insights}
        habits={habitCards}
        habitsCompleted={habitsCompleted}
        onToggleHabit={(id, next) => toggleHabit.mutate({ id, next })}
        togglingHabitId={togglingHabitId}
        schedule={schedule}
        medications={medications}
        onToggleMed={(id, next) => toggleMed.mutate({ id, next })}
        togglingMedId={togglingMedId}
        vitals={vitalRows}
        sleep={{ hours: sleep.value ?? null }}
        nutrition={{ calories: calories.value, caloriesGoal: CALORIE_GOAL }}
        mood={{ value: vitals.mood.value, series: vitals.mood.series }}
        activity={activity}
        appointments={appointments}
        reminders={reminders}
        labs={labs}
        supplements={supplements}
        documents={healthDocs}
        conditions={conditions}
        allergies={allergies}
        recentActivity={recentActivity}
        weightUnit={vitals.weightUnit}
        onQuickLog={onQuickLog}
      />

      {/* Inline quick-log dialog for weight / mood / sleep / steps — shared ModalShell. */}
      <ModalShell
        open={logKind != null}
        onOpenChange={(o) => { if (!o) { setLogKind(null); setLogValue(""); } }}
        title={`Log ${logKind ? logMeta[logKind].label : ""}`}
        icon={Plus}
        accent="199 89% 60%"
        width="xs"
        testId="wellness-quicklog-dialog"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => { setLogKind(null); setLogValue(""); }}>Cancel</Button>
            <Button size="sm" onClick={submitQuickLog} disabled={quickLog.isPending || !logValue.trim()} data-testid="wellness-log-submit">
              {quickLog.isPending ? "Logging…" : "Log"}
            </Button>
          </div>
        }
      >
        {logKind && (
          <div className="space-y-2 px-4 py-4">
            <Label htmlFor="wellness-log-input" className="text-xs">{logMeta[logKind].label} ({logMeta[logKind].unit})</Label>
            <Input
              id="wellness-log-input" type="number" inputMode="decimal" autoFocus
              step={logMeta[logKind].step} placeholder={logMeta[logKind].placeholder}
              value={logValue} onChange={(e) => setLogValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitQuickLog(); }}
              data-testid="wellness-log-input"
            />
            <p className="text-[11px] text-muted-foreground">
              Logs to your {metricForKind(logKind).trackerName || logMeta[logKind].label} tracker — updates everywhere.
            </p>
          </div>
        )}
      </ModalShell>
    </div>
  );
}
