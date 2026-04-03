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
  Calendar as CalendarIcon, ChevronLeft, ChevronRight, Plus,
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
      toast({ title: isEdit ? `"${form.title}" updated` : `"${form.title}" created`, description: form.date ? new Date(form.date + "T12:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : undefined });
      onClose();
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save event", variant: "destructive" });
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
      toast({ title: `"${item?.title || "Item"}" deleted` });
      onClose();
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete", variant: "destructive" });
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
              className="text-[10px] h-5"
              style={{ borderColor: item.color, color: item.color }}
            >
              {TYPE_LABELS[item.type]}
            </Badge>
            {item.category && item.type === "event" && (
              <Badge
                className="text-[10px] h-5 text-white"
                style={{ backgroundColor: item.color }}
              >
                {CATEGORY_LABELS[item.category as EventCategory] || item.category}
              </Badge>
            )}
            {item.meta?.recurrence && item.meta.recurrence !== "none" && (
              <Badge variant="outline" className="text-[10px] h-5">
                <Repeat className="h-2.5 w-2.5 mr-0.5" />{item.meta.recurrence}
              </Badge>
            )}
          </div>

          {/* Time */}
          {item.time && (
            <div className="flex items-center gap-2 text-sm">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              <span>{item.time}{item.endTime ? ` \u2013 ${item.endTime}` : ""}</span>
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
                  className={`text-[10px] h-5 ml-auto ${
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
                <Badge variant="outline" className="text-[10px] h-5 text-green-600 border-green-600">autopay</Badge>
              )}
            </div>
          )}

          {/* Linked profiles */}
          {linkedProfileNames.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <Users className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              {linkedProfileNames.map((name, i) => (
                <Badge key={i} variant="secondary" className="text-[10px] h-5">
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
                  <span className="text-[10px] text-muted-foreground">
                    {item.time}{item.endTime ? ` \u2013 ${item.endTime}` : ""}
                  </span>
                )}
                {item.allDay && !item.time && (
                  <span className="text-[10px] text-muted-foreground">All day</span>
                )}
                {item.location && (
                  <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                    <MapPin className="h-2 w-2" />{item.location}
                  </span>
                )}
              </div>
            </div>
            <Badge
              variant="outline"
              className="text-[8px] h-4 px-1 shrink-0 opacity-60 group-hover:opacity-100"
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
  const [viewMode, setViewMode] = useState<"month" | "week" | "day">("month");
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
  // (computed before the query so filter state is part of the query key)
  const effectiveFilterMode = externalFilterMode ?? (resolvedProfileId ? "selected" : "everyone");
  const effectiveFilterIds = externalFilterIds ?? (resolvedProfileId ? [resolvedProfileId] : []);

  const serverProfileIds = effectiveFilterMode === "selected" && effectiveFilterIds.length > 0
    ? effectiveFilterIds
    : [];

  const { data: timelineItems = [], isLoading: timelineLoading } = useQuery<CalendarTimelineItem[]>({
    queryKey: ["/api/calendar/timeline", startDate, endDate, ...serverProfileIds],
    queryFn: () => {
      const url = serverProfileIds.length > 0
        ? `/api/calendar/timeline?start=${startDate}&end=${endDate}&profileIds=${serverProfileIds.join(",")}`
        : `/api/calendar/timeline?start=${startDate}&end=${endDate}`;
      return apiRequest("GET", url).then(r => r.json());
    },
  });
  const effectiveHasSelf = effectiveFilterMode === "everyone" ||
    effectiveFilterIds.includes(selfProfile?.id || "") ||
    (externalFilterMode === undefined && profileFilter === "me");

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
          <Button variant="outline" size="sm" onClick={goToday} className="h-6 text-[10px] px-2" data-testid="btn-today">
            Today
          </Button>
          {/* View mode toggle */}
          <div className="flex items-center bg-muted/50 rounded-md p-0.5">
            {(["month", "week", "day"] as const).map(mode => (
              <button key={mode} onClick={() => setViewMode(mode)}
                className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${viewMode === mode ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
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
          { key: "all", label: "All" },
          { key: "event", label: "Events" },
          { key: "task", label: "Tasks" },
          { key: "obligation", label: "Bills" },
          { key: "habit", label: "Habits" },
        ].map(f => (
          <button
            key={f.key}
            className={`px-2 py-0.5 rounded-full text-[10px] font-medium border transition-all ${
              filterType === f.key
                ? "bg-primary text-primary-foreground border-transparent"
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
                className="text-center text-[9px] font-medium text-muted-foreground py-1 uppercase tracking-wider"
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
                    className={`text-[10px] md:text-xs leading-none ${
                      isToday
                        ? "font-bold text-primary bg-primary/20 rounded-full w-4 h-4 md:w-5 md:h-5 flex items-center justify-center text-[9px] md:text-xs"
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
                          <div
                            key={item.id}
                            className={`text-[9px] leading-tight truncate px-1 py-0.5 rounded ${item.completed ? 'line-through opacity-50' : ''}`}
                            style={{
                              backgroundColor: `${item.color}18`,
                              color: item.color,
                            }}
                          >
                            {item.completed ? '✓ ' : ''}{item.time ? `${item.time.slice(0, 5)} ` : ''}{item.title}
                          </div>
                        ))}
                        {dayItems.length > 2 && (
                          <span className="text-xs font-medium text-primary hover:underline cursor-pointer px-1 py-0.5">
                            +{dayItems.length - 2} more
                          </span>
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
                    </div>
                  )}
                </button>
              );
            })}
          </div>
      </div>}

      {/* Week View — hourly time grid */}
      {viewMode === "week" && (() => {
        const HOURS = Array.from({ length: 24 }, (_, i) => i);
        const weekStart = new Date(viewDate);
        weekStart.setDate(weekStart.getDate() - weekStart.getDay());
        const weekDays = Array.from({ length: 7 }, (_, i) => {
          const d = new Date(weekStart); d.setDate(d.getDate() + i);
          return { date: toLocalDateStr(d), day: d, label: WEEKDAYS[i], num: d.getDate() };
        });
        const parseHour = (t: string | undefined | null) => {
          if (!t) return -1;
          const [h] = t.split(":").map(Number);
          return h;
        };
        return (
          <div className="rounded-lg border border-border/40 overflow-hidden">
            {/* Header row with day names */}
            <div className="grid grid-cols-[48px_repeat(7,1fr)] border-b border-border bg-muted/30">
              <div className="p-1" />
              {weekDays.map(wd => {
                const isToday = wd.date === todayStr;
                return (
                  <div key={wd.date} className={`text-center py-1.5 border-l border-border/40 ${isToday ? "bg-primary/10" : ""}`}>
                    <div className={`text-[9px] uppercase ${isToday ? "text-primary font-bold" : "text-muted-foreground"}`}>{wd.label}</div>
                    <div className={`text-sm ${isToday ? "text-primary font-bold" : ""}`}>{wd.num}</div>
                  </div>
                );
              })}
            </div>
            {/* All-day events row */}
            {(() => {
              const hasAllDay = weekDays.some(wd => (itemsByDate[wd.date] || []).some(i => !i.time));
              if (!hasAllDay) return null;
              return (
                <div className="grid grid-cols-[48px_repeat(7,1fr)] border-b border-border bg-muted/10">
                  <div className="p-1 text-[9px] text-muted-foreground text-right pr-2 pt-1.5">all day</div>
                  {weekDays.map(wd => {
                    const allDay = (itemsByDate[wd.date] || []).filter(i => !i.time);
                    return (
                      <div key={wd.date} className="border-l border-border/40 p-0.5 min-h-[28px]">
                        {allDay.map(item => (
                          <button key={item.id} onClick={() => { setSelectedDate(wd.date); setDetailItem(item); }}
                            className="w-full text-left px-1 py-0.5 rounded text-[9px] truncate mb-0.5 hover:opacity-80 transition-opacity text-white"
                            style={{ backgroundColor: item.color || TYPE_COLORS[item.type] || "#888" }}>
                            {item.title}
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </div>
              );
            })()}
            {/* Hourly time grid */}
            <div className="max-h-[500px] overflow-y-auto">
              {HOURS.map(hour => (
                <div key={hour} className="grid grid-cols-[48px_repeat(7,1fr)] border-b border-border/20 min-h-[40px]">
                  <div className="text-[9px] text-muted-foreground text-right pr-2 pt-0.5 tabular-nums">
                    {hour === 0 ? "12 AM" : hour < 12 ? `${hour} AM` : hour === 12 ? "12 PM" : `${hour - 12} PM`}
                  </div>
                  {weekDays.map(wd => {
                    const hourItems = (itemsByDate[wd.date] || []).filter(i => i.time && parseHour(i.time) === hour);
                    const isToday = wd.date === todayStr;
                    return (
                      <div key={wd.date}
                        className={`border-l border-border/20 p-0.5 cursor-pointer hover:bg-muted/30 transition-colors ${isToday ? "bg-primary/[0.03]" : ""}`}
                        onClick={() => { setQuickAddDate(wd.date); setAddOpen(true); }}>
                        {hourItems.map(item => (
                          <button key={item.id} onClick={(e) => { e.stopPropagation(); setSelectedDate(wd.date); setDetailItem(item); }}
                            className="w-full text-left px-1 py-0.5 rounded text-[9px] truncate mb-0.5 hover:opacity-80 transition-opacity text-white"
                            style={{ backgroundColor: item.color || TYPE_COLORS[item.type] || "#888" }}>
                            {item.time?.slice(0,5)} {item.title}
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Day View — hourly time slots */}
      {viewMode === "day" && (() => {
        const HOURS = Array.from({ length: 24 }, (_, i) => i);
        const dayStr = toLocalDateStr(viewDate);
        const dayItems = (itemsByDate[dayStr] || []).sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"));
        const allDayItems = dayItems.filter(i => !i.time);
        const parseHour = (t: string | undefined | null) => {
          if (!t) return -1;
          const [h] = t.split(":").map(Number);
          return h;
        };
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
                <p className="text-[10px] font-medium text-muted-foreground uppercase mb-1">All Day</p>
                {allDayItems.map(item => (
                  <button key={item.id} onClick={() => setDetailItem(item)}
                    className="flex items-center gap-2 w-full text-left py-1.5 px-2 rounded hover:bg-muted/50 transition-colors mb-0.5"
                    style={{ borderLeft: `3px solid ${item.color || TYPE_COLORS[item.type] || "#888"}` }}>
                    <span className="text-xs font-medium">{item.title}</span>
                    <Badge variant="outline" className="text-[9px] ml-auto" style={{ borderColor: item.color, color: item.color }}>{item.type}</Badge>
                  </button>
                ))}
              </div>
            )}
            <div className="max-h-[500px] overflow-y-auto">
              {HOURS.map(hour => {
                const hourItems = dayItems.filter(i => i.time && parseHour(i.time) === hour);
                return (
                  <div key={hour} className="flex border-b border-border/20 min-h-[48px] group cursor-pointer hover:bg-muted/20 transition-colors"
                    onClick={() => { setQuickAddDate(dayStr); setAddOpen(true); }}>
                    <div className="w-16 shrink-0 text-[10px] text-muted-foreground text-right pr-3 pt-1 tabular-nums border-r border-border/20">
                      {hour === 0 ? "12 AM" : hour < 12 ? `${hour} AM` : hour === 12 ? "12 PM" : `${hour - 12} PM`}
                    </div>
                    <div className="flex-1 p-0.5">
                      {hourItems.map(item => (
                        <button key={item.id} onClick={(e) => { e.stopPropagation(); setDetailItem(item); }}
                          className="flex items-center gap-2 w-full text-left py-1.5 px-2 rounded mb-0.5 hover:opacity-80 transition-opacity text-white"
                          style={{ backgroundColor: item.color || TYPE_COLORS[item.type] || "#888" }}>
                          <span className="text-[10px] font-mono shrink-0">{item.time?.slice(0,5)}</span>
                          <span className="text-xs font-medium truncate flex-1">{item.title}</span>
                          {item.endTime && <span className="text-[10px] opacity-80 shrink-0">- {item.endTime.slice(0,5)}</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Selected Day Agenda */}
      <div className="rounded-lg border border-border/40" data-testid="section-day-agenda">
        <div className="px-4 pt-3 pb-1 flex items-center justify-between">
          <div>
            <h3 className="text-xs font-semibold">{fmtDateFull(selectedDate)}</h3>
            <p className="text-[10px] text-muted-foreground">
              {filteredAgenda.length} item{filteredAgenda.length !== 1 ? "s" : ""}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={() => {
              setAddOpen(true);
            }}
            data-testid="btn-add-event-agenda"
          >
            <Plus className="h-3 w-3" />Add
          </Button>
        </div>
        <div className="px-3 pb-2">
          <DayAgenda
            date={selectedDate}
            items={filteredAgenda}
            onItemClick={setDetailItem}
          />
        </div>
      </div>

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
