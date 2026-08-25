// ── What the attention feed is allowed to show ───────────────────────────────
// The feed's rules live in shared/attention.ts; this is the user's grip on
// them. Every control maps to one AttentionConfig knob, so there is no second
// filtering path to keep in sync — turning "Habits" off here is the same switch
// the model reads.
//
// Persisted through the generic preference KV (`attention_prefs`), the same way
// the dashboard layout is stored, so the choice survives a reload and follows
// the account rather than the device.

import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { DEFAULT_ATTENTION_CONFIG, type AttentionConfig, type AttentionTier } from "@shared/attention";

export const ATTENTION_PREFS_KEY = "attention_prefs";
const QUERY_KEY = ["/api/preferences/attention_prefs"];

/** Merge a stored blob over the defaults, dropping anything unrecognized. */
export function parseAttentionPrefs(raw: string | null | undefined): AttentionConfig {
  if (!raw) return { ...DEFAULT_ATTENTION_CONFIG };
  try {
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== "object") return { ...DEFAULT_ATTENTION_CONFIG };
    const out: any = { ...DEFAULT_ATTENTION_CONFIG };
    for (const k of Object.keys(DEFAULT_ATTENTION_CONFIG) as Array<keyof AttentionConfig>) {
      const v = (saved as any)[k];
      if (typeof v === typeof DEFAULT_ATTENTION_CONFIG[k]) out[k] = v;
    }
    return out as AttentionConfig;
  } catch {
    return { ...DEFAULT_ATTENTION_CONFIG };
  }
}

export function useAttentionPrefs(enabled = true) {
  const { data } = useQuery<AttentionConfig>({
    queryKey: QUERY_KEY,
    enabled,
    queryFn: () => apiRequest("GET", `/api/preferences/${ATTENTION_PREFS_KEY}`)
      .then(r => r.json())
      .then(d => parseAttentionPrefs(d?.value)),
    staleTime: 5 * 60_000,
  });
  const save = useMutation({
    mutationFn: async (next: AttentionConfig) => {
      await apiRequest("PUT", `/api/preferences/${ATTENTION_PREFS_KEY}`, { value: JSON.stringify(next) });
      return next;
    },
    // Write through immediately: the feed re-ranks on the next render rather
    // than after a round-trip, so a toggle feels like a filter, not a save.
    onMutate: (next) => { queryClient.setQueryData(QUERY_KEY, next); },
    onError: () => { queryClient.invalidateQueries({ queryKey: QUERY_KEY }); },
  });
  return {
    prefs: data ?? DEFAULT_ATTENTION_CONFIG,
    setPrefs: (next: AttentionConfig) => save.mutate(next),
  };
}

function Toggle({ label, on, onChange, testId }: {
  label: string; on: boolean; onChange: (v: boolean) => void; testId: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      data-testid={testId}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium transition-colors ${
        on ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted"
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${on ? "bg-primary" : "bg-muted-foreground/40"}`} />
      {label}
    </button>
  );
}

function DayPicker({ label, value, options, onChange, testId }: {
  label: string; value: number; options: number[]; onChange: (v: number) => void; testId: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground w-20 shrink-0">{label}</span>
      <div className="flex items-center gap-1 flex-wrap">
        {options.map(o => (
          <button
            key={o}
            onClick={() => onChange(o)}
            data-testid={`${testId}-${o}`}
            aria-pressed={value === o}
            className={`rounded-md border px-1.5 py-0.5 text-[11px] tabular-nums transition-colors ${
              value === o ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted"
            }`}
          >
            {o}d
          </button>
        ))}
      </div>
    </div>
  );
}

const TIERS: Array<{ key: AttentionTier; label: string }> = [
  { key: "immediate", label: "Immediate only" },
  { key: "soon", label: "Within 7 days" },
  { key: "upcoming", label: "Everything" },
];

export function AttentionFilters({ prefs, onChange }: {
  prefs: AttentionConfig; onChange: (next: AttentionConfig) => void;
}) {
  // Local mirror so a rapid series of taps doesn't wait on the network between
  // each one; the parent's write-through keeps them in step.
  const [draft, setDraft] = useState<AttentionConfig>(prefs);
  useEffect(() => { setDraft(prefs); }, [prefs]);
  const set = (patch: Partial<AttentionConfig>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    onChange(next);
  };

  return (
    <div className="mb-2 bubble px-3 py-2.5 space-y-2.5" data-testid="attention-filters">
      <div>
        <p className="micro-label text-muted-foreground mb-1.5">Show</p>
        <div className="flex flex-wrap gap-1.5">
          <Toggle label="Tasks" on={draft.includeTasks} onChange={v => set({ includeTasks: v })} testId="attention-toggle-tasks" />
          <Toggle label="Habits" on={draft.includeHabits} onChange={v => set({ includeHabits: v })} testId="attention-toggle-habits" />
          <Toggle label="Today's events" on={draft.includeEvents} onChange={v => set({ includeEvents: v })} testId="attention-toggle-events" />
          <Toggle label="Birthdays" on={draft.includeBirthdays} onChange={v => set({ includeBirthdays: v })} testId="attention-toggle-birthdays" />
        </div>
      </div>

      <div className="space-y-1.5">
        <DayPicker label="Documents" value={draft.docsWithinDays} options={[7, 14, 30, 45, 60, 90]} onChange={v => set({ docsWithinDays: v })} testId="attention-days-docs" />
        <DayPicker label="Bills" value={draft.billsWithinDays} options={[7, 14, 30, 60]} onChange={v => set({ billsWithinDays: v })} testId="attention-days-bills" />
        <DayPicker label="Tasks" value={draft.tasksWithinDays} options={[1, 3, 7, 14, 30]} onChange={v => set({ tasksWithinDays: v })} testId="attention-days-tasks" />
      </div>

      <div>
        <p className="micro-label text-muted-foreground mb-1.5">Urgency</p>
        <div className="flex flex-wrap gap-1.5">
          {TIERS.map(t => (
            <button
              key={t.key}
              onClick={() => set({ minTier: t.key })}
              data-testid={`attention-tier-${t.key}`}
              aria-pressed={draft.minTier === t.key}
              className={`rounded-full border px-2 py-1 text-[11px] font-medium transition-colors ${
                draft.minTier === t.key ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={() => set({ ...DEFAULT_ATTENTION_CONFIG })}
        className="text-[11px] text-muted-foreground hover:text-foreground underline"
        data-testid="attention-filters-reset"
      >
        Reset to defaults
      </button>
    </div>
  );
}

export default AttentionFilters;
