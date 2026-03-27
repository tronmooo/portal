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
      toast({ title: isEdit ? "Event updated" : "Event created" });
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
      toast({ title: "Deleted" });
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

export default function CalendarView() {
  const today = new Date();
  const todayStr = toLocalDateStr(today);
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [selectedDate, setSelectedDate] = useState(todayStr);
  const [addOpen, setAddOpen] = useState(false);
  const [detailItem, setDetailItem] = useState<CalendarTimelineItem | null>(null);
  const [editEvent, setEditEvent] = useState<CalendarEvent | null>(null);
  const [filterType, setFilterType] = useState<string>("all");
  const [profileFilter, setProfileFilter] = useState<string>("me");
  const [syncing, setSyncing] = useState(false);
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

  const { data: timelineItems = [] } = useQuery<CalendarTimelineItem[]>({
    queryKey: ["/api/calendar/timeline", startDate, endDate],
    queryFn: () =>
      apiRequest("GET", `/api/calendar/timeline?start=${startDate}&end=${endDate}`).then(r => r.json()),
  });

  // Group items by date (with type + profile filtering)
  const itemsByDate = useMemo(() => {
    const map: Record<string, CalendarTimelineItem[]> = {};
    for (const item of timelineItems) {
      if (filterType !== "all" && item.type !== filterType) continue;
      // Profile filter: when a specific person/pet is selected, ONLY show their items
      if (resolvedProfileId) {
        const linked = item.linkedProfiles || [];
        // Items with no linkedProfiles are considered global (show for "me" only)
        if (linked.length === 0) {
          // Only show unlinked items when viewing self
          if (profileFilter !== "me") continue;
        } else {
          if (!linked.includes(resolvedProfileId)) continue;
        }
      }
      if (!map[item.date]) map[item.date] = [];
      map[item.date].push(item);
    }
    return map;
  }, [timelineItems, filterType, resolvedProfileId, profileFilter]);

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
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear(viewYear - 1);
    } else {
      setViewMonth(viewMonth - 1);
    }
  };

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear(viewYear + 1);
    } else {
      setViewMonth(viewMonth + 1);
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
    <div className="space-y-4" data-testid="calendar-view">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={prevMonth}
            className="h-8 w-8 p-0"
            data-testid="btn-prev-month"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <h2 className="text-sm font-semibold min-w-[140px] text-center" data-testid="text-month-year">
            {fmtMonthYear(viewYear, viewMonth)}
          </h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={nextMonth}
            className="h-8 w-8 p-0"
            data-testid="btn-next-month"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={goToday}
            className="h-7 text-xs ml-1"
            data-testid="btn-today"
          >
            Today
          </Button>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1 text-xs"
            onClick={handleGcalSync}
            disabled={syncing}
            data-testid="btn-gcal-sync"
          >
            <RefreshCw className={`h-3 w-3 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing..." : "Sync GCal"}
          </Button>
          <Button
            size="sm"
            onClick={() => setAddOpen(true)}
            className="h-8 gap-1"
            data-testid="btn-add-event-cal"
          >
          <Plus className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Event</span>
        </Button>
        </div>
      </div>

      {/* Profile filter + type filter pills */}
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={profileFilter} onValueChange={setProfileFilter}>
          <SelectTrigger className="w-[140px] h-7 text-xs" data-testid="select-calendar-profile">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everyone</SelectItem>
            {primaryProfiles.sort((a, b) => a.type === "self" ? -1 : b.type === "self" ? 1 : a.name.localeCompare(b.name)).map(p => (
              <SelectItem key={p.id} value={p.type === "self" ? "me" : p.id}>
                {p.type === "self" ? "Me" : p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex gap-1.5 flex-wrap">
        {[
          { key: "all", label: "All", color: "#4F98A3" },
          { key: "event", label: "Events", color: "#4F98A3" },
          { key: "task", label: "Tasks", color: "#A13544" },
          { key: "obligation", label: "Bills", color: "#BB653B" },
          { key: "habit", label: "Habits", color: "#6DAA45" },
        ].map(f => (
          <button
            key={f.key}
            className={`px-2 py-0.5 rounded-full text-[10px] font-medium border transition-all ${
              filterType === f.key
                ? "text-white border-transparent"
                : "border-border text-muted-foreground hover:border-foreground/30"
            }`}
            style={filterType === f.key ? { backgroundColor: f.color } : {}}
            onClick={() => setFilterType(f.key)}
            data-testid={`btn-filter-${f.key}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Calendar Grid */}
      <Card className="overflow-hidden">
        <CardContent className="p-0">
          {/* Weekday header */}
          <div className="grid grid-cols-7 border-b border-border">
            {WEEKDAYS.map(d => (
              <div
                key={d}
                className="text-center text-[10px] font-medium text-muted-foreground py-2 uppercase tracking-wider"
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
                  className={`relative min-h-[52px] sm:min-h-[64px] p-1 border-b border-r border-border/40 transition-all text-left flex flex-col ${
                    day.isCurrentMonth ? "" : "opacity-30"
                  } ${isSelected ? "bg-primary/5 ring-1 ring-inset ring-primary/30" : "hover:bg-muted/30"} ${
                    isToday ? "bg-primary/8" : ""
                  }`}
                  onClick={() => setSelectedDate(day.date)}
                  data-testid={`day-cell-${day.date}`}
                >
                  <span
                    className={`text-xs font-medium leading-none ${
                      isToday
                        ? "bg-primary text-primary-foreground rounded-full w-5 h-5 flex items-center justify-center"
                        : ""
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
                          <span className="text-[8px] text-muted-foreground px-1">
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
        </CardContent>
      </Card>

      {/* Selected Day Agenda */}
      <Card data-testid="section-day-agenda">
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
        <CardContent className="pt-0 pb-3">
          <DayAgenda
            date={selectedDate}
            items={filteredAgenda}
            onItemClick={setDetailItem}
          />
        </CardContent>
      </Card>

      {/* Add Event Dialog */}
      {addOpen && (
        <EventFormDialog
          open={addOpen}
          onClose={() => setAddOpen(false)}
          defaultDate={selectedDate}
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
