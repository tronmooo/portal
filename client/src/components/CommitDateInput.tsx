// A date field that SAVES — and so never saves a date that is still being
// typed. See client/src/lib/date-input.ts for why a plain
// `onChange={e => save(e.target.value)}` on a date input is a bug.
//
//   · a complete day commits at once (a pick from the calendar popup, or the
//     last digit of a typed year);
//   · anything else is held as a draft: the field keeps what was typed and
//     nothing is written;
//   · leaving the field EMPTY commits "" (clear the date);
//   · leaving it half-typed commits nothing, puts the stored date back and
//     says why.
import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";
import { dateInputState, isCommittableDay, UNFINISHED_DATE_MESSAGE } from "@/lib/date-input";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange" | "defaultValue"> & {
  /** The stored day (YYYY-MM-DD) or "" for none. */
  value: string;
  /** Called with a whole day, or "" to clear. Never with a partial date. */
  onCommit: (day: string) => void;
};

export function CommitDateInput({ value, onCommit, onBlur, onKeyDown, ...rest }: Props) {
  const stored = String(value || "").slice(0, 10);
  const [draft, setDraft] = useState(stored);
  const [unfinished, setUnfinished] = useState(false);
  const testId = (rest as Record<string, unknown>)["data-testid"] as string | undefined;
  const focused = useRef(false);
  // What this field last asked to save, so a blur after a commit-on-change
  // does not send the same day twice.
  const lastCommitted = useRef(stored);

  // Follow the stored value (a refetch, a rollback, an edit elsewhere) — but
  // not while the user is typing: resetting a focused date input is exactly
  // what threw the keystrokes away.
  useEffect(() => {
    lastCommitted.current = stored;
    if (!focused.current) setDraft(stored);
  }, [stored]);

  const commit = (day: string) => {
    if (day === lastCommitted.current) return;
    lastCommitted.current = day;
    onCommit(day);
  };

  return (
    <>
      <input
        {...rest}
        type="date"
        value={draft}
        aria-invalid={unfinished || undefined}
        onFocus={(e) => { focused.current = true; rest.onFocus?.(e); }}
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next);
          setUnfinished(false);
          if (isCommittableDay(next)) commit(next);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          onKeyDown?.(e);
        }}
        onBlur={(e) => {
          focused.current = false;
          const state = dateInputState(e.target);
          if (state === "complete") commit(e.target.value);
          else if (state === "empty") commit("");
          else {
            // Half-typed: write nothing and show the stored date again.
            setUnfinished(true);
            setDraft(lastCommitted.current);
          }
          onBlur?.(e);
        }}
      />
      {unfinished && (
        <p role="alert" className="mt-1 text-[11px] text-destructive" data-testid={testId ? `${testId}-unfinished` : "date-unfinished"}>
          {UNFINISHED_DATE_MESSAGE} Nothing was changed.
        </p>
      )}
    </>
  );
}

export default CommitDateInput;
