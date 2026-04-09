import { formatApiError } from "@/lib/formatError";
import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Calendar as CalendarIcon, CalendarDays, ChevronLeft, ChevronRight, Plus,
  Clock, MapPin, Repeat, Trash2, Pencil, X,
  ListTodo, Flame, CreditCard, Users, FileText,
  CheckSquare, ChevronDown, RefreshCw,
} from "lucide-react";
import type {
  CalendarTimelineItem, CalendarEvent, EventCategory, Profile,
} from "@shared/schema";
import { EVENT_CATEGORY_COLORS } from "@shared/schema";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toLocalDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getMonthDays(year: number, month: number) {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startPad = firstDay.getDay(); // 0=Sun
  const totalDays = lastDay.getDate();
  
  const days: { date: string; dayNum: number; isCurrentMonth: boolean }[] = [];
  
  // Pad from previous month
  const prevMonth = new Date(year, month, 0);
  for (let i = startPad - 1; i >= 0; i--) {
    const d = prevMonth.getDate() - i;
    const dt = new Date(year, month - 1, d);
    days.push({
      date: toLocalDateStr(dt),
      dayNum: d,
      isCurrentMonth: false,
    });
  }

  // Current month days
  for (let d = 1; d <= totalDays; d++) {
    const dt = new Date(year, month, d);
    days.push({
      date: toLocalDateStr(dt),
      dayNum: d,
      isCurrentMonth: true,
    });
  }

  // Pad from next month
  const remaining = 42 - days.length; // 6 weeks
  for (let d = 1; d <= remaining; d++) {
    const dt = new Date(year, month + 1, d);
    days.push({
      date: toLocalDateStr(dt),
      dayNum: d,
      isCurrentMonth: false,
    });
  }
  
  return days;
}

