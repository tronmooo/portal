// ─── Auto-save for an open edit form ─────────────────────────────────────────
//
// "When I press Edit and change something, save it right away" (owner request,
// 2026-11-19). An edit form used to hold every change until a Save button was
// pressed; closing the form, switching tabs or navigating away lost them.
//
// The form hands this hook a snapshot of its current values. Whenever the
// snapshot differs from the last one saved, the hook saves it shortly after
// the user stops typing (a pause, not every keystroke — a half-typed number
// is never sent while the next digit is on its way), one save at a time, and
// always ends on the latest values. `flush()` saves immediately; it runs on
// "Done" and when the form unmounts, so nothing typed is ever dropped.
//
// Rule 3 (navigation never writes) holds: nothing is written on mount — the
// first snapshot is the baseline, and only a user change after it saves.
import { useCallback, useEffect, useRef, useState } from "react";

export const AUTOSAVE_DELAY_MS = 700;

export type AutosaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

export function useAutosave<T>(opts: {
  /** The form is open. Closing it resets the baseline for the next opening. */
  enabled: boolean;
  /** The form's current values. */
  snapshot: T;
  /** Persist `snapshot`, given the last-saved `baseline`. Reject to report an error. */
  save: (snapshot: T, baseline: T) => Promise<void>;
  delayMs?: number;
}): { status: AutosaveStatus; flush: () => Promise<void>; opened: T | null; changedSinceOpen: boolean } {
  const { enabled, snapshot, delayMs = AUTOSAVE_DELAY_MS } = opts;
  const key = JSON.stringify(snapshot);
  const [status, setStatus] = useState<AutosaveStatus>("idle");

  const saveRef = useRef(opts.save);
  saveRef.current = opts.save;
  const latest = useRef<{ key: string; value: T }>({ key, value: snapshot });
  latest.current = { key, value: snapshot };
  const baseline = useRef<{ key: string; value: T } | null>(null);
  // What the form OPENED with. `baseline` moves forward with every save; this
  // does not, so "Undo changes" can put the form back where it started — an
  // auto-saving form has no Cancel to do that.
  const opened = useRef<{ key: string; value: T } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const run = useCallback(async (): Promise<void> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    // One save at a time; the loop picks up whatever was typed meanwhile.
    if (inFlight.current) { await inFlight.current; }
    while (baseline.current && latest.current.key !== baseline.current.key) {
      const sending = latest.current;
      const from = baseline.current;
      if (mounted.current) setStatus("saving");
      const p = saveRef.current(sending.value, from.value);
      inFlight.current = p.then(() => undefined, () => undefined);
      try {
        await p;
        baseline.current = sending;
        if (mounted.current) setStatus(latest.current.key === sending.key ? "saved" : "pending");
      } catch {
        if (mounted.current) setStatus("error");
        inFlight.current = null;
        return; // keep the baseline: the next change (or Done) retries
      }
      inFlight.current = null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      baseline.current = null;
      opened.current = null;
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      setStatus("idle");
      return;
    }
    // Opening the form: what it opened with is the baseline, not a change.
    if (!baseline.current) { baseline.current = { key, value: snapshot }; opened.current = baseline.current; return; }
    if (key === baseline.current.key) return;
    setStatus("pending");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; void run(); }, delayMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, delayMs, run]);

  // Leaving the page with a change still waiting on the pause: save it.
  useEffect(() => () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; void run(); }
  }, [run]);

  const flush = useCallback(async () => { if (baseline.current) await run(); }, [run]);
  return { status, flush, opened: opened.current?.value ?? null, changedSinceOpen: !!opened.current && opened.current.key !== key };
}

/** The short line an auto-saving form shows beside its Done button. */
export function autosaveStatusLabel(status: AutosaveStatus): string {
  switch (status) {
    case "pending":
    case "saving": return "Saving…";
    case "saved": return "Saved";
    case "error": return "Couldn't save — keep editing to retry";
    default: return "Changes save automatically";
  }
}
