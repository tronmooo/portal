import { useState, useRef, useEffect } from "react";
import { Pencil, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface EditableTitleProps {
  value: string;
  onSave: (newValue: string) => Promise<void> | void;
  className?: string;
  inputClassName?: string;
  maxLength?: number;
  placeholder?: string;
  disabled?: boolean;
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  /** Applied to the text and to the input, so a test (or a screen reader
   *  label) can address the same element in both states. */
  testId?: string;
  /** Tooltip on the pencil — "Edit title" reads wrong on a person's name. */
  editLabel?: string;
}

export default function EditableTitle({
  value,
  onSave,
  className = "",
  inputClassName = "",
  maxLength = 100,
  placeholder = "Untitled",
  disabled = false,
  editing: externalEditing,
  onEditingChange,
  testId,
  editLabel = "Edit title",
}: EditableTitleProps) {
  const [internalEditing, setInternalEditing] = useState(false);
  const editing = externalEditing !== undefined ? externalEditing : internalEditing;
  const setEditing = (v: boolean) => {
    setInternalEditing(v);
    onEditingChange?.(v);
  };
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  // Sync if external value changes
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  const handleSave = async () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === value) {
      setDraft(value);
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(trimmed);
      setEditing(false);
    } catch {
      setDraft(value);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setDraft(value);
    setEditing(false);
  };

  // stopPropagation is critical: this control is often rendered inside a
  // larger clickable card (e.g. a document row whose parent <button> opens
  // the viewer). Without it, clicking the pencil or pressing Enter would
  // bubble up and trigger the parent click, swallowing the rename intent.
  const stop = (e: React.SyntheticEvent) => { e.stopPropagation(); };

  if (editing) {
    return (
      <div className="flex items-center gap-1 min-w-0" onClick={stop}>
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={stop}
          onMouseDown={stop}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") { e.preventDefault(); handleSave(); }
            if (e.key === "Escape") { e.preventDefault(); handleCancel(); }
          }}
          maxLength={maxLength}
          placeholder={placeholder}
          disabled={saving}
          aria-label={editLabel}
          data-testid={testId}
          className={cn(
            "bg-transparent border-b border-primary/40 outline-none px-0 py-0.5 min-w-0 flex-1",
            inputClassName
          )}
        />
        <button
          type="button"
          onClick={(e) => { stop(e); handleSave(); }}
          onMouseDown={stop}
          disabled={saving}
          className="shrink-0 p-0.5 rounded hover:bg-muted/50 text-primary"
          title="Save"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={(e) => { stop(e); handleCancel(); }}
          onMouseDown={stop}
          disabled={saving}
          className="shrink-0 p-0.5 rounded hover:bg-muted/50 text-muted-foreground"
          title="Cancel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <span className={cn("inline-flex items-center gap-1 group min-w-0", className)}>
      <span className="truncate" data-testid={testId}>{value || placeholder}</span>
      {!disabled && (
        <button
          type="button"
          onClick={(e) => { stop(e); setEditing(true); }}
          onMouseDown={stop}
          className="shrink-0 opacity-60 group-hover:opacity-100 focus:opacity-100 transition-opacity p-0.5 rounded hover:bg-muted/50 text-muted-foreground"
          title={editLabel}
          aria-label={editLabel}
          data-testid={testId ? `button-edit-${testId}` : "button-edit-title"}
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