function fmtMonthYear(year: number, month: number) {
  return new Date(year, month).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

/** Convert "18:00" → "6 PM", "08:30" → "8:30 AM" */
function fmt12(time: string | undefined): string {
  if (!time) return '';
  const [hStr, mStr] = time.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr || '0', 10);
  if (isNaN(h)) return time;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2,'0')} ${ampm}`;
}

function fmtDateFull(dateStr: string) {
  return new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

const TYPE_ICONS: Record<string, any> = {
  event: CalendarIcon,
  task: ListTodo,
  habit: Flame,
  obligation: CreditCard,
};

const TYPE_LABELS: Record<string, string> = {
  event: "Event",
  task: "Task",
  habit: "Habit",
  obligation: "Bill Due",
};

const CATEGORY_LABELS: Record<EventCategory, string> = {
  personal: "Personal",
  work: "Work",
  health: "Health",
  finance: "Finance",
  family: "Family",
  social: "Social",
  travel: "Travel",
  education: "Education",
  other: "Other",
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TYPE_COLORS: Record<string, string> = {
  event: "#4F98A3", task: "#E5A545", obligation: "#C75B5B",
  habit: "#8B5CF6", goal: "#10B981", tracker: "#6366F1",
};

// ─── Event Create/Edit Dialog ──────────────────────────────────────────────────

interface EventFormData {
  title: string;
  date: string;
  time: string;
  endTime: string;
  allDay: boolean;
  description: string;
  location: string;
  category: EventCategory;
  recurrence: string;
  linkedProfiles: string[];
}

function EventFormDialog({
  open,
  onClose,
  initial,
  eventId,
  defaultDate,
}: {
  open: boolean;
  onClose: () => void;
  initial?: Partial<EventFormData>;
  eventId?: string;
  defaultDate?: string;
}) {
  const { toast } = useToast();
  const isEdit = !!eventId;
  const todayStr = toLocalDateStr(new Date());

  const [form, setForm] = useState<EventFormData>({
    title: initial?.title ?? "",
    date: initial?.date ?? defaultDate ?? todayStr,
    time: initial?.time ?? "",
    endTime: initial?.endTime ?? "",
    allDay: initial?.allDay ?? false,
    description: initial?.description ?? "",
    location: initial?.location ?? "",
    category: initial?.category ?? "personal",
    recurrence: initial?.recurrence ?? "none",
    linkedProfiles: initial?.linkedProfiles ?? [],
  });

  const { data: profiles = [] } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: any = {
        title: form.title,
        date: form.date,
        allDay: form.allDay,
        category: form.category,
        recurrence: form.recurrence,
        linkedProfiles: form.linkedProfiles,
        source: "manual",
      };
      if (!form.allDay && form.time) payload.time = form.time;
      if (!form.allDay && form.endTime) payload.endTime = form.endTime;
      if (form.description) payload.description = form.description;
      if (form.location) payload.location = form.location;

      if (isEdit) {
        const res = await apiRequest("PATCH", `/api/events/${eventId}`, payload);
        return res.json();
      } else {
        const res = await apiRequest("POST", "/api/events", payload);
        return res.json();
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      toast({ title: isEdit ? `"${form.title}" updated` : `"${form.title}" created`, description: form.date ? new Date(form.date + "T12:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : undefined });
      onClose();
    },
    onError: (err: Error) => {
      toast({ title: isEdit ? "Failed to update event" : "Failed to create event", description: formatApiError(err), variant: "destructive" });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim() || !form.date) return;
    mutation.mutate();
  };

  const toggleProfile = (id: string) => {
    setForm(f => ({
      ...f,
      linkedProfiles: f.linkedProfiles.includes(id)
        ? f.linkedProfiles.filter(p => p !== id)
        : [...f.linkedProfiles, id],
    }));
  };

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto" data-testid={isEdit ? "dialog-edit-event" : "dialog-add-event"}>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Event" : "New Event"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Title */}
          <div className="space-y-1.5">
            <Label htmlFor="ev-title">Title</Label>
            <Input
              id="ev-title"
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder="Event title"
              required
              data-testid="input-event-title"
            />
          </div>

          {/* Category */}
          <div className="space-y-1.5">
            <Label>Category</Label>
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(CATEGORY_LABELS) as EventCategory[]).map(cat => (
                <button
                  key={cat}
                  type="button"
                  className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-all ${
                    form.category === cat
                      ? "border-transparent text-white"
                      : "border-border text-muted-foreground hover:border-foreground/30"
                  }`}
                  style={form.category === cat ? { backgroundColor: EVENT_CATEGORY_COLORS[cat] } : {}}
                  onClick={() => setForm(f => ({ ...f, category: cat }))}
                  data-testid={`btn-category-${cat}`}
                >
                  {CATEGORY_LABELS[cat]}
                </button>
              ))}
            </div>
          </div>

          {/* All Day Toggle */}
          <div className="flex items-center gap-2">
            <Switch
              id="ev-allday"
              checked={form.allDay}
              onCheckedChange={v => setForm(f => ({ ...f, allDay: v }))}
              data-testid="switch-allday"
            />
            <Label htmlFor="ev-allday">All day event</Label>
          </div>

          {/* Date + Time */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ev-date">Date</Label>
              <Input
                id="ev-date"
                type="date"
                value={form.date}
                onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                required
                data-testid="input-event-date"
              />
            </div>
            {!form.allDay && (
              <div className="space-y-1.5">
                <Label htmlFor="ev-time">Start Time</Label>
                <Input
                  id="ev-time"
                  type="time"
                  value={form.time}
                  onChange={e => setForm(f => ({ ...f, time: e.target.value }))}
                  data-testid="input-event-time"
                />
              </div>
            )}
          </div>

          {!form.allDay && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ev-endtime">End Time</Label>
                <Input
                  id="ev-endtime"
                  type="time"
                  value={form.endTime}
                  onChange={e => setForm(f => ({ ...f, endTime: e.target.value }))}
                  data-testid="input-event-endtime"
                />
              </div>
              <div />
            </div>
          )}

          {/* Location */}
          <div className="space-y-1.5">
            <Label htmlFor="ev-location">Location</Label>
            <Input
              id="ev-location"
              value={form.location}
              onChange={e => setForm(f => ({ ...f, location: e.target.value }))}
              placeholder="Optional location"
              data-testid="input-event-location"
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label htmlFor="ev-desc">Description</Label>
            <Textarea
              id="ev-desc"
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Optional details"
              rows={2}
              data-testid="input-event-description"
            />
          </div>

          {/* Recurrence */}
          <div className="space-y-1.5">
            <Label htmlFor="ev-recurrence">Repeat</Label>
            <Select
              value={form.recurrence}
              onValueChange={v => setForm(f => ({ ...f, recurrence: v }))}
            >
              <SelectTrigger id="ev-recurrence" data-testid="select-event-recurrence">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Does not repeat</SelectItem>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="biweekly">Bi-weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="yearly">Yearly</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Link Profiles */}
          {profiles.length > 0 && (
            <div className="space-y-1.5">
              <Label>Link to Profiles</Label>
              <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                {profiles.map(p => {
                  const linked = form.linkedProfiles.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`px-2 py-0.5 rounded-md text-xs border transition-all ${
                        linked
                          ? "bg-primary/10 border-primary text-primary"
                          : "border-border text-muted-foreground hover:border-foreground/30"
                      }`}
                      onClick={() => toggleProfile(p.id)}
                      data-testid={`btn-link-profile-${p.id}`}
                    >
                      {linked ? <CheckSquare className="h-3 w-3 inline mr-1" /> : null}
                      {p.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={mutation.isPending} data-testid="btn-save-event">
              {mutation.isPending ? "Saving\u2026" : isEdit ? "Save Changes" : "Create Event"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Event Detail Popup ────────────────────────────────────────────────────────

function EventDetailDialog({
  open,
  onClose,
  item,
  onEdit,
}: {
  open: boolean;
  onClose: () => void;
  item: CalendarTimelineItem;
  onEdit: () => void;
}) {
  const { toast } = useToast();
  const Icon = TYPE_ICONS[item.type] || CalendarIcon;

  const { data: profiles = [] } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
  });

  const linkedProfileNames = item.linkedProfiles
    .map(id => profiles.find(p => p.id === id)?.name)
    .filter(Boolean);

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (item.type === "event") {
        await apiRequest("DELETE", `/api/events/${item.sourceId}`);
      } else if (item.type === "task") {
        await apiRequest("DELETE", `/api/tasks/${item.sourceId}`);
      } else if (item.type === "obligation") {
        await apiRequest("DELETE", `/api/obligations/${item.sourceId}`);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      toast({ title: `"${item?.title || "Item"}" deleted` });
      onClose();
    },
    onError: (err: Error) => {
      toast({ title: `Failed to delete "${item?.title || "item"}"`, description: formatApiError(err), variant: "destructive" });
    },
  });

  const toggleTaskMutation = useMutation({
    mutationFn: async () => {
      const newStatus = item.completed ? "todo" : "done";
      const res = await apiRequest("PATCH", `/api/tasks/${item.sourceId}`, { status: newStatus });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
      toast({ title: item.completed ? `"${item.title}" reopened` : `"${item.title}" completed` });
    },
    onError: (err: Error) => {
      toast({ title: `Failed to update "${item.title}"`, description: formatApiError(err), variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm" data-testid="dialog-event-detail">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div
              className="p-1.5 rounded-md shrink-0"
              style={{ backgroundColor: `${item.color}20` }}
            >
              <Icon className="h-4 w-4" style={{ color: item.color }} />
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-base">{item.title}</DialogTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                {fmtDateFull(item.date)}
              </p>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-3 pt-2">
          {/* Type badge */}
          <div className="flex items-center gap-2 flex-wrap">
            <Badge
              variant="outline"
              className="text-xs h-5"
              style={{ borderColor: item.color, color: item.color }}
            >
              {TYPE_LABELS[item.type]}
            </Badge>
            {item.category && item.type === "event" && (
              <Badge
                className="text-xs h-5 text-white"
                style={{ backgroundColor: item.color }}
              >
                {CATEGORY_LABELS[item.category as EventCategory] || item.category}
              </Badge>
            )}
            {item.meta?.recurrence && item.meta.recurrence !== "none" && (
              <Badge variant="outline" className="text-xs h-5">
                <Repeat className="h-2.5 w-2.5 mr-0.5" />{item.meta.recurrence}
              </Badge>
            )}
          </div>

          {/* Time */}
          {item.time && (
            <div className="flex items-center gap-2 text-sm">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              <span>{fmt12(item.time)}{item.endTime ? ` – ${fmt12(item.endTime)}` : ""}</span>
            </div>
          )}

          {/* Location */}
          {item.location && (
            <div className="flex items-center gap-2 text-sm">
              <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
              <span>{item.location}</span>
            </div>
          )}

          {/* Description */}
          {item.description && (
            <p className="text-sm text-foreground/80">{item.description}</p>
          )}

          {/* Task status */}
          {item.type === "task" && (
            <div className="flex items-center gap-2">
              <Checkbox
                checked={item.completed}
                onCheckedChange={() => toggleTaskMutation.mutate()}
                disabled={toggleTaskMutation.isPending}
              />
              <span className="text-sm">
                {item.completed ? "Completed" : "Mark as done"}
              </span>
              {item.meta?.priority && (
                <Badge
                  variant="outline"
                  className={`text-xs h-5 ml-auto ${
                    item.meta.priority === "high" ? "border-red-500 text-red-500" :
                    item.meta.priority === "medium" ? "border-amber-500 text-amber-500" :
                    "border-muted-foreground"
                  }`}
                >
                  {item.meta.priority}
                </Badge>
              )}
            </div>
          )}

          {/* Obligation info */}
          {item.type === "obligation" && (
            <div className="flex items-center gap-2 text-sm">
              <CreditCard className="h-3.5 w-3.5 text-muted-foreground" />
              <span>${item.meta?.amount} \u2014 {item.meta?.frequency}</span>
              {item.meta?.autopay && (
                <Badge variant="outline" className="text-xs h-5 text-green-600 border-green-600">autopay</Badge>
              )}
            </div>
          )}

          {/* Linked profiles */}
          {linkedProfileNames.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <Users className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              {linkedProfileNames.map((name, i) => (
                <Badge key={i} variant="secondary" className="text-xs h-5">
                  {name}
                </Badge>
              ))}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          {item.type === "event" && (
            <Button
              variant="outline"
              size="sm"
              onClick={onEdit}
              data-testid="btn-edit-event-detail"
            >
              <Pencil className="h-3.5 w-3.5 mr-1" />Edit
            </Button>
          )}
          {(item.type === "event" || item.type === "task" || item.type === "obligation") && (
            <Button
              variant="destructive"
              size="sm"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate()}
              data-testid="btn-delete-event-detail"
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              {deleteMutation.isPending ? "Deleting\u2026" : "Delete"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Day Agenda View ──────────────────────────────────────────────────────────

function DayAgenda({
  date,
  items,
  onItemClick,
}: {
  date: string;
  items: CalendarTimelineItem[];
  onItemClick: (item: CalendarTimelineItem) => void;
}) {
  const dayItems = items.filter(i => i.date === date);
  
  if (dayItems.length === 0) {
    return (
      <p className="text-xs text-muted-foreground text-center py-3">
        No items for this day
      </p>
    );
  }

  return (
    <div className="space-y-1">
      {dayItems.map(item => {
        const Icon = TYPE_ICONS[item.type] || CalendarIcon;
        return (
          <button
            key={item.id}
            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg hover:bg-muted/50 transition-colors text-left group"
            onClick={() => onItemClick(item)}
            data-testid={`agenda-item-${item.id}`}
          >
            <div
              className="w-1 h-8 rounded-full shrink-0"
              style={{ backgroundColor: item.color }}
            />
            <div
              className="p-1 rounded shrink-0"
              style={{ backgroundColor: `${item.color}15` }}
            >
              <Icon className="h-3 w-3" style={{ color: item.color }} />
            </div>
            <div className="flex-1 min-w-0">
              <p className={`text-xs font-medium truncate ${item.completed ? "line-through text-muted-foreground" : ""}`}>
                {item.title}
              </p>
              <div className="flex items-center gap-1.5 mt-0.5">
                {item.time && (
                  <span className="text-xs text-muted-foreground">
                    {fmt12(item.time)}{item.endTime ? ` – ${fmt12(item.endTime)}` : ""}
                  </span>
                )}
                {item.allDay && !item.time && (
                  <span className="text-xs text-muted-foreground">All day</span>
                )}
                {item.location && (
                  <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                    <MapPin className="h-2 w-2" />{item.location}
                  </span>
                )}
              </div>
            </div>
            <Badge
              variant="outline"
              className="text-2xs h-4 px-1 shrink-0 opacity-60 group-hover:opacity-100"
              style={{ borderColor: item.color, color: item.color }}
            >
              {TYPE_LABELS[item.type]}
            </Badge>
          </button>
        );
      })}
    </div>
  );
}

// ─── Main Calendar View ───────────────────────────────────────────────────────

interface CalendarViewProps {
  /** External filter IDs from parent (when provided, overrides internal filter) */
  externalFilterIds?: string[];
  /** External filter mode from parent */
  externalFilterMode?: "everyone" | "selected";
}

export default function CalendarView({ externalFilterIds, externalFilterMode }: CalendarViewProps = {}) {
  const today = new Date();
  const todayStr = toLocalDateStr(today);
  const [viewMode, setViewMode] = useState<"month" | "week" | "day" | "agenda">("month");
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewDate, setViewDate] = useState(today); // for week/day navigation
  const [selectedDate, setSelectedDate] = useState(todayStr);
  const [addOpen, setAddOpen] = useState(false);
  const [detailItem, setDetailItem] = useState<CalendarTimelineItem | null>(null);
  const [editEvent, setEditEvent] = useState<CalendarEvent | null>(null);
  const [filterType, setFilterType] = useState<string>("all");
  const [profileFilter, setProfileFilter] = useState<string>("all");
  const [syncing, setSyncing] = useState(false);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [quickAddDate, setQuickAddDate] = useState<string | null>(null);
  const { toast } = useToast();

  // Fetch profiles for the person/pet filter
  const { data: filterProfiles = [] } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
    queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
  });
  const primaryProfiles = filterProfiles.filter(p => ["self", "person", "pet"].includes(p.type));
  const selfProfile = filterProfiles.find(p => p.type === "self");
  const resolvedProfileId = profileFilter === "me" ? selfProfile?.id : profileFilter === "all" ? null : profileFilter;

  const handleGcalSync = async () => {
    setSyncing(true);
    try {
      const res = await apiRequest("POST", "/api/calendar/sync");
      const data = await res.json();
      toast({ title: "Calendar Synced", description: data.message });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
      setLastSynced(new Date());
    } catch {
      toast({ title: "Sync Failed", description: "Could not connect to Google Calendar.", variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  };

  // Calculate date range for the visible month (with padding)
  const startDate = useMemo(() => {
    const d = new Date(viewYear, viewMonth, 1);
    d.setDate(d.getDate() - 7);
    return toLocalDateStr(d);
  }, [viewYear, viewMonth]);

  const endDate = useMemo(() => {
    const d = new Date(viewYear, viewMonth + 1, 0);
    d.setDate(d.getDate() + 14);
    return toLocalDateStr(d);
  }, [viewYear, viewMonth]);

  // Determine effective filter: external props take precedence over internal filter
  const effectiveFilterMode = externalFilterMode ?? (resolvedProfileId ? "selected" : "everyone");
  const effectiveFilterIds = externalFilterIds ?? (resolvedProfileId ? [resolvedProfileId] : []);
  const effectiveHasSelf = effectiveFilterMode === "everyone" ||
    effectiveFilterIds.includes(selfProfile?.id || "") ||
    (externalFilterMode === undefined && profileFilter === "me");

  const timelineUrl = (() => {
    let url = `/api/calendar/timeline?start=${startDate}&end=${endDate}`;
    if (effectiveFilterMode === "selected" && effectiveFilterIds.length > 0) {
      url += `&profileIds=${effectiveFilterIds.join(",")}`;
    }
    return url;
  })();
  const { data: timelineItems = [], isLoading: timelineLoading } = useQuery<CalendarTimelineItem[]>({
    queryKey: ["/api/calendar/timeline", startDate, endDate, effectiveFilterMode, ...effectiveFilterIds],
    queryFn: () =>
      apiRequest("GET", timelineUrl).then(r => r.json()),
  });

  // Group items by date (with type + profile filtering)
  const itemsByDate = useMemo(() => {
    const map: Record<string, CalendarTimelineItem[]> = {};
    for (const item of timelineItems) {
      if (filterType !== "all" && item.type !== filterType) continue;
      // Profile filter
      if (effectiveFilterMode === "selected" && effectiveFilterIds.length > 0) {
        const linked = item.linkedProfiles || [];
        const matchesProfile = linked.some(id => effectiveFilterIds.includes(id));
        const isOrphan = effectiveHasSelf && linked.length === 0;
        if (!matchesProfile && !isOrphan) continue;
      }
      if (!map[item.date]) map[item.date] = [];
      map[item.date].push(item);
    }
    return map;
  }, [timelineItems, filterType, effectiveFilterMode, effectiveFilterIds, effectiveHasSelf]);

  const days = useMemo(
    () => getMonthDays(viewYear, viewMonth),
    [viewYear, viewMonth]
  );

  const goToday = () => {
    setViewMonth(today.getMonth());
    setViewYear(today.getFullYear());
    setSelectedDate(todayStr);
  };

  const prevMonth = () => {
    if (viewMode === "week") {
      const d = new Date(viewDate); d.setDate(d.getDate() - 7); setViewDate(d);
      setViewMonth(d.getMonth()); setViewYear(d.getFullYear());
    } else if (viewMode === "day") {
      const d = new Date(viewDate); d.setDate(d.getDate() - 1); setViewDate(d);
      setViewMonth(d.getMonth()); setViewYear(d.getFullYear());
    } else {
      if (viewMonth === 0) { setViewMonth(11); setViewYear(viewYear - 1); }
      else setViewMonth(viewMonth - 1);
    }
  };

  const nextMonth = () => {
    if (viewMode === "week") {
      const d = new Date(viewDate); d.setDate(d.getDate() + 7); setViewDate(d);
      setViewMonth(d.getMonth()); setViewYear(d.getFullYear());
    } else if (viewMode === "day") {
      const d = new Date(viewDate); d.setDate(d.getDate() + 1); setViewDate(d);
      setViewMonth(d.getMonth()); setViewYear(d.getFullYear());
    } else {
      if (viewMonth === 11) { setViewMonth(0); setViewYear(viewYear + 1); }
      else setViewMonth(viewMonth + 1);
    }
  };

  const handleEditFromDetail = () => {
    if (!detailItem || detailItem.type !== "event") return;
    // Fetch the actual event to populate form
    apiRequest("GET", `/api/events/${detailItem.sourceId}`)
      .then(r => r.json())
      .then((ev: CalendarEvent) => {
        setDetailItem(null);
        setEditEvent(ev);
      })
      .catch(() => {});
  };

  // Filtered items for the selected date
  const selectedDateItems = itemsByDate[selectedDate] || [];
  const filteredAgenda = selectedDateItems;

  return (
    <div className="space-y-2" data-testid="calendar-view">
      {/* Header */}
      <div className="flex items-center justify-between gap-1">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={prevMonth} className="h-7 w-7" data-testid="btn-prev-month">
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <h2 className="text-xs font-semibold min-w-[100px] text-center" data-testid="text-month-year">
            {viewMode === "day"
              ? viewDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
              : viewMode === "week"
                ? `Week of ${new Date(viewDate.getTime() - viewDate.getDay() * 86400000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
                : fmtMonthYear(viewYear, viewMonth)}
          </h2>
          <Button variant="ghost" size="icon" onClick={nextMonth} className="h-7 w-7" data-testid="btn-next-month">
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
          <Button variant="outline" size="sm" onClick={goToday} className="h-6 text-xs px-2" data-testid="btn-today">
            Today
          </Button>
          {/* View mode toggle */}
          <div className="flex items-center bg-muted/50 rounded-md p-0.5">
            {(["month", "week", "day", "agenda"] as const).map(mode => (
              <button key={mode} onClick={() => setViewMode(mode)}
                className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${viewMode === mode ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7 sm:w-auto sm:px-2 sm:gap-1.5"
            onClick={handleGcalSync}
            disabled={syncing}
            title="Sync Google Calendar"
            data-testid="btn-gcal-sync"
          >
            <RefreshCw className={`h-3 w-3 ${syncing ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline text-xs">{syncing ? "Syncing..." : "Sync"}</span>
          </Button>
          <Button
            size="icon"
            onClick={() => setAddOpen(true)}
            className="h-7 w-7 sm:w-auto sm:h-7 sm:px-2 sm:gap-1"
            data-testid="btn-add-event-cal"
          >
          <Plus className="h-3.5 w-3.5" />
          <span className="hidden sm:inline text-xs">Event</span>
        </Button>
        </div>
      </div>

      {/* Type filter pills */}
      <div className="flex gap-1 flex-wrap">
        {[
          { key: "all", label: "All", activeClass: "bg-primary/20 text-primary border-primary/40" },
          { key: "event", label: "Events", activeClass: "bg-blue-500/20 text-blue-400 border-blue-500/40" },
          { key: "task", label: "Tasks", activeClass: "bg-purple-500/20 text-purple-400 border-purple-500/40" },
          { key: "obligation", label: "Bills", activeClass: "bg-amber-500/20 text-amber-400 border-amber-500/40" },
          { key: "habit", label: "Habits", activeClass: "bg-green-500/20 text-green-400 border-green-500/40" },
        ].map(f => (
          <button
            key={f.key}
            className={`px-2 py-0.5 rounded-full text-xs font-medium border transition-all ${
              filterType === f.key
                ? f.activeClass
                : "border-border/50 text-muted-foreground hover:bg-muted"
            }`}
            onClick={() => setFilterType(f.key)}
            data-testid={`btn-filter-${f.key}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Calendar Grid — conditional on viewMode */}
      {viewMode === "month" && <div className="rounded-lg border border-border/40 overflow-hidden">
          {/* Weekday header */}
          <div className="grid grid-cols-7 border-b border-border">
            {WEEKDAYS.map(d => (
              <div
                key={d}
                className="text-center text-xs-tight font-medium text-muted-foreground py-1 uppercase tracking-wider"
              >
                {d}
              </div>
            ))}
          </div>

          {/* Days grid */}
          <div className="grid grid-cols-7">
            {days.map((day, idx) => {
              const isToday = day.date === todayStr;
              const isSelected = day.date === selectedDate;
              const dayItems = itemsByDate[day.date] || [];
              const hasItems = dayItems.length > 0;

              // Get unique colors for dots (max 4)
              const dotColors = [...new Set(dayItems.map(i => i.color))].slice(0, 4);

              return (
                <button
                  key={idx}
                  className={`relative min-h-[44px] md:min-h-[100px] p-0.5 md:p-1 border-b border-r border-border/40 transition-all text-left flex flex-col ${
                    day.isCurrentMonth ? "" : "opacity-40"
                  } ${isSelected && !isToday ? "bg-primary/5 ring-1 ring-inset ring-primary/30" : !isSelected && !isToday ? "hover:bg-muted/30" : ""} ${
                    isToday ? "bg-primary/15 ring-2 ring-inset ring-primary/30" : ""
                  }`}
                  onClick={() => setSelectedDate(day.date)}
                  onDoubleClick={() => { setQuickAddDate(day.date); setAddOpen(true); }}
                  data-testid={`day-cell-${day.date}`}
                >
                  <span
                    className={`text-xs md:text-xs leading-none ${
                      isToday
                        ? "font-bold text-primary bg-primary/20 rounded-full w-4 h-4 md:w-5 md:h-5 flex items-center justify-center text-xs-tight md:text-xs"
                        : "font-medium"
                    }`}
                  >
                    {day.dayNum}
                  </span>

                  {/* Event indicators */}
                  {hasItems && (
                    <div className="flex-1 flex flex-col gap-0.5 mt-1 overflow-hidden">
                      {/* Show up to 2 items as mini labels on desktop */}
                      <div className="hidden sm:flex flex-col gap-0.5">
                        {dayItems.slice(0, 2).map(item => (
                          <button
                            key={item.id}
                            className={`w-full text-left text-xs-tight leading-tight truncate px-1 py-0.5 rounded hover:brightness-110 active:brightness-125 transition-all ${item.completed ? 'line-through opacity-50' : ''}`}
                            style={{
                              backgroundColor: `${item.color}18`,
                              color: item.color,
                            }}
                            title={item.title}
                            onClick={(e) => { e.stopPropagation(); setDetailItem(item); }}
                            data-testid={`event-chip-${item.id}`}
                          >
                            {item.completed ? '✓ ' : ''}{item.time ? `${fmt12(item.time)} ` : ''}{item.title.length > 20 ? item.title.slice(0, 20) + '…' : item.title}
                          </button>
                        ))}
                        {dayItems.length > 2 && (
                          <button
                            className="w-full text-left text-xs font-medium text-primary hover:underline px-1 py-0.5"
                            onClick={(e) => { e.stopPropagation(); setSelectedDate(day.date); }}
                            data-testid={`btn-more-${day.date}`}
                          >
                            +{dayItems.length - 2} more
                          </button>
                        )}
                      </div>

                      {/* Mobile: just dots */}
                      <div className="sm:hidden flex gap-0.5 mt-auto">
                        {dotColors.map((color, i) => (
                          <div
                            key={i}
                            className="w-1.5 h-1.5 rounded-full"
                            style={{ backgroundColor: color }}
                          />
                        ))}
                      </div>

                      {/* Category type dots at bottom */}
                      {(() => {
                        const categoryDotColors: Record<string, string> = {
                          event: '#3b82f6',
                          task: '#8b5cf6',
                          obligation: '#f59e0b',
                          habit: '#10b981',
                        };
                        const typesSeen = new Set<string>();
                        return (
                          <div className="hidden sm:flex gap-0.5 justify-center mt-auto pt-0.5">
                            {dayItems.map((ev: any, i: number) => {
                              const type = ev.category === 'finance' ? 'obligation' : ev.type === 'task' ? 'task' : ev.type === 'habit' ? 'habit' : ev.type === 'obligation' ? 'obligation' : 'event';
                              if (typesSeen.has(type)) return null;
                              typesSeen.add(type);
                              return <div key={i} className="w-1 h-1 rounded-full" style={{ background: categoryDotColors[type] || '#6b7280' }} />;
                            })}
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
      </div>}
      {viewMode === "month" && !timelineLoading && Object.values(itemsByDate).every(arr => arr.length === 0) && (
        <div className="rounded-lg border border-dashed border-border/50 p-6 text-center mt-4">
          <CalendarIcon className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground mb-1">No events this month</p>
          <p className="text-xs text-muted-foreground/70">Tell the AI: "Doctor appointment Friday at 2pm" or "Rex vet checkup next week"</p>
        </div>
      )}

      {/* Week View — Time-Blocked Layout */}
      {viewMode === "week" && (() => {
        const weekStart = new Date(viewDate);
        weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Sunday
        const weekDays = Array.from({ length: 7 }, (_, i) => {
          const d = new Date(weekStart); d.setDate(d.getDate() + i);
          return { date: toLocalDateStr(d), day: d, label: WEEKDAYS[i], num: d.getDate() };
        });
        const HOURS = Array.from({ length: 15 }, (_, i) => i + 7); // 7am to 9pm
        const hourHeight = 40; // px per hour

        // Collect all-day items across the week
        const allDayByDate: Record<string, CalendarTimelineItem[]> = {};
        weekDays.forEach(wd => {
          allDayByDate[wd.date] = (itemsByDate[wd.date] || []).filter(i => !i.time || i.allDay);
        });
        const hasAnyAllDay = Object.values(allDayByDate).some(arr => arr.length > 0);

        return (
          <div className="rounded-lg border border-border/40 overflow-hidden">
            {/* Day headers */}
            <div className="grid border-b border-border" style={{ gridTemplateColumns: '40px repeat(7, 1fr)' }}>
              <div className="border-r border-border/40" />
              {weekDays.map(wd => {
                const isTodayCol = wd.date === todayStr;
                return (
                  <div key={wd.date} className={`text-center py-1.5 border-r border-border/40 ${isTodayCol ? 'bg-primary/5' : ''}`}>
                    <div className={`text-[10px] uppercase tracking-wider ${isTodayCol ? 'text-primary font-bold' : 'text-muted-foreground'}`}>{wd.label}</div>
                    <div className={`text-sm font-medium ${isTodayCol ? 'text-primary' : ''}`}>{wd.num}</div>
                  </div>
                );
              })}
            </div>

            {/* All-day row */}
            {hasAnyAllDay && (
              <div className="grid border-b border-border bg-muted/20" style={{ gridTemplateColumns: '40px repeat(7, 1fr)' }}>
                <div className="text-[9px] text-muted-foreground/50 text-right pr-1.5 py-1 border-r border-border/40">all day</div>
                {weekDays.map(wd => (
                  <div key={wd.date} className="px-0.5 py-0.5 border-r border-border/40 space-y-0.5">
                    {allDayByDate[wd.date]?.map(item => (
                      <button key={item.id} onClick={() => { setSelectedDate(wd.date); setDetailItem(item); }}
                        className="w-full text-left px-1 py-0.5 rounded text-[10px] truncate hover:opacity-80 transition-opacity text-white font-medium"
                        style={{ backgroundColor: TYPE_COLORS[item.type] || '#888' }}>
                        {item.title}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {/* Time grid */}
            <div className="overflow-y-auto" style={{ maxHeight: '500px' }}>
              <div className="grid relative" style={{ gridTemplateColumns: '40px repeat(7, 1fr)' }}>
                {/* Hour rows */}
                {HOURS.map(h => (
                  <div key={h} className="contents">
                    <div className="text-[9px] text-muted-foreground/50 text-right pr-1.5 border-r border-border/40 -mt-1.5" style={{ height: `${hourHeight}px` }}>
                      {h === 0 ? '12am' : h === 12 ? '12pm' : h > 12 ? `${h - 12}pm` : `${h}am`}
                    </div>
                    {weekDays.map(wd => {
                      const isTodayCol = wd.date === todayStr;
                      return (
                        <div key={wd.date} className={`border-t border-r border-border/20 relative ${isTodayCol ? 'bg-primary/[0.02]' : ''}`} style={{ height: `${hourHeight}px` }} />
                      );
                    })}
                  </div>
                ))}

                {/* Event blocks overlaid on the grid */}
                {weekDays.map((wd, colIdx) => {
                  const timedItems = (itemsByDate[wd.date] || []).filter(i => i.time && !i.allDay);
                  return timedItems.map(item => {
                    const [hStr, mStr] = (item.time || '00:00').split(':');
                    const startHour = parseInt(hStr, 10) + parseInt(mStr, 10) / 60;
                    let endHour = startHour + 1; // default 1 hour
                    if (item.endTime) {
                      const [eH, eM] = item.endTime.split(':');
                      endHour = parseInt(eH, 10) + parseInt(eM, 10) / 60;
                    }
                    const top = (startHour - 7) * hourHeight;
                    const height = Math.max((endHour - startHour) * hourHeight, 18);
                    // Column position: skip the time-label column (40px), then position in the right day column
                    const leftPct = ((colIdx) / 7) * 100;
                    const widthPct = 100 / 7;
                    return (
                      <button
                        key={item.id}
                        onClick={() => { setSelectedDate(wd.date); setDetailItem(item); }}
                        className="absolute rounded px-1 py-0.5 text-[10px] leading-tight truncate text-left hover:opacity-90 transition-opacity overflow-hidden cursor-pointer border border-white/10"
                        style={{
                          top: `${top}px`,
                          height: `${height}px`,
                          left: `calc(40px + ${leftPct}% + 1px)`,
                          width: `calc(${widthPct}% - 3px)`,
                          backgroundColor: `${TYPE_COLORS[item.type] || '#888'}dd`,
                          color: '#fff',
                          zIndex: 5,
                        }}
                      >
                        <span className="font-medium">{item.title}</span>
                        {height >= 30 && <div className="text-[9px] opacity-80">{fmt12(item.time)}{item.endTime ? ` – ${fmt12(item.endTime)}` : ''}</div>}
                      </button>
                    );
                  });
                })}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Day View */}
      {viewMode === "day" && (() => {
        const dayStr = toLocalDateStr(viewDate);
        const dayItems = (itemsByDate[dayStr] || []).sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"));
        const timedItems = dayItems.filter(i => i.time);
        const allDayItems = dayItems.filter(i => !i.time);
        return (
          <div className="rounded-lg border border-border/40 overflow-hidden">
            <div className="p-3 border-b border-border bg-muted/30">
              <h3 className="text-sm font-semibold">
                {viewDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
              </h3>
              <p className="text-xs text-muted-foreground">{dayItems.length} item{dayItems.length !== 1 ? "s" : ""}</p>
            </div>
            {allDayItems.length > 0 && (
              <div className="px-3 py-2 border-b border-border bg-muted/10">
                <p className="text-xs font-medium text-muted-foreground uppercase mb-1">All Day</p>
                {allDayItems.map(item => (
                  <button key={item.id} onClick={() => setDetailItem(item)}
                    className="flex items-center gap-2 w-full text-left py-1.5 px-2 rounded hover:bg-muted/50 transition-colors"
                    style={{ borderLeft: `3px solid ${TYPE_COLORS[item.type] || "#888"}` }}>
                    <span className="text-xs">{item.title}</span>
                    <Badge variant="outline" className="text-xs-tight ml-auto">{item.type}</Badge>
                  </button>
                ))}
              </div>
            )}
            <div className="divide-y divide-border/50">
              {timedItems.length === 0 && allDayItems.length === 0 && (
                <div className="p-6 text-center text-xs text-muted-foreground">No items scheduled</div>
              )}
              {timedItems.map(item => (
                <button key={item.id} onClick={() => setDetailItem(item)}
                  className="flex items-center gap-3 w-full text-left py-2.5 px-3 hover:bg-muted/50 transition-colors">
                  <span className="text-xs text-muted-foreground w-14 shrink-0">{fmt12(item.time)}</span>
                  <div className="w-1 h-6 rounded-full shrink-0" style={{ backgroundColor: TYPE_COLORS[item.type] || "#888" }} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{item.title}</p>
                    {item.description && <p className="text-xs text-muted-foreground truncate">{item.description}</p>}
                  </div>
                  <Badge variant="outline" className="text-xs-tight shrink-0">{item.type}</Badge>
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Agenda View — scrollable chronological list */}
      {viewMode === "agenda" && (() => {
        const now = new Date();
        const allItems = Object.values(itemsByDate).flat();
        const agendaEvents = [...allItems]
          .filter(ev => new Date(ev.date || '') >= new Date(toLocalDateStr(now)))
          .sort((a, b) => new Date(a.date || '').getTime() - new Date(b.date || '').getTime() || (a.time || '').localeCompare(b.time || ''))
          .slice(0, 50);
        
        const grouped: Record<string, typeof agendaEvents> = {};
        for (const ev of agendaEvents) {
          const dateStr = new Date(ev.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
          if (!grouped[dateStr]) grouped[dateStr] = [];
          grouped[dateStr].push(ev);
        }
        
        if (Object.keys(grouped).length === 0) {
          return (
            <div className="text-center py-12">
              <CalendarDays className="h-12 w-12 text-muted-foreground/20 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No upcoming events</p>
            </div>
          );
        }
        
        return (
          <div className="space-y-4 pb-8">
            {Object.entries(grouped).map(([dateStr, events]) => (
              <div key={dateStr}>
                <div className="sticky top-0 bg-background/95 backdrop-blur-sm py-1.5 px-1 z-10">
                  <span className="text-xs font-bold uppercase tracking-wider text-primary/70">{dateStr}</span>
                </div>
                <div className="space-y-1">
                  {events.map((ev: any, i: number) => {
                    const typeColor = ev.type === 'task' ? '#8b5cf6' : ev.type === 'obligation' ? '#f59e0b' : ev.type === 'habit' ? '#10b981' : '#3b82f6';
                    return (
                      <div key={`${ev.id}-${i}`}
                        className="flex items-start gap-3 p-3 rounded-xl bg-card border border-border/40 cursor-pointer hover:bg-muted/40 active:scale-[0.98] transition-all"
                        onClick={() => { setSelectedDate(ev.date); setDetailItem(ev); }}>
                        <div className="w-1 self-stretch rounded-full shrink-0 mt-0.5" style={{ background: ev.color || typeColor }} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate text-foreground">{ev.title}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            {ev.time && <span className="text-xs text-muted-foreground">{fmt12(ev.time)}</span>}
                            {ev.type && <span className="text-xs text-muted-foreground capitalize">{ev.type}</span>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Day detail — only shows when user explicitly clicks a day (selected != today never auto-opens) */}
      {filteredAgenda.length > 0 && (
        <div className="rounded-lg border border-border/40 bg-card/50" data-testid="section-day-agenda">
          <div className="px-3 pt-2.5 pb-1 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold">{fmtDateFull(selectedDate)}</span>
              <span className="text-[11px] text-muted-foreground">{filteredAgenda.length} item{filteredAgenda.length !== 1 ? 's' : ''}</span>
            </div>
            <Button variant="ghost" size="sm" className="h-6 text-xs gap-1 px-2" onClick={() => setAddOpen(true)}>
              <Plus className="h-2.5 w-2.5" /> Add
            </Button>
          </div>
          <div className="px-2 pb-2">
            <DayAgenda date={selectedDate} items={filteredAgenda} onItemClick={setDetailItem} />
          </div>
        </div>
      )}

      {/* Add Event Dialog */}
      {addOpen && (
        <EventFormDialog
          open={addOpen}
          onClose={() => { setAddOpen(false); setQuickAddDate(null); }}
          defaultDate={quickAddDate ?? selectedDate}
        />
      )}

      {/* Edit Event Dialog */}
      {editEvent && (
        <EventFormDialog
          open={!!editEvent}
          onClose={() => setEditEvent(null)}
          eventId={editEvent.id}
          initial={{
            title: editEvent.title,
            date: editEvent.date,
            time: editEvent.time ?? "",
            endTime: editEvent.endTime ?? "",
            allDay: editEvent.allDay,
            description: editEvent.description ?? "",
            location: editEvent.location ?? "",
            category: editEvent.category,
            recurrence: editEvent.recurrence,
            linkedProfiles: editEvent.linkedProfiles,
          }}
        />
      )}

      {/* Event Detail Dialog */}
      {detailItem && (
        <EventDetailDialog
          open={!!detailItem}
          onClose={() => setDetailItem(null)}
          item={detailItem}
          onEdit={handleEditFromDetail}
        />
      )}
    </div>
  );
}
