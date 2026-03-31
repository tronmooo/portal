// NOTE: This component is part of the Profile Type Registry system.
// It was built but not yet integrated into the main UI.
// The legacy tab system in profile-detail.tsx is the active system.
// Integration planned for a future release.

/**
 * DynamicProfileForm
 *
 * Renders a form dynamically based on a field_schema JSON array.
 * Fields are grouped by their `group` property. Fields without a group
 * go under "General". Supports all FieldDef types.
 */

import React, { useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface FieldDef {
  key: string;
  label: string;
  type:
    | "text"
    | "number"
    | "date"
    | "select"
    | "boolean"
    | "currency"
    | "percentage"
    | "phone"
    | "email"
    | "url"
    | "textarea";
  required?: boolean;
  default?: any;
  placeholder?: string;
  group?: string;
  options?: string[];
}

export interface DynamicProfileFormProps {
  fieldSchema: FieldDef[];
  values: Record<string, any>;
  onChange: (values: Record<string, any>) => void;
  disabled?: boolean;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function groupFields(fields: FieldDef[]): Map<string, FieldDef[]> {
  const map = new Map<string, FieldDef[]>();
  for (const field of fields) {
    const group = field.group ?? "General";
    if (!map.has(group)) map.set(group, []);
    map.get(group)!.push(field);
  }
  return map;
}

// ─────────────────────────────────────────────
// Field Renderers
// ─────────────────────────────────────────────

interface FieldProps {
  field: FieldDef;
  value: any;
  onChange: (key: string, val: any) => void;
  disabled?: boolean;
}

function FieldInput({ field, value, onChange, disabled }: FieldProps) {
  const val = value ?? field.default ?? "";

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    onChange(field.key, e.target.value);
  };

  switch (field.type) {
    case "textarea":
      return (
        <Textarea
          id={field.key}
          value={val}
          onChange={handleChange}
          placeholder={field.placeholder}
          disabled={disabled}
          className="resize-none"
          rows={3}
        />
      );

    case "boolean":
      return (
        <div className="flex items-center h-9 gap-2">
          <Checkbox
            id={field.key}
            checked={!!val}
            onCheckedChange={(checked) => onChange(field.key, !!checked)}
            disabled={disabled}
          />
          <Label
            htmlFor={field.key}
            className="text-sm font-normal text-muted-foreground cursor-pointer"
          >
            {val ? "Yes" : "No"}
          </Label>
        </div>
      );

    case "select":
      return (
        <Select
          value={val !== undefined && val !== null ? String(val) : ""}
          onValueChange={(v) => onChange(field.key, v)}
          disabled={disabled}
        >
          <SelectTrigger id={field.key}>
            <SelectValue placeholder={field.placeholder ?? `Select ${field.label}…`} />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );

    case "currency":
      return (
        <div className="flex items-center">
          <span className="inline-flex items-center h-9 px-3 rounded-l-md border border-r-0 border-input bg-muted text-muted-foreground text-sm select-none">
            $
          </span>
          <Input
            id={field.key}
            type="number"
            value={val}
            onChange={handleChange}
            placeholder={field.placeholder ?? "0.00"}
            disabled={disabled}
            step="0.01"
            className="rounded-l-none"
          />
        </div>
      );

    case "percentage":
      return (
        <div className="flex items-center">
          <Input
            id={field.key}
            type="number"
            value={val}
            onChange={handleChange}
            placeholder={field.placeholder ?? "0"}
            disabled={disabled}
            step="0.01"
            min="0"
            max="100"
            className="rounded-r-none"
          />
          <span className="inline-flex items-center h-9 px-3 rounded-r-md border border-l-0 border-input bg-muted text-muted-foreground text-sm select-none">
            %
          </span>
        </div>
      );

    case "number":
      return (
        <Input
          id={field.key}
          type="number"
          value={val}
          onChange={handleChange}
          placeholder={field.placeholder}
          disabled={disabled}
        />
      );

    case "date":
      return (
        <Input
          id={field.key}
          type="date"
          value={val}
          onChange={handleChange}
          disabled={disabled}
        />
      );

    case "phone":
      return (
        <Input
          id={field.key}
          type="tel"
          value={val}
          onChange={handleChange}
          placeholder={field.placeholder ?? "(555) 000-0000"}
          disabled={disabled}
        />
      );

    case "email":
      return (
        <Input
          id={field.key}
          type="email"
          value={val}
          onChange={handleChange}
          placeholder={field.placeholder ?? "name@example.com"}
          disabled={disabled}
        />
      );

    case "url":
      return (
        <Input
          id={field.key}
          type="url"
          value={val}
          onChange={handleChange}
          placeholder={field.placeholder ?? "https://"}
          disabled={disabled}
        />
      );

    default: // "text"
      return (
        <Input
          id={field.key}
          type="text"
          value={val}
          onChange={handleChange}
          placeholder={field.placeholder}
          disabled={disabled}
        />
      );
  }
}

// ─────────────────────────────────────────────
// FieldRow — label + input
// ─────────────────────────────────────────────

function FieldRow({ field, value, onChange, disabled }: FieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={field.type === "boolean" ? undefined : field.key} className="text-sm font-medium">
        {field.label}
        {field.required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>
      <FieldInput field={field} value={value} onChange={onChange} disabled={disabled} />
    </div>
  );
}

// ─────────────────────────────────────────────
// DynamicProfileForm
// ─────────────────────────────────────────────

export default function DynamicProfileForm({
  fieldSchema,
  values,
  onChange,
  disabled = false,
}: DynamicProfileFormProps) {
  const grouped = useMemo(() => groupFields(fieldSchema), [fieldSchema]);

  const handleFieldChange = (key: string, val: any) => {
    onChange({ ...values, [key]: val });
  };

  if (!fieldSchema || fieldSchema.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4 text-center">
        No fields defined for this profile type.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {Array.from(grouped.entries()).map(([group, fields]) => (
        <section key={group}>
          {/* Group header — only show if not the single default "General" group, or if multiple groups exist */}
          {(grouped.size > 1 || group !== "General") && (
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 pb-1 border-b">
              {group}
            </h3>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {fields.map((field) => (
              <div
                key={field.key}
                className={cn(
                  field.type === "textarea" ? "sm:col-span-2" : ""
                )}
              >
                <FieldRow
                  field={field}
                  value={values[field.key]}
                  onChange={handleFieldChange}
                  disabled={disabled}
                />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export { DynamicProfileForm };
