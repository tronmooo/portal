import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Send,
  Activity,
  User,
  ListTodo,
  DollarSign,
  CalendarDays,
  Sparkles,
  Bot,
  Paperclip,
  FileText,
  X,
  Plus,
  Loader2,
  Check,
  Calendar,
  Camera,
  Target,
  Flame,
  BookOpen,
  RotateCcw,
  Pencil,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import type { ChatMessage, ParsedAction, Profile, ChartSpec, TableSpec, ReportSpec } from "@shared/schema";
import DocumentViewer, { ShareButton } from "@/components/DocumentViewer";
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent } from "@/components/ui/chart";
import type { ChartConfig } from "@/components/ui/chart";
import { CHART_COLOR_ARRAY } from "@/lib/chart-colors";
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell,
  ScatterChart, Scatter, RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ComposedChart, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";

const SUGGESTIONS = [
  "I ate a chicken sandwich and ran 2 miles",
  "Track my blood pressure",
  "Spent $50 on groceries",
  "Add my cat Luna",
  "Remind me to call the dentist by Friday",
  "What's my weight trend?",
  "Open my drivers license",
  "Log sleep: 7.5 hours",
];

const PROFILE_TYPE_COLORS: Record<string, string> = {
  person: "bg-primary/10 text-primary",
  self: "bg-primary/10 text-primary",
  pet: "bg-chart-3/10 text-chart-3",
  vehicle: "bg-chart-2/10 text-chart-2",
  asset: "bg-chart-4/10 text-chart-4",
  loan: "bg-destructive/10 text-destructive",
  investment: "bg-chart-3/10 text-chart-3",
  subscription: "bg-chart-5/10 text-chart-5",
  medical: "bg-destructive/10 text-destructive",
  account: "bg-chart-1/10 text-chart-1",
  property: "bg-chart-1/10 text-chart-1",
};

