import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar, Clock, MapPin, Repeat, RefreshCw, ListTodo, CreditCard, Cake } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { CalendarEvent, Task, Obligation } from "@shared/schema";

function EventCard({ event }: { event: CalendarEvent }) {
  const dateObj = new Date(event.date);
  const isToday = dateObj.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
  const isPast = dateObj < new Date() && !isToday;

  return (
    <Card className={`${isToday ? "border-primary/50" : isPast ? "opacity-60" : ""}`} data-testid={`card-event-${event.id}`}>
      <CardContent className="p-3 flex gap-3">
        <div className={`flex flex-col items-center justify-center w-12 h-12 rounded-lg shrink-0 ${isToday ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
          <span className="text-xs font-medium">{dateObj.toLocaleDateString("en-US", { month: "short" })}</span>
          <span className="text-lg font-bold leading-none">{dateObj.getDate()}</span>
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium truncate">{event.title}</h3>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
            {event.time && (
              <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                <Clock className="h-2.5 w-2.5" />{event.time}{event.endTime ? ` — ${event.endTime}` : ""}
              </span>
            )}
            {event.location && (
              <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                <MapPin className="h-2.5 w-2.5" />{event.location}
              </span>
            )}
            {event.recurrence !== "none" && (
              <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                <Repeat className="h-2.5 w-2.5" />{event.recurrence}
              </span>
            )}
          </div>
          {event.description && (
            <p className="text-[10px] text-muted-foreground mt-1 line-clamp-1">{event.description}</p>
          )}
          {event.tags.length > 0 && (
            <div className="flex gap-1 mt-1">
              {event.tags.map((t, i) => (
                <Badge key={i} variant="outline" className="text-[9px] h-4">{t}</Badge>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

interface TimelineItem {
  id: string;
  type: "event" | "task" | "obligation";
  title: string;
  displayDate: string;
  time?: string;
  icon: any;
  color: string;
  meta?: string;
}

export default function CalendarPage() {
  const { toast } = useToast();
  const [syncing, setSyncing] = useState(false);
  const [showTasks, setShowTasks] = useState(true);
  const [showBills, setShowBills] = useState(true);

  const { data: events = [], isLoading } = useQuery<CalendarEvent[]>({
    queryKey: ["/api/events"],
    queryFn: () => apiRequest("GET", "/api/events").then(r => r.json()),
  });

  const { data: tasks = [] } = useQuery<Task[]>({
    queryKey: ["/api/tasks"],
    queryFn: () => apiRequest("GET", "/api/tasks").then(r => r.json()),
  });

  const { data: obligations = [] } = useQuery<Obligation[]>({
    queryKey: ["/api/obligations"],
    queryFn: () => apiRequest("GET", "/api/obligations").then(r => r.json()),
  });

  const handleGcalSync = async () => {
    setSyncing(true);
    try {
      const res = await apiRequest("POST", "/api/calendar/sync");
      const data = await res.json();
      toast({
        title: "Calendar synced",
        description: data.message || `Imported ${data.imported} events.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/events"] });
    } catch {
      toast({
        title: "Sync failed",
        description: "Could not connect to Google Calendar.",
        variant: "destructive",
      });
    } finally {
      setSyncing(false);
    }
  };

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  // Expand recurring events into future occurrences (next 60 days)
  const expandedEvents: (CalendarEvent & { displayDate: string })[] = [];
  for (const ev of events) {
    expandedEvents.push({ ...ev, displayDate: ev.date.slice(0, 10) });

    if (ev.recurrence !== "none") {
      const baseDate = new Date(ev.date);
      for (let i = 1; i <= 8; i++) {
        const next = new Date(baseDate);
        switch (ev.recurrence) {
          case "daily": next.setDate(next.getDate() + i); break;
          case "weekly": next.setDate(next.getDate() + i * 7); break;
          case "biweekly": next.setDate(next.getDate() + i * 14); break;
          case "monthly": next.setMonth(next.getMonth() + i); break;
          case "yearly": next.setFullYear(next.getFullYear() + i); break;
        }
        const nextStr = next.toISOString().slice(0, 10);
        if (next.getTime() - now.getTime() > 60 * 86400000) break;
        if (ev.recurrenceEnd && nextStr > ev.recurrenceEnd) break;
        expandedEvents.push({ ...ev, displayDate: nextStr });
      }
    }
  }

  // Sort and group by date
  const sorted = expandedEvents.sort((a, b) => a.displayDate.localeCompare(b.displayDate));
  const upcoming = sorted.filter(e => e.displayDate >= todayStr);
  const past = sorted.filter(e => e.displayDate < todayStr).reverse().slice(0, 5);

  // Group upcoming by relative date
  const todayEvents = upcoming.filter(e => e.displayDate === todayStr);
  const thisWeek = upcoming.filter(e => {
    const d = new Date(e.displayDate);
    return e.displayDate > todayStr && d.getTime() - now.getTime() <= 7 * 86400000;
  });
  const later = upcoming.filter(e => {
    const d = new Date(e.displayDate);
    return d.getTime() - now.getTime() > 7 * 86400000;
  });

  return (
    <div className="h-full overflow-y-auto p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <Calendar className="h-5 w-5" /> Calendar
          </h1>
          <p className="text-xs text-muted-foreground">{events.length} events, {events.filter(e => e.recurrence !== "none").length} recurring</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs gap-1.5"
          onClick={handleGcalSync}
          disabled={syncing}
          data-testid="btn-calendar-page-sync"
        >
          <RefreshCw className={`h-3 w-3 ${syncing ? "animate-spin" : ""}`} />
          {syncing ? "Syncing..." : "Sync Google Calendar"}
        </Button>
      </div>

      {/* Filter toggles */}
      <div className="flex gap-2">
        <Button size="sm" variant={showTasks ? "default" : "outline"} onClick={() => setShowTasks(!showTasks)} className="h-7 text-xs gap-1">
          <ListTodo className="h-3 w-3" /> Tasks
        </Button>
        <Button size="sm" variant={showBills ? "default" : "outline"} onClick={() => setShowBills(!showBills)} className="h-7 text-xs gap-1">
          <CreditCard className="h-3 w-3" /> Bills
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <div key={i} className="h-20 rounded-lg bg-muted animate-pulse" />)}
        </div>
      ) : (
        <>
          {/* Task due dates */}
          {showTasks && (() => {
            const dueTasks = tasks.filter(t => t.dueDate && t.status !== "done");
            const todayTasks = dueTasks.filter(t => t.dueDate === todayStr);
            const overdueTasks = dueTasks.filter(t => t.dueDate! < todayStr);
            if (todayTasks.length === 0 && overdueTasks.length === 0) return null;
            return (
              <div className="space-y-1">
                {overdueTasks.length > 0 && (
                  <>
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-red-500">Overdue Tasks</h2>
                    {overdueTasks.map(t => (
                      <Card key={`task-${t.id}`} className="border-red-500/30">
                        <CardContent className="p-2 flex items-center gap-2">
                          <ListTodo className="h-3.5 w-3.5 text-red-500 shrink-0" />
                          <span className="text-sm flex-1 truncate">{t.title}</span>
                          <span className="text-[10px] text-red-500">{t.dueDate}</span>
                        </CardContent>
                      </Card>
                    ))}
                  </>
                )}
                {todayTasks.length > 0 && (
                  <>
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-amber-500">Tasks Due Today</h2>
                    {todayTasks.map(t => (
                      <Card key={`task-${t.id}`} className="border-amber-500/30">
                        <CardContent className="p-2 flex items-center gap-2">
                          <ListTodo className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                          <span className="text-sm flex-1 truncate">{t.title}</span>
                          <Badge variant="outline" className="text-[10px] h-4">{t.priority}</Badge>
                        </CardContent>
                      </Card>
                    ))}
                  </>
                )}
              </div>
            );
          })()}

          {/* Upcoming bill payments */}
          {showBills && (() => {
            const dueSoon = obligations.filter(o => {
              const d = new Date(o.nextDueDate);
              const diff = Math.ceil((d.getTime() - now.getTime()) / 86400000);
              return diff >= 0 && diff <= 14;
            }).sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate));
            if (dueSoon.length === 0) return null;
            return (
              <div className="space-y-1">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Bills Due Soon</h2>
                {dueSoon.map(o => (
                  <Card key={`ob-${o.id}`}>
                    <CardContent className="p-2 flex items-center gap-2">
                      <CreditCard className="h-3.5 w-3.5 text-primary shrink-0" />
                      <span className="text-sm flex-1 truncate">{o.name}</span>
                      <span className="text-xs font-semibold">${o.amount}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {new Date(o.nextDueDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </span>
                    </CardContent>
                  </Card>
                ))}
              </div>
            );
          })()}

          {todayEvents.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-primary">Today</h2>
              {todayEvents.map((ev, i) => <EventCard key={`${ev.id}-today-${i}`} event={{ ...ev, date: ev.displayDate }} />)}
            </div>
          )}

          {thisWeek.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">This Week</h2>
              {thisWeek.map((ev, i) => <EventCard key={`${ev.id}-week-${i}`} event={{ ...ev, date: ev.displayDate }} />)}
            </div>
          )}

          {later.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Upcoming</h2>
              {later.slice(0, 10).map((ev, i) => <EventCard key={`${ev.id}-later-${i}`} event={{ ...ev, date: ev.displayDate }} />)}
            </div>
          )}

          {past.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Past</h2>
              {past.map((ev, i) => <EventCard key={`${ev.id}-past-${i}`} event={{ ...ev, date: ev.displayDate }} />)}
            </div>
          )}

          {upcoming.length === 0 && past.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <Calendar className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No events yet</p>
              <p className="text-xs">Use the chat to create events</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
