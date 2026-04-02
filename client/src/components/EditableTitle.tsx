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
}

export default function EditableTitle({
  value,
  onSave,
  className = "",
  inputClassName = "",
  maxLength = 100,
  placeholder = "Untitled",
  disabled = false,
}: EditableTitleProps) {
  const [editing, setEditing] = useState(false);
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

  if (editing) {
    return (
      <div className="flex items-center gap-1 min-w-0">
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
            if (e.key === "Escape") handleCancel();
          }}
          maxLength={maxLength}
          placeholder={placeholder}
          disabled={saving}
          className={cn(
            "bg-transparent border-b border-primary/40 outline-none px-0 py-0.5 min-w-0 flex-1",
            inputClassName
          )}
        />
        <button
          onClick={handleSave}
          disabled={saving}
          className="shrink-0 p-0.5 rounded hover:bg-muted/50 text-primary"
          title="Save"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={handleCancel}
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
      <span className="truncate">{value || placeholder}</span>
      {!disabled && (
        <button
          onClick={() => setEditing(true)}
          className="shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity p-0.5 rounded hover:bg-muted/50 text-muted-foreground"
          title="Edit title"
          data-testid="button-edit-title"
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