function ProfileTypeBadge({ type }: { type: string }) {
  const colorClass = PROFILE_TYPE_COLORS[type] ?? "bg-muted text-muted-foreground";
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${colorClass}`}>
      {type}
    </span>
  );
}

function actionIcon(type: string) {
  switch (type) {
    case "create_tracker":
    case "log_entry":
      return <Activity className="h-3 w-3" />;
    case "create_profile":
    case "update_profile":
      return <User className="h-3 w-3" />;
    case "create_task":
      return <ListTodo className="h-3 w-3" />;
    case "log_expense":
      return <DollarSign className="h-3 w-3" />;
    case "create_event":
      return <CalendarDays className="h-3 w-3" />;
    case "create_goal":
      return <Target className="h-3 w-3" />;
    case "create_habit":
    case "checkin_habit":
      return <Flame className="h-3 w-3" />;
    case "journal_entry":
      return <BookOpen className="h-3 w-3" />;
    case "create_obligation":
    case "pay_obligation":
      return <DollarSign className="h-3 w-3" />;
    default:
      return <Sparkles className="h-3 w-3" />;
  }
}

function actionLabel(type: string) {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Inline document previews in chat messages ─────────────────────────────────
function LazyDocumentPreview({ id, name, mimeType, data }: { id: string; name: string; mimeType: string; data: string }) {
  const [imageData, setImageData] = useState<string>(data === "__LAZY_LOAD__" ? "" : data);
  const [loading, setLoading] = useState(data === "__LAZY_LOAD__");

  useEffect(() => {
    if (data === "__LAZY_LOAD__" && !imageData) {
      apiRequest("GET", `/api/documents/${id}`)
        .then(res => res.json())
        .then(doc => {
          if (doc.fileData) setImageData(doc.fileData);
          setLoading(false);
        })
        .catch(() => setLoading(false));
    }
  }, [id, data]);

  if (loading) {
    return (
      <div className="mt-3 rounded-xl border border-border bg-muted/10 p-8 flex items-center justify-center">
        <div className="animate-spin h-5 w-5 border-2 border-primary border-t-transparent rounded-full" />
        <span className="ml-2 text-xs text-muted-foreground">Loading {name}...</span>
      </div>
    );
  }

  if (!imageData) return null;

  return <DocumentViewer id={id} name={name} mimeType={mimeType} data={imageData} inline />;
}

function ChatDocumentPreviews({
  documentPreview,
  documentPreviews,
}: {
  documentPreview?: ChatMessage["documentPreview"];
  documentPreviews?: ChatMessage["documentPreviews"];
}) {
  const allPreviews: Array<{ id: string; name: string; mimeType: string; data: string }> = [];
  const seen = new Set<string>();

  if (documentPreviews && documentPreviews.length > 0) {
    for (const p of documentPreviews) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        allPreviews.push(p);
      }
    }
  } else if (documentPreview) {
    allPreviews.push(documentPreview);
  }

  if (allPreviews.length === 0) return null;

  return (
    <div className="space-y-2">
      {allPreviews.map((doc) => (
        <LazyDocumentPreview key={doc.id} id={doc.id} name={doc.name} mimeType={doc.mimeType} data={doc.data} />
      ))}
    </div>
  );
}

// ── Extraction Confirmation UI (two-phase extraction) ───────────────────────
function ExtractionConfirmation({
  extraction,
  onConfirm,
  onSkip,
}: {
  extraction: NonNullable<ChatMessage["pendingExtraction"]>;
  onConfirm: (data: {
    extractionId: string;
    confirmedFields: Array<{ key: string; value: any }>;
    targetProfileId?: string;
    createCalendarEvents: Array<{ field: string; date: string; title: string; category: string }>;
    trackerEntries: any[];
  }) => Promise<boolean>;
  onSkip: () => void;
}) {
  const [fields, setFields] = useState(
    () => extraction.extractedFields.map((f) => ({ ...f }))
  );
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState<string | undefined>(extraction.targetProfile?.id);

  // Fetch profiles for the dropdown
  const { data: allProfiles = [] } = useQuery<any[]>({
    queryKey: ["/api/profiles"],
  });

  const toggleField = (idx: number) => {
    setFields((prev) => prev.map((f, i) => i === idx ? { ...f, selected: !f.selected } : f));
  };

  const handleConfirm = async () => {
    setConfirming(true);
    const confirmedFields = fields.filter((f) => f.selected && !f.isDate && f.key).map((f) => ({ key: f.key, value: f.value }));
    const createCalendarEvents = fields
      .filter((f) => f.selected && f.isDate && f.suggestedEvent && f.key && f.value)
      .map((f) => ({
        field: f.key,
        date: String(f.value),
        title: f.suggestedEvent!,
        category: /expir|renew/i.test(f.key || "") ? "finance" : /appoint|visit/i.test(f.key || "") ? "health" : "other",
      }));
    const success = await onConfirm({
      extractionId: extraction.extractionId,
      confirmedFields,
      targetProfileId: selectedProfileId || extraction.targetProfile?.id,
      createCalendarEvents,
      trackerEntries: extraction.trackerEntries || [],
    });
    if (success) {
      setConfirmed(true);
    }
    setConfirming(false);
  };

  if (confirmed) {
    return (
      <div className="mt-2 p-3 rounded-lg bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800">
        <div className="flex items-center gap-2 text-green-700 dark:text-green-400 text-xs font-medium">
          <Check className="h-3.5 w-3.5" />
          Extraction confirmed and saved
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 p-3 rounded-lg bg-muted/50 border border-border space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-foreground">
          Review extracted data
        </span>
        <select
          className="text-xs bg-muted border border-border rounded px-1.5 py-0.5 text-foreground max-w-[140px]"
          value={selectedProfileId || ""}
          onChange={(e) => setSelectedProfileId(e.target.value || undefined)}
          data-testid="select-extraction-profile"
        >
          <option value="">Link to profile...</option>
          {allProfiles.map((p: any) => (
            <option key={p.id} value={p.id}>{p.name} ({p.type})</option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        {fields.map((field, idx) => (
          <label
            key={field.key}
            className="flex items-start gap-2 cursor-pointer group"
          >
            <Checkbox
              checked={field.selected}
              onCheckedChange={() => toggleField(idx)}
              className="mt-0.5"
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-foreground capitalize">
                  {field.label}
                </span>
                {field.isDate && field.suggestedEvent && (
                  <Calendar className="h-3 w-3 text-blue-500" />
                )}
              </div>
              <span className="text-xs-loose text-muted-foreground truncate block">
                {typeof field.value === 'object' && field.value !== null
                  ? JSON.stringify(field.value).replace(/[{}"/]/g, '').replace(/,/g, ', ')
                  : String(field.value)}
              </span>
              {field.isDate && field.suggestedEvent && field.selected && (
                <span className="text-xs text-blue-600 dark:text-blue-400">
                  Will create: {field.suggestedEvent}
                </span>
              )}
            </div>
          </label>
        ))}
      </div>

      {extraction.trackerEntries && extraction.trackerEntries.length > 0 && (
        <div className="pt-1.5 border-t border-border/50">
          <span className="text-xs text-muted-foreground font-medium">Tracker entries:</span>
          {extraction.trackerEntries.map((entry: any, idx: number) => (
            <div key={idx} className="text-xs-loose text-foreground ml-2">
              {entry.trackerName}: {JSON.stringify(entry.values)}
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          className="h-7 text-xs"
          onClick={() => handleConfirm()}
          disabled={confirming || fields.every((f) => !f.selected)}
        >
          {confirming ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Check className="h-3 w-3 mr-1" />}
          Confirm
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={onSkip}
          disabled={confirming}
        >
          Skip
        </Button>
      </div>
    </div>
  );
}

// ── Attachment type ──────────────────────────────────────────────────────────
interface StagedAttachment {
  name: string;
  mimeType: string;
  data: string; // base64
  previewUrl: string;
  profileId: string; // "none" | profileId
}

// ── Single-file Attachment staging panel (shown before send) ─────────────────
interface AttachmentPanelProps {
  attachment: {
    name: string;
    mimeType: string;
    data: string;
    previewUrl: string;
  };
  profiles: Profile[];
  profilesLoading: boolean;
  selectedProfileId: string;
  onProfileChange: (id: string) => void;
  onRemove: () => void;
  note: string;
  onNoteChange: (v: string) => void;
  onSend: () => void;
  isSending: boolean;
}

function AttachmentPanel({
  attachment,
  profiles,
  profilesLoading,
  selectedProfileId,
  onProfileChange,
  onRemove,
  note,
  onNoteChange,
  onSend,
  isSending,
}: AttachmentPanelProps) {
  const isImage = attachment.mimeType.startsWith("image/");

  return (
    <div
      className="px-4 pb-3"
      data-testid="attachment-panel"
    >
      <div className="max-w-2xl mx-auto">
        <div className="bg-card border border-border rounded-2xl p-4 space-y-3">
          {/* File preview */}
          <div className="flex items-start gap-3">
            <div className="shrink-0">
              {isImage ? (
                <img
                  src={attachment.previewUrl}
                  alt={attachment.name}
                  className="h-16 w-16 rounded-lg object-cover border border-border"
                  data-testid="attachment-image-preview"
                />
              ) : (
                <div
                  className="h-16 w-16 rounded-lg border border-border bg-muted flex items-center justify-center"
                  data-testid="attachment-pdf-icon"
                >
                  <FileText className="h-7 w-7 text-muted-foreground" />
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{attachment.name}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {attachment.mimeType}
              </p>
            </div>
            <button
              onClick={onRemove}
              className="p-1 hover:bg-muted rounded-md transition-colors shrink-0"
              data-testid="button-remove-attachment"
              aria-label="Remove attachment"
            >
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>

          {/* Profile selector — multi-select checkboxes */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Link to profiles
            </label>
            <div className="rounded-lg border border-border max-h-[200px] overflow-y-auto" style={{ WebkitOverflowScrolling: 'touch' }}>
              {profiles.map((profile) => {
                const isChecked = selectedProfileId.split(",").filter(Boolean).includes(profile.id);
                return (
                  <label
                    key={profile.id}
                    className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-muted/50 transition-colors border-b border-border/30 last:border-0 ${isChecked ? "bg-primary/5" : ""}`}
                    data-testid={`select-profile-${profile.id}`}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => {
                        const current = selectedProfileId.split(",").filter(Boolean);
                        const next = isChecked
                          ? current.filter(id => id !== profile.id)
                          : [...current, profile.id];
                        onProfileChange(next.length > 0 ? next.join(",") : "none");
                      }}
                      className="h-4 w-4 rounded border-border accent-primary"
                      disabled={isSending}
                    />
                    <span className="text-sm flex-1">{profile.name}</span>
                    <ProfileTypeBadge type={profile.type} />
                  </label>
                );
              })}
            </div>
            {selectedProfileId !== "none" && selectedProfileId !== "" && (
              <p className="text-xs text-muted-foreground">
                {selectedProfileId.split(",").filter(Boolean).length} profile(s) selected
              </p>
            )}
          </div>

          {/* Optional note */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Notes (optional)
            </label>
            <Textarea
              value={note}
              onChange={(e) => onNoteChange(e.target.value)}
              placeholder="Add a note about this file..."
              className="min-h-[60px] max-h-[100px] resize-none rounded-xl bg-background text-sm"
              rows={2}
              disabled={isSending}
              data-testid="input-attachment-note"
            />
          </div>

          {/* Send button */}
          <Button
            onClick={onSend}
            disabled={isSending}
            className="w-full rounded-xl"
            data-testid="button-send-attachment"
          >
            <Send className="h-4 w-4 mr-2" />
            {isSending ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Batch Attachment Panel (multiple files) ──────────────────────────────────
interface BatchAttachmentPanelProps {
  attachments: StagedAttachment[];
  profiles: Profile[];
  profilesLoading: boolean;
  onProfileChange: (index: number, profileId: string) => void;
  onGlobalProfileChange: (profileId: string) => void;
  onRemove: (index: number) => void;
  onAddMore: () => void;
  note: string;
  onNoteChange: (v: string) => void;
  onSend: () => void;
  isSending: boolean;
  processedCount: number;
}

function BatchAttachmentPanel({
  attachments,
  profiles,
  profilesLoading,
  onProfileChange,
  onGlobalProfileChange,
  onRemove,
  onAddMore,
  note,
  onNoteChange,
  onSend,
  isSending,
  processedCount,
}: BatchAttachmentPanelProps) {
  return (
    <div className="px-4 pb-3" data-testid="batch-attachment-panel">
      <div className="max-w-2xl mx-auto">
        <div className="bg-card border border-border rounded-2xl p-4 space-y-3">
          {/* Header with count and global profile selector */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Paperclip className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium" data-testid="text-batch-count">
                {attachments.length} file{attachments.length !== 1 ? "s" : ""} ready to upload
              </span>
            </div>
            <button
              onClick={onAddMore}
              className="flex items-center gap-1 text-xs text-primary hover:underline"
              data-testid="button-add-more-files"
              disabled={isSending}
            >
              <Plus className="h-3 w-3" />
              Add more
            </button>
          </div>

          {/* Global "Link all to" selector */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Link all to:
            </label>
            <Select
              onValueChange={onGlobalProfileChange}
              disabled={profilesLoading || isSending}
            >
              <SelectTrigger
                className="w-full h-8 text-xs"
                data-testid="select-batch-global-profile"
              >
                <SelectValue placeholder="Individual assignment (default)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none" data-testid="select-batch-profile-none">
                  Don't link to a profile
                </SelectItem>
                {profiles.map((profile) => (
                  <SelectItem
                    key={profile.id}
                    value={profile.id}
                    data-testid={`select-batch-profile-${profile.id}`}
                  >
                    <span className="flex items-center gap-2">
                      {profile.name}
                      <ProfileTypeBadge type={profile.type} />
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* File grid */}
          <div
            className="grid gap-2"
            style={{
              gridTemplateColumns: `repeat(${attachments.some(a => !a.mimeType.startsWith("image/")) ? 2 : Math.min(attachments.length, 4)}, 1fr)`,
            }}
            data-testid="batch-file-grid"
          >
            {attachments.map((att, idx) => {
              const isImage = att.mimeType.startsWith("image/");
              return (
                <div
                  key={`${att.name}-${idx}`}
                  className="relative bg-background border border-border rounded-xl p-2 space-y-1.5 group"
                  data-testid={`batch-file-tile-${idx}`}
                >
                  {/* Remove button */}
                  <button
                    onClick={() => onRemove(idx)}
                    className="absolute -top-1.5 -right-1.5 p-0.5 bg-card border border-border rounded-full opacity-0 group-hover:opacity-100 transition-opacity z-10"
                    data-testid={`button-remove-batch-file-${idx}`}
                    aria-label={`Remove ${att.name}`}
                    disabled={isSending}
                  >
                    <X className="h-3 w-3 text-muted-foreground" />
                  </button>

                  {/* Thumbnail */}
                  {isImage ? (
                    <img
                      src={att.previewUrl}
                      alt={att.name}
                      className="w-full aspect-square object-cover rounded-lg"
                      data-testid={`batch-image-preview-${idx}`}
                    />
                  ) : (
                    <div
                      className="w-full aspect-square rounded-lg bg-muted flex items-center justify-center"
                      data-testid={`batch-pdf-icon-${idx}`}
                    >
                      <FileText className="h-8 w-8 text-muted-foreground" />
                    </div>
                  )}

                  {/* Filename (truncated) */}
                  <p
                    className="text-xs-loose font-medium truncate px-0.5"
                    title={att.name}
                    data-testid={`text-batch-filename-${idx}`}
                  >
                    {att.name}
                  </p>

                  {/* Per-file profile selector */}
                  <Select
                    value={att.profileId}
                    onValueChange={(val) => onProfileChange(idx, val)}
                    disabled={profilesLoading || isSending}
                  >
                    <SelectTrigger
                      className="w-full h-7 text-xs"
                      data-testid={`select-batch-file-profile-${idx}`}
                    >
                      <SelectValue placeholder="No profile" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No profile</SelectItem>
                      {profiles.map((profile) => (
                        <SelectItem key={profile.id} value={profile.id}>
                          <span className="flex items-center gap-1">
                            {profile.name}
                            <ProfileTypeBadge type={profile.type} />
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
          </div>

          {/* Optional note */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Notes (optional)
            </label>
            <Textarea
              value={note}
              onChange={(e) => onNoteChange(e.target.value)}
              placeholder="Add a note about these files..."
              className="min-h-[50px] max-h-[80px] resize-none rounded-xl bg-background text-sm"
              rows={2}
              disabled={isSending}
              data-testid="input-batch-note"
            />
          </div>

          {/* Upload All button */}
          <Button
            onClick={onSend}
            disabled={isSending}
            className="w-full rounded-xl"
            data-testid="button-upload-all"
          >
            {isSending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Processing {processedCount}/{attachments.length}…
              </>
            ) : (
              <>
                <Send className="h-4 w-4 mr-2" />
                Upload All ({attachments.length} file{attachments.length !== 1 ? "s" : ""})
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Rich Content Components ──────────────────────────────────────────────────

const FALLBACK_COLORS = [
  "hsl(220, 70%, 55%)", "hsl(150, 60%, 45%)", "hsl(30, 80%, 55%)",
  "hsl(280, 60%, 55%)", "hsl(0, 70%, 55%)", "hsl(190, 70%, 45%)",
  "hsl(50, 80%, 50%)", "hsl(330, 60%, 55%)",
];

function getSeriesColor(index: number, explicit?: string): string {
  if (explicit) return explicit;
  const arr = CHART_COLOR_ARRAY as readonly string[];
  return arr[index % arr.length] || FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

function ChatChart({ spec }: { spec: ChartSpec }) {
  const { type, title, subtitle, data, series, xAxisKey, xAxisLabel, yAxisLabel, showLegend, showGrid, nameKey, valueKey } = spec;
  if (!data || data.length === 0) return null;

  const height = spec.height || 260;
  const config: ChartConfig = {};
  (series || []).forEach((s, i) => {
    config[s.dataKey] = { label: s.name, color: getSeriesColor(i, s.color) };
  });
  if (type === "pie" && nameKey && valueKey) {
    data.forEach((d, i) => {
      const key = String(d[nameKey]);
      config[key] = { label: key, color: getSeriesColor(i) };
    });
  }

  const renderChart = () => {
    switch (type) {
      case "line":
        return (
          <LineChart data={data}>
            {showGrid !== false && <CartesianGrid strokeDasharray="3 3" />}
            <XAxis dataKey={xAxisKey} label={xAxisLabel ? { value: xAxisLabel, position: "insideBottom", offset: -5 } : undefined} tick={{ fontSize: 11 }} />
            <YAxis label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: "insideLeft" } : undefined} tick={{ fontSize: 11 }} />
            <ChartTooltip content={<ChartTooltipContent />} />
            {showLegend !== false && series.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
            {series.map((s, i) => (
              <Line key={s.dataKey} type="monotone" dataKey={s.dataKey} name={s.name} stroke={getSeriesColor(i, s.color)} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
            ))}
          </LineChart>
        );
      case "bar":
        return (
          <BarChart data={data}>
            {showGrid !== false && <CartesianGrid strokeDasharray="3 3" />}
            <XAxis dataKey={xAxisKey} tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <ChartTooltip content={<ChartTooltipContent />} />
            {showLegend !== false && series.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
            {series.map((s, i) => (
              <Bar key={s.dataKey} dataKey={s.dataKey} name={s.name} fill={getSeriesColor(i, s.color)} radius={[4, 4, 0, 0]} stackId={s.stackId} />
            ))}
          </BarChart>
        );
      case "area":
        return (
          <AreaChart data={data}>
            {showGrid !== false && <CartesianGrid strokeDasharray="3 3" />}
            <XAxis dataKey={xAxisKey} tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <ChartTooltip content={<ChartTooltipContent />} />
            {showLegend !== false && series.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
            {series.map((s, i) => (
              <Area key={s.dataKey} type="monotone" dataKey={s.dataKey} name={s.name} fill={getSeriesColor(i, s.color)} stroke={getSeriesColor(i, s.color)} fillOpacity={0.3} />
            ))}
          </AreaChart>
        );
      case "pie": {
        const nk = nameKey || "name";
        const vk = valueKey || "value";
        return (
          <PieChart>
            <Pie data={data} dataKey={vk} nameKey={nk} cx="50%" cy="50%" outerRadius={80} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={{ strokeWidth: 1 }}>
              {data.map((_, i) => (
                <Cell key={i} fill={getSeriesColor(i)} />
              ))}
            </Pie>
            <ChartTooltip content={<ChartTooltipContent />} />
            {showLegend !== false && <ChartLegend content={<ChartLegendContent />} />}
          </PieChart>
        );
      }
      case "scatter":
        return (
          <ScatterChart>
            {showGrid !== false && <CartesianGrid strokeDasharray="3 3" />}
            <XAxis dataKey={xAxisKey} name={xAxisLabel || xAxisKey} tick={{ fontSize: 11 }} />
            <YAxis dataKey={series[0]?.dataKey} name={yAxisLabel || series[0]?.name} tick={{ fontSize: 11 }} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Scatter data={data} fill={getSeriesColor(0, series[0]?.color)} />
          </ScatterChart>
        );
      case "radar": {
        const radarKey = series[0]?.dataKey || "value";
        return (
          <RadarChart data={data} cx="50%" cy="50%" outerRadius={80}>
            <PolarGrid />
            <PolarAngleAxis dataKey={xAxisKey || "label"} tick={{ fontSize: 11 }} />
            <PolarRadiusAxis tick={{ fontSize: 10 }} />
            {series.map((s, i) => (
              <Radar key={s.dataKey} dataKey={s.dataKey} name={s.name} stroke={getSeriesColor(i, s.color)} fill={getSeriesColor(i, s.color)} fillOpacity={0.3} />
            ))}
            {showLegend !== false && series.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
          </RadarChart>
        );
      }
      case "composed":
        return (
          <ComposedChart data={data}>
            {showGrid !== false && <CartesianGrid strokeDasharray="3 3" />}
            <XAxis dataKey={xAxisKey} tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <ChartTooltip content={<ChartTooltipContent />} />
            {showLegend !== false && <ChartLegend content={<ChartLegendContent />} />}
            {series.map((s, i) => {
              const color = getSeriesColor(i, s.color);
              if (s.type === "area") return <Area key={s.dataKey} type="monotone" dataKey={s.dataKey} name={s.name} fill={color} stroke={color} fillOpacity={0.3} />;
              if (s.type === "line") return <Line key={s.dataKey} type="monotone" dataKey={s.dataKey} name={s.name} stroke={color} strokeWidth={2} dot={false} />;
              return <Bar key={s.dataKey} dataKey={s.dataKey} name={s.name} fill={color} radius={[4, 4, 0, 0]} />;
            })}
          </ComposedChart>
        );
      default:
        return null;
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-border/60 bg-background/50 p-3">
      <div className="mb-2">
        <h4 className="text-sm font-semibold">{title}</h4>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      <ChartContainer config={config} className="h-[260px] w-full">
        {renderChart()!}
      </ChartContainer>
    </div>
  );
}

function ChatTable({ spec }: { spec: TableSpec }) {
  const { title, columns, rows, summary } = spec;
  if (!rows || rows.length === 0) return null;

  const formatValue = (value: any, format?: string) => {
    if (value == null || value === "") return "—";
    switch (format) {
      case "currency": return `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      case "date": return new Date(value).toLocaleDateString();
      case "number": return Number(value).toLocaleString();
      case "percent": return `${Number(value).toFixed(1)}%`;
      default: return String(value);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-border/60 bg-background/50 overflow-hidden">
      <div className="px-3 py-2 border-b border-border/40">
        <h4 className="text-sm font-semibold">{title}</h4>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border/40 bg-muted/30">
              {columns.map((col) => (
                <th key={col.key} className={`px-3 py-2 font-medium text-muted-foreground ${col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left"}`}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 20).map((row, ri) => (
              <tr key={ri} className="border-b border-border/20 hover:bg-muted/20">
                {columns.map((col) => (
                  <td key={col.key} className={`px-3 py-1.5 ${col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left"}`}>
                    {formatValue(row[col.key], col.format)}
                  </td>
                ))}
              </tr>
            ))}
            {summary && (
              <tr className="border-t border-border/60 bg-muted/30 font-medium">
                {columns.map((col, ci) => (
                  <td key={col.key} className={`px-3 py-2 ${col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left"}`}>
                    {ci === 0 && !summary[col.key] ? "Total" : formatValue(summary[col.key], col.format)}
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {rows.length > 20 && (
        <div className="px-3 py-1.5 text-xs text-muted-foreground border-t border-border/40">
          Showing 20 of {rows.length} rows
        </div>
      )}
    </div>
  );
}

function ChatReport({ spec }: { spec: ReportSpec }) {
  const { title, subtitle, sections } = spec;
  if (!sections || sections.length === 0) return null;

  return (
    <div className="mt-3 rounded-lg border border-border/60 bg-background/50 overflow-hidden">
      <div className="px-4 py-3 border-b border-border/40 bg-muted/20">
        <h3 className="text-sm font-bold">{title}</h3>
        {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
      <div className="divide-y divide-border/30">
        {sections.map((section, si) => (
          <div key={si} className="px-4 py-3">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">{section.heading}</h4>
            {section.metric && (
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-2xl font-bold">{section.metric.value}</span>
                <span className="text-xs text-muted-foreground">{section.metric.label}</span>
                {section.metric.change && (
                  <span className={`text-xs font-medium ${section.metric.changeType === "positive" ? "text-green-500" : section.metric.changeType === "negative" ? "text-red-500" : "text-muted-foreground"}`}>
                    {section.metric.change}
                  </span>
                )}
              </div>
            )}
            {section.content && <p className="text-sm text-foreground/80 whitespace-pre-wrap mb-2">{section.content}</p>}
            {section.chart && <ChatChart spec={section.chart as ChartSpec} />}
            {section.table && <ChatTable spec={section.table as TableSpec} />}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main chat page ────────────────────────────────────────────────────────────
// Module-level chat history cache — persists across navigation without localStorage
function SlowResponseHint() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 10000);
    return () => clearTimeout(t);
  }, []);
  if (!show) return null;
  return <span className="text-xs text-muted-foreground animate-in fade-in">Still working… complex requests take longer</span>;
}

const WELCOME_MSG: ChatMessage = {
  id: "welcome",
  role: "assistant",
  content: "Welcome to Portol. I'm your AI assistant \u2014 tell me what to log, track, create, or find. I can handle multiple things at once.\n\nTry something like: \"I ate a chicken sandwich, ran 2 miles, and spent $12 on lunch\"\n\nYou can also upload photos or documents \u2014 I'll extract data and route it to the right profile.",
  timestamp: new Date().toISOString(),
};
// Persist chat history to sessionStorage so it survives page reloads
function loadChatHistory(): ChatMessage[] {
  try {
    const stored = sessionStorage.getItem("portol_chat_history");
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch { /* ignore parse errors */ }
  return [WELCOME_MSG];
}
function saveChatHistory(messages: ChatMessage[]) {
  try {
    // Keep last 100 messages to avoid storage bloat
    const toSave = messages.slice(-100);
    sessionStorage.setItem("portol_chat_history", JSON.stringify(toSave));
  } catch { /* storage full — ignore */ }
}
let _chatCache: ChatMessage[] = loadChatHistory();

/** Clear module-level chat cache — must be called on sign-out to prevent data leakage between users */
export function clearChatCache() {
  _chatCache = [WELCOME_MSG];
  try { sessionStorage.removeItem("portol_chat_history"); } catch {}
}

// ─────────────────────────────────────────────
// Confirmation card with inline Edit + Undo
// ─────────────────────────────────────────────
function ConfirmationCard({ name, type, amount, date, profile, warnings, entityId, endpoint, isDeleted, result, onDeleted }: {
  name: string; type: string; amount: string | null; date: string; profile: string;
  warnings: string[]; entityId?: string; endpoint: string | null; isDeleted?: boolean;
  result: any; onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(name);
  const [editAmount, setEditAmount] = useState(result?.amount?.toString() || "");
  const [editDate, setEditDate] = useState(date?.slice(0, 10) || "");
  const [saving, setSaving] = useState(false);
  const [deleted, setDeleted] = useState(!!isDeleted);
  const { toast } = useToast();

  if (deleted) {
    return (
      <div className="flex items-center gap-2 text-xs bg-destructive/5 rounded-lg px-3 py-2 border border-destructive/20 opacity-60">
        <X className="h-3 w-3 text-destructive" />
        <span className="line-through text-muted-foreground">{name} {amount && `(${amount})`} — undone</span>
      </div>
    );
  }

  const handleSave = async () => {
    if (!entityId || !endpoint) return;
    setSaving(true);
    try {
      const patch: any = {};
      if (endpoint === "expenses") {
        patch.description = editName;
        patch.amount = parseFloat(editAmount);
        if (editDate) patch.date = editDate;
      } else if (endpoint === "tasks") {
        patch.title = editName;
      } else if (endpoint === "obligations") {
        patch.name = editName;
        patch.amount = parseFloat(editAmount);
      } else if (endpoint === "events") {
        patch.title = editName;
        if (editDate) patch.date = editDate;
      }
      await apiRequest("PATCH", `/api/${endpoint}/${entityId}`, patch);
      // Update display values
      result.title = editName; result.name = editName; result.description = editName;
      result.amount = parseFloat(editAmount) || result.amount;
      result.date = editDate || result.date;
      toast({ title: "Updated" });
      setEditing(false);
    } catch { toast({ title: "Failed to update", variant: "destructive" }); }
    setSaving(false);
  };

  const handleUndo = async () => {
    if (!entityId || !endpoint) return;
    setDeleted(true); // Optimistic — show immediately
    try {
      await apiRequest("DELETE", `/api/${endpoint}/${entityId}`);
      onDeleted();
      toast({ title: "Removed" });
      // Invalidate outside try so we don't catch its errors
    } catch (err: any) {
      setDeleted(false); // Roll back on real failure
      const msg = err?.message || "";
      toast({
        title: "Could not undo",
        description: msg.includes("401") ? "Session expired — try signing out and back in" : msg.includes("404") ? "Already removed" : "Please try again",
        variant: "destructive"
      });
      return;
    }
    queryClient.invalidateQueries();
  };

  return (
    <div className="text-xs bg-muted/30 rounded-lg border border-border/30 overflow-hidden" data-testid="confirmation-card">
      {editing ? (
        <div className="px-3 py-2 space-y-2">
          <input
            autoFocus
            value={editName}
            onChange={e => setEditName(e.target.value)}
            className="w-full bg-background border border-border rounded px-2 py-1 text-xs font-medium text-foreground"
            placeholder="Name / description"
          />
          <div className="flex gap-1.5">
            {(endpoint === "expenses" || endpoint === "obligations") && (
              <input
                value={editAmount}
                onChange={e => setEditAmount(e.target.value)}
                type="number"
                step="0.01"
                className="w-24 bg-background border border-border rounded px-2 py-1 text-xs tabular-nums"
                placeholder="Amount"
              />
            )}
            {(endpoint === "expenses" || endpoint === "events") && (
              <input
                value={editDate}
                onChange={e => setEditDate(e.target.value)}
                type="date"
                className="flex-1 bg-background border border-border rounded px-2 py-1 text-xs"
              />
            )}
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 py-1 rounded text-xs bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 font-medium"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="px-3 py-1 rounded text-xs border border-border hover:bg-muted/60 text-muted-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2 px-3 py-2">
          <div className="flex-1 min-w-0 space-y-0.5">
            <div className="font-medium text-foreground truncate">{editName}</div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
              {type && <span className="capitalize">{type}</span>}
              {editAmount && parseFloat(editAmount) > 0 && <span className="tabular-nums text-green-500">${parseFloat(editAmount).toFixed(2)}</span>}
              {editDate && <span>{editDate.slice(0, 10)}</span>}
              {typeof profile === "string" && profile && <span className="text-primary/80">→ {profile.slice(0, 20)}</span>}
            </div>
            {warnings.length > 0 && <div className="text-amber-500">⚠ {warnings.join(", ")}</div>}
          </div>
          <div className="flex items-center gap-1 shrink-0 ml-1">
            {entityId && endpoint && (
              <button
                onClick={() => setEditing(true)}
                className="p-1 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors"
                title="Edit"
              >
                <Pencil className="h-3 w-3" />
              </button>
            )}
            {entityId && endpoint && (
              <button
                onClick={handleUndo}
                className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                title="Undo / Remove"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ChatPage() {
  useEffect(() => { document.title = "Chat — Portol"; }, []);
  useEffect(() => {
    return () => { if (batchIntervalRef.current) clearInterval(batchIntervalRef.current); };
  }, []);
  const { toast } = useToast();
  const [messages, setMessagesRaw] = useState<ChatMessage[]>(_chatCache);
  // Wrap setMessages to also persist to module-level cache
  const setMessages = (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
    setMessagesRaw(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      _chatCache = next; // Persist across navigation
      saveChatHistory(next); // Persist across page reloads
      return next;
    });
  };
  const [input, setInput] = useState("");

  // Attachments: array supports both single and batch
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>("none");

  // Track batch processing progress
  const [batchProcessedCount, setBatchProcessedCount] = useState(0);

  // Ref to hold attachments at batch-send time so onSettled can revoke URLs and clear state
  const pendingBatchAttachmentsRef = useRef<typeof attachments>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addMoreFileInputRef = useRef<HTMLInputElement>(null);
  const batchIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const queryClient = useQueryClient();

  // Fetch profiles for the selector
  const { data: profiles = [], isLoading: profilesLoading } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
  });

  const chatMutation = useMutation({
    mutationFn: async (message: string) => {
      // Build conversation history from last 10 messages (up to 5 pairs) for multi-step context
      const history = messages
        .filter(m => m.id !== "welcome")
        .slice(-10)
        .map(m => ({ role: m.role as "user" | "assistant", content: m.content }));
      const res = await apiRequest("POST", "/api/chat", { message, history });
      return res.json();
    },
    onSuccess: (data) => {
      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: data.reply,
        timestamp: new Date().toISOString(),
        actions: data.actions,
        results: data.results,
        documentPreview: data.documentPreview,
        documentPreviews: data.documentPreviews,
        charts: data.charts,
        tables: data.tables,
        report: data.report,
      };
      setMessages((prev) => [...prev, assistantMsg]);
      invalidateAll();
    },
    onError: (err: Error) => {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `Something went wrong: ${err.message || "Network error"}. Please try again.`,
          timestamp: new Date().toISOString(),
        },
      ]);
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async (payload: {
      fileName: string;
      mimeType: string;
      fileData: string;
      profileId?: string;
      message?: string;
    }) => {
      const res = await apiRequest("POST", "/api/upload", payload);
      return res.json();
    },
    onSuccess: (data) => {
      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: data.reply,
        timestamp: new Date().toISOString(),
        actions: data.actions,
        results: data.results,
        documentPreview: data.documentPreview,
        documentPreviews: data.documentPreviews,
        pendingExtraction: data.pendingExtraction,
      };
      setMessages((prev) => [...prev, assistantMsg]);
      invalidateAll();
    },
    onError: (err: Error) => {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `Failed to process the uploaded file: ${err.message || "Network error"}. Please try again.`,
          timestamp: new Date().toISOString(),
        },
      ]);
    },
  });

  // Batch upload mutation
  const batchUploadMutation = useMutation({
    mutationFn: async (payload: {
      files: Array<{ fileName: string; mimeType: string; fileData: string; profileId?: string }>;
      message?: string;
    }) => {
      const res = await apiRequest("POST", "/api/upload/batch", payload);
      return res.json();
    },
    onSuccess: (data: {
      results: Array<{
        fileName: string;
        reply: string;
        actions: ParsedAction[];
        results: any[];
        documentId?: string;
        documentPreview?: { id: string; name: string; mimeType: string; data: string };
        suggestedProfile?: { id: string; name: string } | null;
        documentType?: string;
        pendingExtraction?: any;
      }>;
      summary: string;
    }) => {
      // Create ONE combined assistant message
      let content = data.summary + "\n\n";
      for (const r of data.results) {
        content += `📄 ${r.fileName}: ${r.reply}\n\n`;
      }
      // Collect all document previews
      const allPreviews = data.results
        .filter((r) => r.documentPreview)
        .map((r) => r.documentPreview!);

      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content,
        timestamp: new Date().toISOString(),
        actions: data.results.flatMap((r) => r.actions || []),
        results: data.results.flatMap((r) => r.results || []),
        documentPreviews: allPreviews,
      };
      setMessages((prev) => [...prev, assistantMsg]);

      // Create separate extraction messages for each file with pending extraction
      const extractionMsgs: ChatMessage[] = data.results
        .filter((r) => r.pendingExtraction?.extractedFields?.length > 0)
        .map((r, idx) => ({
          id: `${Date.now()}-extraction-${idx}`,
          role: "assistant" as const,
          content: `Review extracted data for "${r.fileName}":`,
          timestamp: new Date().toISOString(),
          pendingExtraction: r.pendingExtraction,
        }));
      if (extractionMsgs.length > 0) {
        setMessages((prev) => [...prev, ...extractionMsgs]);
      }

      setBatchProcessedCount(0);
      invalidateAll();
    },
    onError: (err: Error) => {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `Failed to process the batch upload: ${err.message || "Network error"}. Please try again.`,
          timestamp: new Date().toISOString(),
        },
      ]);
      setBatchProcessedCount(0);
    },
    onSettled: () => {
      // Revoke object URLs and clear attachments after mutation completes (success or error)
      pendingBatchAttachmentsRef.current.forEach(a => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });
      pendingBatchAttachmentsRef.current = [];
      setAttachments([]);
    },
  });

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
    queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
    queryClient.invalidateQueries({ queryKey: ["/api/trackers"] });
    queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
    queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
    queryClient.invalidateQueries({ queryKey: ["/api/expenses"] });
    queryClient.invalidateQueries({ queryKey: ["/api/events"] });
    queryClient.invalidateQueries({ queryKey: ["/api/habits"] });
    queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
    queryClient.invalidateQueries({ queryKey: ["/api/journal"] });
    queryClient.invalidateQueries({ queryKey: ["/api/documents"] });
    queryClient.invalidateQueries({ queryKey: ["/api/insights"] });
    queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
    queryClient.invalidateQueries({ queryKey: ["/api/goals"] });
    queryClient.invalidateQueries({ queryKey: ["/api/activity"] });
    queryClient.invalidateQueries({ queryKey: ["/api/ai-digest"] });
    queryClient.invalidateQueries({ queryKey: ["/api/artifacts"] });
  }

  const handleConfirmExtraction = async (data: {
    extractionId: string;
    confirmedFields: Array<{ key: string; value: any }>;
    targetProfileId?: string;
    createCalendarEvents: Array<{ field: string; date: string; title: string; category: string }>;
    trackerEntries: any[];
  }): Promise<boolean> => {
    try {
      const res = await apiRequest("POST", "/api/chat/confirm-extraction", data);
      const result = await res.json();
      if (result.success) {
        invalidateAll();
        // Remove pendingExtraction from the message
        setMessages((prev) =>
          prev.map((m) =>
            m.pendingExtraction?.extractionId === data.extractionId
              ? { ...m, pendingExtraction: undefined }
              : m
          )
        );
        return true;
      }
      return false;
    } catch (err) {
      console.error("Confirm extraction failed:", err);
      return false;
    }
  };

  const handleSkipExtraction = (extractionId: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.pendingExtraction?.extractionId === extractionId
          ? { ...m, pendingExtraction: undefined }
          : m
      )
    );
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, chatMutation.isPending, uploadMutation.isPending, batchUploadMutation.isPending]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    for (const file of files) {
      if (file.size > 10 * 1024 * 1024) {
        toast({ title: `File "${file.name}" is too large (max 10MB)`, variant: "destructive" });
        continue;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        const newAttachment: StagedAttachment = {
          name: file.name,
          mimeType: file.type,
          data: base64,
          previewUrl: URL.createObjectURL(file),
          profileId: "none",
        };
        setAttachments((prev) => [...prev, newAttachment]);
      };
      reader.onerror = () => {
        toast({ title: `Failed to read "${file.name}"`, variant: "destructive" });
      };
      reader.readAsDataURL(file);
    }

    // Reset so same file can be selected again
    e.target.value = "";
  };

  // Single file: send using existing upload endpoint
  const handleAttachmentSend = () => {
    if (attachments.length !== 1 || uploadMutation.isPending) return;
    const att = attachments[0];

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: input.trim() || `Uploaded: ${att.name}`,
      timestamp: new Date().toISOString(),
      attachment: {
        name: att.name,
        mimeType: att.mimeType,
        data: att.data,
        previewUrl: att.previewUrl,
      },
    };
    setMessages((prev) => [...prev, userMsg]);

    const profileToSend = att.profileId !== "none" ? att.profileId : (selectedProfileId !== "none" ? selectedProfileId : undefined);

    uploadMutation.mutate({
      fileName: att.name,
      mimeType: att.mimeType,
      fileData: att.data,
      profileId: profileToSend,
      message: input.trim() || undefined,
    });

    setAttachments([]);
    setSelectedProfileId("none");
    setInput("");
  };

  // Batch upload: send using batch endpoint
  const handleBatchSend = () => {
    if (attachments.length < 2 || batchUploadMutation.isPending) return;

    const fileNames = attachments.map((a) => a.name).join(", ");
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: input.trim() || `Uploaded ${attachments.length} files: ${fileNames}`,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);

    setBatchProcessedCount(0);

    batchUploadMutation.mutate({
      files: attachments.map((att) => ({
        fileName: att.name,
        mimeType: att.mimeType,
        fileData: att.data,
        profileId: att.profileId !== "none" ? att.profileId : undefined,
      })),
      message: input.trim() || undefined,
    });

    // Capture attachments in a ref so onSettled can revoke URLs and clear state
    // (attachments must remain visible during upload to show progress)
    pendingBatchAttachmentsRef.current = attachments;
    const currentAttachmentCount = attachments.length;
    // Simulate progress updates
    let count = 0;
    if (batchIntervalRef.current) clearInterval(batchIntervalRef.current);
    batchIntervalRef.current = setInterval(() => {
      count++;
      if (count >= currentAttachmentCount) {
        if (batchIntervalRef.current) clearInterval(batchIntervalRef.current);
        batchIntervalRef.current = null;
      }
      setBatchProcessedCount((prev) => Math.min(prev + 1, currentAttachmentCount));
    }, 2000);

    // Clear input immediately; attachments will be cleared in onSettled after mutation completes
    setSelectedProfileId("none");
    setInput("");
  };

  const handleSend = () => {
    const msg = input.trim();
    const isPending = chatMutation.isPending || uploadMutation.isPending || batchUploadMutation.isPending;
    if (isPending) return;
    if (!msg) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: msg,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    chatMutation.mutate(msg);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSuggestion = (s: string) => {
    setInput(s);
    inputRef.current?.focus();
  };

  // Batch panel handlers
  const handleBatchProfileChange = (index: number, profileId: string) => {
    setAttachments((prev) =>
      prev.map((att, i) => (i === index ? { ...att, profileId } : att))
    );
  };

  const handleGlobalProfileChange = (profileId: string) => {
    setAttachments((prev) => prev.map((att) => ({ ...att, profileId })));
  };

  const handleRemoveAttachment = (index: number) => {
    setAttachments((prev) => {
      const newArr = [...prev];
      // Revoke the object URL to avoid memory leaks
      if (newArr[index]?.previewUrl) {
        URL.revokeObjectURL(newArr[index].previewUrl);
      }
      newArr.splice(index, 1);
      return newArr;
    });
  };

  const isPending = chatMutation.isPending || uploadMutation.isPending || batchUploadMutation.isPending;
  const hasAttachments = attachments.length > 0;
  const isBatch = attachments.length > 1;

  return (
    <div className="flex flex-col h-full overflow-x-hidden" data-testid="page-chat">
      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,application/pdf"
        multiple
        className="hidden"
        onChange={handleFileSelect}
        data-testid="input-file"
      />
      <input
        ref={addMoreFileInputRef}
        type="file"
        accept="image/*,application/pdf"
        multiple
        className="hidden"
        onChange={handleFileSelect}
        data-testid="input-file-add-more"
      />
      {/* Camera capture input (mobile) */}
      <input
        id="camera-capture"
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFileSelect}
        data-testid="input-camera"
      />

      {/* Messages area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
        <div className="max-w-2xl mx-auto space-y-4">
          {/* Reset chat button at top of messages */}
          {messages.length > 1 && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1.5 border-dashed"
                onClick={() => { setMessages([WELCOME_MSG]); }}
                title="Start new conversation"
                data-testid="button-reset-chat"
              >
                <RotateCcw className="h-3 w-3" /> New Chat
              </Button>
            </div>
          )}
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`message-in flex ${
                msg.role === "user" ? "justify-end" : "justify-start"
              }`}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-card border border-border"
                }`}
                data-testid={`message-${msg.role}-${msg.id}`}
              >
                {msg.role === "assistant" && (
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <Bot className="h-3.5 w-3.5 text-primary" />
                    <span className="text-xs font-medium text-primary">
                      Portol
                    </span>
                  </div>
                )}

                {/* Attachment preview in user message */}
                {msg.attachment &&
                  msg.attachment.mimeType.startsWith("image/") && (
                    <div className="mb-2 rounded-lg overflow-hidden">
                      <img
                        src={
                          msg.attachment.previewUrl ||
                          `data:${msg.attachment.mimeType};base64,${msg.attachment.data}`
                        }
                        alt={msg.attachment.name}
                        className="max-h-48 w-auto rounded-lg"
                      />
                    </div>
                  )}
                {msg.attachment &&
                  !msg.attachment.mimeType.startsWith("image/") && (
                    <div className="mb-2 flex items-center gap-2 p-2 rounded-lg bg-muted/30">
                      <FileText className="h-5 w-5 text-muted-foreground" />
                      <span className="text-xs truncate">
                        {msg.attachment.name}
                      </span>
                    </div>
                  )}

                <div className="text-sm whitespace-pre-wrap leading-relaxed [&_ul]:ml-4 [&_ol]:ml-4 [&_li]:ml-2 text-foreground">
                  {msg.content}
                </div>

                {/* Rich content: charts, tables, reports */}
                {msg.charts && msg.charts.length > 0 && msg.charts.map((chart, ci) => (
                  <ChatChart key={`chart-${ci}`} spec={chart} />
                ))}
                {msg.tables && msg.tables.length > 0 && msg.tables.map((table, ti) => (
                  <ChatTable key={`table-${ti}`} spec={table} />
                ))}
                {msg.report && <ChatReport spec={msg.report} />}

                {/* Document previews - inline with zoom & share */}
                <ChatDocumentPreviews
                  documentPreview={msg.documentPreview}
                  documentPreviews={msg.documentPreviews}
                />

                {/* Extraction confirmation UI */}
                {msg.pendingExtraction && msg.pendingExtraction.extractedFields.length > 0 && (
                  <ExtractionConfirmation
                    extraction={msg.pendingExtraction}
                    onConfirm={handleConfirmExtraction}
                    onSkip={() => { if (msg.pendingExtraction?.extractionId) handleSkipExtraction(msg.pendingExtraction.extractionId); }}
                  />
                )}

                {/* Action badges */}
                {msg.actions && msg.actions.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {msg.actions.map((action, i) => {
                      const entityId = action.data?._entityId;
                      const isUndone = action.data?._undone;
                      const canUndo = entityId && !isUndone && ["create_task","log_expense","create_event","create_habit","create_obligation","create_goal","create_profile","journal_entry","create_artifact","create_tracker"].includes(action.type);
                      const undoEndpoint: Record<string, string> = {
                        create_task: "tasks", log_expense: "expenses", create_event: "events",
                        create_habit: "habits", create_obligation: "obligations", create_goal: "goals",
                        create_profile: "profiles", journal_entry: "journal", create_artifact: "artifacts",
                        create_tracker: "trackers",
                      };
                      return (
                        <Badge
                          key={i}
                          variant="outline"
                          className={`text-xs flex items-center gap-1 ${isUndone ? "line-through opacity-50 border-red-600/30 bg-red-500/5" : "text-muted-foreground border-green-600/30 bg-green-500/5"}`}
                          data-testid={`badge-action-${action.type}-${i}`}
                        >
                          {isUndone ? <X className="h-2.5 w-2.5 text-red-500" /> : <Check className="h-2.5 w-2.5 text-green-600" />}
                          {actionLabel(action.type)}
                          {canUndo && (
                            <button
                              className="ml-1 p-0.5 rounded hover:bg-destructive/20 transition-colors"
                              title="Undo this action"
                              onClick={async (e) => {
                                e.stopPropagation();
                                const ep = undoEndpoint[action.type];
                                if (!ep) return;
                                try {
                                  await apiRequest("DELETE", `/api/${ep}/${entityId}`);
                                  // Mark as undone in local state
                                  action.data = { ...action.data, _undone: true };
                                  setMessages(prev => prev.map(m => ({ ...m })));
                                  queryClient.invalidateQueries();
                                  toast({ title: "Action undone" });
                                } catch {
                                  toast({ title: "Failed to undo", variant: "destructive" });
                                }
                              }}
                            >
                              <X className="h-2.5 w-2.5 text-muted-foreground hover:text-destructive" />
                            </button>
                          )}
                        </Badge>
                      );
                    })}
                  </div>
                )}

                {/* Structured confirmation cards */}
                {msg.results && msg.results.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {msg.results.slice(0, 10).map((result: any, ri: number) => {
                      if (!result || result.error) return null;
                      const name = result.title || result.name || result.description || "";
                      const type = result.type || result.category || "";
                      const amount = result.amount != null ? `$${Number(result.amount).toFixed(2)}` : null;
                      const date = result.date || result.dueDate || result.nextDueDate || "";
                      const profile = result.forProfile || result.linkedProfiles?.[0] || "";
                      const warnings = result._validationWarnings || [];
                      const entityId = result.id;
                      const isDeleted = result._deleted;
                      
                      if (!name && !amount) return null;
                      
                      // Determine entity endpoint for edit/undo
                      const ep = result.status !== undefined ? "tasks"
                        : result.amount !== undefined ? "expenses"
                        : result.frequency !== undefined ? "obligations"
                        : result.date !== undefined ? "events"
                        : null;
                      
                      return (
                        <ConfirmationCard
                          key={`${ri}-${entityId}`}
                          name={name}
                          type={type}
                          amount={amount}
                          date={date}
                          profile={profile}
                          warnings={warnings}
                          entityId={entityId}
                          endpoint={ep}
                          isDeleted={isDeleted}
                          result={result}
                          onDeleted={() => { result._deleted = true; setMessages(prev => prev.map(m => ({ ...m }))); }}
                        />
                      );
                    })}
                  </div>
                )}

                {/* Timestamp */}
                <div className="mt-1.5 flex justify-end">
                  <span className="text-xs text-muted-foreground/60">
                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              </div>
            </div>
          ))}

          {/* Typing indicator */}
          {isPending && (
            <div className="flex items-start gap-2">
              <div className="bg-muted rounded-lg px-3 py-2">
                <div className="flex items-center gap-2">
                  <div className="flex gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{animationDelay: '0ms'}} />
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{animationDelay: '150ms'}} />
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{animationDelay: '300ms'}} />
                  </div>
                  <SlowResponseHint />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Suggestions (show only when few messages) */}
      {messages.length <= 2 && !hasAttachments && (
        <div className="px-4 pb-2">
          <div className="max-w-2xl mx-auto">
            <p className="text-sm font-medium text-muted-foreground mb-2">Try saying:</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => handleSuggestion(s)}
                  className="text-xs px-3 py-1.5 rounded-full border border-border/60 hover:bg-muted/60 transition-colors text-left"
                  data-testid={`button-suggestion-${s.slice(0, 20)}`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Single attachment staging panel */}
      {attachments.length === 1 && (
        <AttachmentPanel
          attachment={attachments[0]}
          profiles={profiles}
          profilesLoading={profilesLoading}
          selectedProfileId={attachments[0].profileId}
          onProfileChange={(id) => {
            setAttachments((prev) =>
              prev.map((att, i) => (i === 0 ? { ...att, profileId: id } : att))
            );
            setSelectedProfileId(id);
          }}
          onRemove={() => {
            if (attachments[0]?.previewUrl) {
              URL.revokeObjectURL(attachments[0].previewUrl);
            }
            setAttachments([]);
            setSelectedProfileId("none");
            setInput("");
          }}
          note={input}
          onNoteChange={setInput}
          onSend={handleAttachmentSend}
          isSending={uploadMutation.isPending}
        />
      )}

      {/* Batch attachment staging panel */}
      {isBatch && (
        <BatchAttachmentPanel
          attachments={attachments}
          profiles={profiles}
          profilesLoading={profilesLoading}
          onProfileChange={handleBatchProfileChange}
          onGlobalProfileChange={handleGlobalProfileChange}
          onRemove={handleRemoveAttachment}
          onAddMore={() => addMoreFileInputRef.current?.click()}
          note={input}
          onNoteChange={setInput}
          onSend={handleBatchSend}
          isSending={batchUploadMutation.isPending}
          processedCount={batchProcessedCount}
        />
      )}

      {/* Text input area (only shown when no attachment pending) */}
      {!hasAttachments && (
        <div className="border-t border-border px-4 py-2 pb-[env(safe-area-inset-bottom,12px)] bg-background/80 backdrop-blur-sm">
          {/* Mobile-visible New Chat button above input when there are messages */}
          {messages.length > 1 && (
            <div className="max-w-2xl mx-auto flex justify-center mb-1.5 md:hidden">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs-loose gap-1 border-dashed w-full"
                onClick={() => { setMessages([WELCOME_MSG]); }}
                data-testid="button-reset-chat-mobile"
              >
                <RotateCcw className="h-3 w-3" /> New Chat
              </Button>
            </div>
          )}
          <div className="max-w-2xl mx-auto flex items-end gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-[44px] w-[44px] shrink-0 rounded-xl"
              onClick={() => fileInputRef.current?.click()}
              disabled={isPending}
              title="Upload image, PDF, or document"
              data-testid="button-attach"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-[44px] w-[44px] shrink-0 rounded-xl md:hidden"
              onClick={() => document.getElementById('camera-capture')?.click()}
              disabled={isPending}
              data-testid="button-camera"
            >
              <Camera className="h-4 w-4" />
            </Button>
            <Textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything or log data..."
              className="min-h-[48px] max-h-[120px] resize-none rounded-xl bg-card text-sm"
              rows={1}
              data-testid="input-chat"
            />
            <Button
              onClick={handleSend}
              disabled={!input.trim() || isPending}
              size="icon"
              className="rounded-xl h-[44px] w-[44px] shrink-0 hover:scale-105 active:scale-95 transition-transform"
              data-testid="button-send"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
