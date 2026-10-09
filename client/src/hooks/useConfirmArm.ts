// ─── Two-tap confirmation for destructive / record-changing buttons ─────────
//
// Rule 9: a destructive operation needs an explicit user action. A labelled
// "Delete" that fires on the first tap is one stray touch away from losing a
// record, and on a phone a scroll that ends on a button IS a tap. The first
// tap arms the button ("Tap again to delete"); a second tap within the window
// runs the action; anything else disarms it. Same convention as the briefing's
// Pay button (ExecutiveBriefing ActionButton).
import { useCallback, useEffect, useRef, useState } from "react";

export const CONFIRM_WINDOW_MS = 4000;

export function useConfirmArm(windowMs: number = CONFIRM_WINDOW_MS) {
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  /** Tap handler: arms `key` on the first tap, runs `action` on the second. */
  const confirm = useCallback((key: string, action: () => void) => {
    if (timer.current) clearTimeout(timer.current);
    if (armedKey === key) {
      setArmedKey(null);
      action();
      return;
    }
    setArmedKey(key);
    timer.current = setTimeout(() => setArmedKey(null), windowMs);
  }, [armedKey, windowMs]);

  const isArmed = useCallback((key: string) => armedKey === key, [armedKey]);
  return { confirm, isArmed, disarm: () => setArmedKey(null) };
}
