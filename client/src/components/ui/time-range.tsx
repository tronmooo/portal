// The one time-frame picker. A pill segmented control: the active option
// takes the surrounding accent (--td-hs inside a tracker popup, the app's
// primary elsewhere). Used by the tracker popup and, over time, every screen
// that had its own 7d/30d buttons or dropdown.

export interface TimeRangeOption<T extends string> { value: T; label: string }

export function TimeRangeSelector<T extends string>({
  value, options, onChange, label = "Time frame", className = "", testId,
}: {
  value: T;
  options: ReadonlyArray<TimeRangeOption<T>>;
  onChange: (v: T) => void;
  label?: string;
  className?: string;
  testId?: string;
}) {
  return (
    <div className={`max-w-full overflow-x-auto overflow-y-hidden scrollbar-hide ${className}`} data-testid={testId}>
      <div className="td-seg" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            aria-pressed={o.value === value}
            className="td-seg-item"
            data-testid={testId ? `${testId}-${o.value}` : undefined}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
