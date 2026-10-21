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
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
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
  // The client this tree renders with (one and the same in the app; a test's
  // own client in a test), so the write-through lands where the reader looks.
  const queryClient = useQueryClient();
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
      {/* 2026-10-21: Needs Attention is documents, renewals and deadlines —
          bills and tasks have their own cards — so the old Tasks / Habits /
          Today's events / Birthdays switches and the bill and task windows had
          nothing left to change. What
          remains is how far ahead to look and how urgent a row must be. */}
      <div className="space-y-1.5">
        <p className="micro-label text-muted-foreground">Needs Attention</p>
        <DayPicker label="Look ahead" value={draft.docsWithinDays} options={[7, 14, 30, 45, 60, 90]} onChange={v => set({ docsWithinDays: v })} testId="attention-days-docs" />
        <div className="flex flex-wrap gap-1.5 pt-0.5">
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
