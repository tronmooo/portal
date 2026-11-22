// Customize Executive: which cards show, their order, and quiet mode.
//
// One preference row (`exec_card_prefs`, shared/exec-card-prefs), saved to the
// account so the choice follows the user across sessions and devices. Opening
// the panel writes nothing (Rule 3); each control writes through at once.
import { ArrowDown, ArrowUp } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  DEFAULT_EXEC_CARD_PREFS, EXEC_CARD_HINTS, EXEC_CARD_TITLES, QUIET_MODE_CARDS,
  isExecCardVisible, moveExecCard, orderedExecCards, parseExecCardPrefs, setExecCardVisible,
  type ExecCardPrefs,
} from "@shared/exec-card-prefs";

export const EXEC_CARD_PREFS_KEY = "exec_card_prefs";
const QUERY_KEY = ["/api/preferences/exec_card_prefs"];

export function useExecCardPrefs(enabled = true) {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery<ExecCardPrefs>({
    queryKey: QUERY_KEY,
    enabled,
    queryFn: () => apiRequest("GET", `/api/preferences/${EXEC_CARD_PREFS_KEY}`)
      .then(r => r.json())
      .then(d => parseExecCardPrefs(d?.value)),
    staleTime: 5 * 60_000,
  });
  const save = useMutation({
    mutationFn: async (next: ExecCardPrefs) => {
      await apiRequest("PUT", `/api/preferences/${EXEC_CARD_PREFS_KEY}`, { value: JSON.stringify(next) });
      return next;
    },
    // Written through at once, so a switch feels like a switch.
    onMutate: (next) => { queryClient.setQueryData(QUERY_KEY, next); },
    onError: () => { queryClient.invalidateQueries({ queryKey: QUERY_KEY }); },
  });
  return {
    /** False only while the stored choice is still on its way, so the caller
     *  does not flash the default layout over a saved one. A failed read
     *  settles too (the defaults apply) — the dashboard never waits forever. */
    loaded: !enabled || !isPending,
    prefs: data ?? DEFAULT_EXEC_CARD_PREFS,
    setPrefs: (next: ExecCardPrefs) => {
      // The screen follows the tap; the save follows behind it.
      queryClient.setQueryData(QUERY_KEY, next);
      save.mutate(next);
    },
  };
}

function Switch({ on, onChange, label, testId }: { on: boolean; onChange: (v: boolean) => void; label: string; testId: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} data-testid={testId}
      className={`touch-hit relative shrink-0 h-5 w-9 rounded-full transition-colors ${on ? "bg-primary" : "bg-muted-foreground/30"}`}>
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}

export function ExecCustomize({ prefs, onChange, onClose }: {
  prefs: ExecCardPrefs; onChange: (next: ExecCardPrefs) => void; onClose: () => void;
}) {
  const order = orderedExecCards(prefs);
  const shown = order.filter((id) => isExecCardVisible(prefs, id)).length;
  return (
    <div className="mt-2 bubble px-3 py-3 space-y-3" data-testid="exec-customize">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-bold">Customize Executive</p>
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => onChange({ ...DEFAULT_EXEC_CARD_PREFS })}
            className="text-[11px] text-muted-foreground hover:text-foreground underline" data-testid="exec-customize-reset">Reset</button>
          <button type="button" onClick={onClose}
            className="text-[11px] font-semibold text-primary" data-testid="exec-customize-done">Done</button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold leading-tight">Quiet mode</p>
          <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">
            Only {QUIET_MODE_CARDS.map((id) => EXEC_CARD_TITLES[id]).join(", ")}. Everything else stays one tap away.
          </p>
        </div>
        <Switch on={prefs.quiet} onChange={(v) => onChange({ ...prefs, quiet: v })} label="Quiet mode" testId="exec-customize-quiet" />
      </div>

      <ul className="space-y-1.5">
        {order.map((id, i) => {
          const on = isExecCardVisible(prefs, id);
          return (
            <li key={id} className="flex items-center gap-2 min-w-0" data-testid={`exec-customize-row-${id}`}>
              <div className="flex-1 min-w-0">
                <p className={`text-[13px] font-semibold leading-tight truncate ${on ? "" : "text-muted-foreground"}`}>{EXEC_CARD_TITLES[id]}</p>
                <p className="text-[11px] text-muted-foreground leading-tight truncate">{EXEC_CARD_HINTS[id]}</p>
              </div>
              <button type="button" disabled={i === 0} onClick={() => onChange(moveExecCard(prefs, id, -1))}
                aria-label={`Move ${EXEC_CARD_TITLES[id]} up`} data-testid={`exec-customize-up-${id}`}
                className="touch-hit shrink-0 rounded-md border border-border p-1 text-muted-foreground hover:bg-muted disabled:opacity-30">
                <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button type="button" disabled={i === order.length - 1} onClick={() => onChange(moveExecCard(prefs, id, 1))}
                aria-label={`Move ${EXEC_CARD_TITLES[id]} down`} data-testid={`exec-customize-down-${id}`}
                className="touch-hit shrink-0 rounded-md border border-border p-1 text-muted-foreground hover:bg-muted disabled:opacity-30">
                <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <Switch on={on} onChange={(v) => onChange(setExecCardVisible(prefs, id, v))}
                label={`Show ${EXEC_CARD_TITLES[id]}`} testId={`exec-customize-show-${id}`} />
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-muted-foreground" data-testid="exec-customize-summary">
        {shown} of {order.length} cards showing · saved to your account
      </p>
    </div>
  );
}

export default ExecCustomize;
