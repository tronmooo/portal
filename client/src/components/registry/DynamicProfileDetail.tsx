/**
 * DynamicProfileDetail
 *
 * Reads a profile's TypeDefinition and renders tabs driven by tab_config.
 * - Null engine → overview with key-value field display + inline edit
 * - String engine → EngineRenderer with the tab's field_map
 * - Always includes Documents sub-section and Activity/Timeline section
 */

import React, { useRef, useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Edit,
  FileText,
  Activity,
  Upload,
  Eye,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  ArrowLeft,
  Pencil,
  Check,
  X,
  Trash2,
  Clock,
  DollarSign,
  ListTodo,
  Calendar,
  Heart,
  CreditCard,
  ExternalLink,
  Plus,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import DynamicProfileForm from "./DynamicProfileForm";
import type { FieldDef } from "./DynamicProfileForm";
import type { TypeDefinition } from "./ProfileTypeSelector";
import { EngineRenderer } from "@/components/engines";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface DynamicProfileDetailProps {
  profile: any; // ProfileDetail from the API
  typeDef: TypeDefinition;
  onChanged: () => void;
}

interface TabConfig {
  key: string;
  label: string;
  engine: string | null;
  field_map?: Record<string, string>;
  icon?: string;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function formatKey(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim();
}

function formatValue(val: any, fieldDef?: FieldDef): string {
  if (val == null || val === "") return "—";
  if (typeof val === "boolean") return val ? "Yes" : "No";
  if (fieldDef?.type === "currency") {
    const num = Number(val);
    if (!isNaN(num)) return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(num);
  }
  if (fieldDef?.type === "percentage") {
    return `${val}%`;
  }
  if (fieldDef?.type === "date" && val) {
    try {
      return new Date(val).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    } catch { return String(val); }
  }
  return String(val);
}

function timelineIcon(type: string) {
  const map: Record<string, React.ElementType> = {
    tracker: Activity,
    expense: DollarSign,
    task: ListTodo,
    event: Calendar,
    document: FileText,
    note: FileText,
    habit: Heart,
    obligation: CreditCard,
  };
  const Icon = map[type] || Clock;
  return <Icon className="h-3.5 w-3.5" />;
}

function getExpirationStatus(doc: any): "expired" | "soon" | "ok" | null {
  const expField = doc.extractedData?.expirationDate || doc.extractedData?.expiry || doc.extractedData?.expiration;
  if (!expField) return null;
  const exp = new Date(expField as string);
  if (isNaN(exp.getTime())) return null;
  const diffDays = (exp.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  if (diffDays < 0) return "expired";
  if (diffDays <= 30) return "soon";
  return "ok";
}

function formatTimeAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

// ─────────────────────────────────────────────
// InlineEditField
// ─────────────────────────────────────────────

function InlineEditField({
  profileId,
  fieldKey,
  fieldValue,
  allFields,
  onSaved,
}: {
  profileId: string;
  fieldKey: string;
  fieldValue: string;
  allFields: Record<string, any>;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(fieldValue);
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  const mutation = useMutation({
    mutationFn: async (newVal: string) => {
      const num = Number(newVal);
      const parsed =
        newVal !== "" && !isNaN(num) && newVal.trim() !== "" ? num : newVal;
      const res = await apiRequest("PATCH", `/api/profiles/${profileId}`, {
        fields: { ...allFields, [fieldKey]: parsed },
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      setEditing(false);
      onSaved();
    },
    onError: () => {
      toast({ title: "Failed to update", variant: "destructive" });
      setValue(fieldValue);
      setEditing(false);
    },
  });

  React.useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const handleSave = () => {
    if (value.trim() === fieldValue) { setEditing(false); return; }
    mutation.mutate(value.trim());
  };

  if (editing) {
    return (
      <div className="flex items-center justify-between py-1.5 border-b border-border last:border-0 gap-2">
        <span className="text-xs text-muted-foreground shrink-0">{formatKey(fieldKey)}</span>
        <div className="flex items-center gap-1 flex-1 justify-end">
          <Input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
              if (e.key === "Escape") { setValue(fieldValue); setEditing(false); }
            }}
            className="h-7 text-xs text-right max-w-[200px]"
          />
          <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={handleSave} disabled={mutation.isPending}>
            <Check className="h-3 w-3 text-green-500" />
          </Button>
          <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => { setValue(fieldValue); setEditing(false); }}>
            <X className="h-3 w-3 text-muted-foreground" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between py-2 border-b border-border last:border-0 hover:bg-muted/30 -mx-2 px-2 rounded transition-colors group">
      <span className="text-xs text-muted-foreground shrink-0 min-w-[80px] cursor-pointer" onClick={() => setEditing(true)}>
        {formatKey(fieldKey)}
      </span>
      <div className="flex items-center gap-1.5 min-w-0 justify-end">
        <span className="text-sm font-medium text-right break-words cursor-pointer" onClick={() => setEditing(true)}>
          {fieldValue}
        </span>
        <Pencil className="h-2.5 w-2.5 text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 cursor-pointer" onClick={() => setEditing(true)} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// OverviewTab
// ─────────────────────────────────────────────

function OverviewTab({
  profile,
  typeDef,
  onChanged,
}: {
  profile: any;
  typeDef: TypeDefinition;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, any>>(profile.fields ?? {});
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const fields = profile.fields ?? {};
  const fieldSchema: FieldDef[] = typeDef.field_schema ?? [];

  // Build a lookup of field defs by key for formatting
  const fieldDefMap = React.useMemo(() => {
    const map: Record<string, FieldDef> = {};
    for (const f of fieldSchema) map[f.key] = f;
    return map;
  }, [fieldSchema]);

  // Group visible fields by their schema group
  const schemaFields = fieldSchema.filter((f) => {
    const val = fields[f.key];
    return val !== undefined && val !== null && val !== "";
  });

  // Fields that exist in data but not in schema
  const extraFieldKeys = Object.keys(fields).filter(
    (k) => !fieldDefMap[k] && fields[k] != null && fields[k] !== "" && typeof fields[k] !== "object" && !k.startsWith("_")
  );

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiRequest("PATCH", `/api/profiles/${profile.id}`, { fields: editValues });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profile.id, "detail"] });
      toast({ title: "Profile updated" });
      setEditing(false);
      onChanged();
    } catch (err: any) {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setEditValues(profile.fields ?? {});
    setEditing(false);
  };

  return (
    <div className="space-y-4">
      {/* Profile header card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-lg font-semibold truncate">{profile.name}</h2>
                <Badge variant="secondary" className="text-xs capitalize shrink-0">
                  {typeDef.label}
                </Badge>
              </div>
              {profile.parentProfile && (
                <Link href={`/profiles/${profile.parentProfile.id}`}>
                  <a className="text-xs text-primary hover:underline flex items-center gap-1 mt-1">
                    <ExternalLink className="h-3 w-3" />
                    {profile.parentProfile.name}
                  </a>
                </Link>
              )}
            </div>
            {!editing && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1 shrink-0"
                onClick={() => { setEditValues(profile.fields ?? {}); setEditing(true); }}
              >
                <Edit className="h-3 w-3" />
                Edit
              </Button>
            )}
          </div>
        </CardHeader>

        {editing ? (
          <CardContent className="pt-0">
            <DynamicProfileForm
              fieldSchema={fieldSchema}
              values={editValues}
              onChange={setEditValues}
              disabled={saving}
            />
            <div className="flex gap-2 justify-end mt-4 pt-4 border-t">
              <Button variant="outline" size="sm" onClick={handleCancelEdit} disabled={saving}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : "Save Changes"}
              </Button>
            </div>
          </CardContent>
        ) : null}
      </Card>

      {/* Schema fields — displayed as clean key-value grid */}
      {!editing && schemaFields.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Details</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8">
              {schemaFields.map((field) => (
                <div key={field.key} className="flex items-baseline justify-between py-2 border-b border-border last:border-0 gap-2">
                  <span className="text-xs text-muted-foreground shrink-0">{field.label}</span>
                  <span className="text-sm font-medium text-right">
                    {formatValue(fields[field.key], field)}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Extra fields (in data but not in schema) — inline-editable */}
      {!editing && extraFieldKeys.length > 0 && (
        <Card>
          <CardHeader className="py-2 px-4">
            <CardTitle className="text-xs font-semibold">Other Details</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3 pt-0">
            <div className="space-y-0">
              {extraFieldKeys.map((key) => (
                <InlineEditField
                  key={key}
                  profileId={profile.id}
                  fieldKey={key}
                  fieldValue={String(fields[key])}
                  allFields={fields}
                  onSaved={onChanged}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Notes */}
      {profile.notes && (
        <Card>
          <CardHeader className="py-2 px-4">
            <CardTitle className="text-xs font-semibold flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5 text-muted-foreground" />
              Notes
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3 pt-0">
            <p className="text-xs text-muted-foreground whitespace-pre-wrap">{profile.notes}</p>
          </CardContent>
        </Card>
      )}

      {/* Tags */}
      {profile.tags && profile.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {profile.tags.map((tag: string) => (
            <Badge key={tag} variant="outline" className="text-xs">
              {tag}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// DocumentsSection
// ─────────────────────────────────────────────

function DocumentsSection({
  documents,
  profileId,
  onUploaded,
}: {
  documents: any[];
  profileId: string;
  onUploaded: () => void;
}) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [viewingDoc, setViewingDoc] = useState<any | null>(null);
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null);
  const [expandedDocId, setExpandedDocId] = useState<string | null>(null);
  const [docSearch, setDocSearch] = useState("");

  const filteredDocs = docSearch
    ? documents.filter((d) => {
        const q = docSearch.toLowerCase();
        return (
          d.name?.toLowerCase().includes(q) ||
          d.type?.toLowerCase().includes(q)
        );
      })
    : documents;

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const toBase64 = (f: File): Promise<string> =>
        new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onload = () => res((reader.result as string).split(",")[1]);
          reader.onerror = rej;
          reader.readAsDataURL(f);
        });
      const fileData = await toBase64(file);
      const res = await apiRequest("POST", "/api/upload", {
        fileName: file.name,
        mimeType: file.type,
        fileData,
        profileId,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Document uploaded" });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      onUploaded();
    },
    onError: (err: Error) => {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (docId: string) => {
      await apiRequest("DELETE", `/api/documents/${docId}`);
    },
    onSuccess: () => {
      toast({ title: "Document deleted" });
      setDeletingDocId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", profileId, "detail"] });
      onUploaded();
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2">
        <input
          type="text"
          placeholder="Search documents…"
          value={docSearch}
          onChange={(e) => setDocSearch(e.target.value)}
          className="flex-1 h-8 px-3 rounded-md border border-border bg-background text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept="image/*,application/pdf,.doc,.docx,.txt"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) uploadMutation.mutate(file);
            e.target.value = "";
          }}
        />
        <Button
          size="sm"
          className="gap-1.5 text-xs h-8 shrink-0"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadMutation.isPending}
        >
          <Upload className="h-3.5 w-3.5" />
          {uploadMutation.isPending ? "Uploading…" : "Upload"}
        </Button>
      </div>

      {/* Document list */}
      {filteredDocs.length === 0 && documents.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <FileText className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No linked documents</p>
            <p className="text-xs text-muted-foreground mt-1">Upload a file to get started</p>
          </CardContent>
        </Card>
      ) : filteredDocs.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-center">
            <p className="text-sm text-muted-foreground">No documents match your search</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filteredDocs.map((doc) => {
            const expStatus = getExpirationStatus(doc);
            const expDate =
              doc.extractedData?.expirationDate ||
              doc.extractedData?.expiry ||
              doc.extractedData?.expiration;
            return (
              <Card
                key={doc.id}
                className={
                  expStatus === "expired"
                    ? "border-red-500/50 bg-red-500/5"
                    : expStatus === "soon"
                    ? "border-yellow-500/50 bg-yellow-500/5"
                    : ""
                }
              >
                <CardContent className="p-0">
                  <div className="p-3 flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-muted text-muted-foreground">
                      {doc.mimeType?.startsWith("image/") ? (
                        <Eye className="h-4 w-4" />
                      ) : (
                        <FileText className="h-4 w-4" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{doc.name}</p>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        {doc.type && (
                          <Badge variant="secondary" className="text-[10px] capitalize">
                            {doc.type}
                          </Badge>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {new Date(doc.createdAt).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </span>
                        {expStatus === "expired" && expDate && (
                          <Badge variant="destructive" className="text-[10px] gap-0.5">
                            <AlertCircle className="h-2.5 w-2.5" />
                            Expired
                          </Badge>
                        )}
                        {expStatus === "soon" && expDate && (
                          <Badge className="text-[10px] gap-0.5 bg-yellow-500/20 text-yellow-700 dark:text-yellow-400 border-yellow-500/30">
                            <AlertCircle className="h-2.5 w-2.5" />
                            Expiring soon
                          </Badge>
                        )}
                      </div>

                      {/* Expanded extracted data */}
                      {expandedDocId === doc.id && doc.extractedData && (
                        <div className="mt-2 space-y-0.5">
                          {Object.entries(doc.extractedData).map(([k, v]) => (
                            <div key={k} className="flex justify-between text-xs">
                              <span className="text-muted-foreground">{formatKey(k)}</span>
                              <span className="font-medium">{String(v)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex gap-1 shrink-0">
                      {doc.extractedData && Object.keys(doc.extractedData).length > 0 && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() =>
                            setExpandedDocId(expandedDocId === doc.id ? null : doc.id)
                          }
                        >
                          {expandedDocId === doc.id ? (
                            <ChevronUp className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => setDeletingDocId(doc.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Delete confirmation */}
      <AlertDialog open={!!deletingDocId} onOpenChange={(open) => !open && setDeletingDocId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete document?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
              onClick={() => deletingDocId && deleteMutation.mutate(deletingDocId)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─────────────────────────────────────────────
// ActivitySection
// ─────────────────────────────────────────────

function ActivitySection({ timeline }: { timeline: any[] }) {
  const timelineColors: Record<string, string> = {
    tracker: "bg-chart-1/10 text-chart-1",
    expense: "bg-chart-4/10 text-chart-4",
    task: "bg-chart-3/10 text-chart-3",
    event: "bg-chart-2/10 text-chart-2",
    document: "bg-primary/10 text-primary",
    habit: "bg-rose-500/10 text-rose-500",
    obligation: "bg-orange-500/10 text-orange-500",
  };

  if (!timeline || timeline.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        No activity recorded yet.
      </div>
    );
  }

  return (
    <div className="divide-y divide-border">
      {timeline.map((entry, i) => {
        const color = timelineColors[entry.type] || "bg-muted text-muted-foreground";
        return (
          <div key={`${entry.type}-${i}`} className="flex gap-3 py-3">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${color}`}
            >
              {timelineIcon(entry.type)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{entry.title}</p>
              {entry.description && (
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  {entry.description}
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                {new Date(entry.timestamp).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
            </div>
            <Badge variant="secondary" className="text-[10px] capitalize shrink-0 h-fit">
              {entry.type}
            </Badge>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────
// EngineTab — wraps EngineRenderer with field_map
// ─────────────────────────────────────────────

function EngineTab({
  profile,
  tab,
  onChanged,
}: {
  profile: any;
  tab: TabConfig;
  onChanged: () => void;
}) {
  if (!tab.engine) return null;

  return (
    <div className="space-y-4">
      <EngineRenderer
        engineName={tab.engine}
        fields={profile.fields ?? {}}
        fieldMap={tab.field_map ?? {}}
        profileName={profile.name}
      />
    </div>
  );
}

// ─────────────────────────────────────────────
// DynamicProfileDetail (main export)
// ─────────────────────────────────────────────

export default function DynamicProfileDetail({
  profile,
  typeDef,
  onChanged,
}: DynamicProfileDetailProps) {
  const tabConfig: TabConfig[] = typeDef.tab_config ?? [];

  // Always ensure we have an overview tab
  const hasOverview = tabConfig.some(
    (t) => t.engine === null || t.key === "overview" || t.key === "info"
  );

  const allTabs: TabConfig[] = hasOverview
    ? tabConfig
    : [
        { key: "overview", label: "Overview", engine: null },
        ...tabConfig,
      ];

  const defaultTab = allTabs[0]?.key ?? "overview";

  const documents = profile.relatedDocuments ?? profile.documents ?? [];
  const timeline = profile.timeline ?? profile.recentActivity ?? [];

  return (
    <Tabs defaultValue={defaultTab} className="w-full">
      <TabsList className="flex flex-wrap h-auto gap-1 mb-4">
        {allTabs.map((tab) => (
          <TabsTrigger key={tab.key} value={tab.key} className="text-xs">
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>

      {allTabs.map((tab) => (
        <TabsContent key={tab.key} value={tab.key} className="mt-0">
          <div className="space-y-6">
            {/* Main tab content */}
            {tab.engine === null ? (
              <OverviewTab profile={profile} typeDef={typeDef} onChanged={onChanged} />
            ) : (
              <EngineTab profile={profile} tab={tab} onChanged={onChanged} />
            )}

            {/* Documents sub-section (always present) */}
            <section>
              <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
                <FileText className="h-4 w-4 text-muted-foreground" />
                Documents
              </h3>
              <DocumentsSection
                documents={documents}
                profileId={profile.id}
                onUploaded={onChanged}
              />
            </section>

            {/* Activity / Timeline section (always present) */}
            <section>
              <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
                <Activity className="h-4 w-4 text-muted-foreground" />
                Activity
              </h3>
              <Card>
                <CardContent className="p-4">
                  <ActivitySection timeline={timeline} />
                </CardContent>
              </Card>
            </section>
          </div>
        </TabsContent>
      ))}
    </Tabs>
  );
}

export { DynamicProfileDetail };
