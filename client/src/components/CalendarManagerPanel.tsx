// CalendarManagerPanel — the "Calendar Manager" full-panel UI accessed from
// the Calendar toolbar button next to Agenda. Calendar is the compass of the
// app: this panel is the place where every time-based primitive is created,
// edited, and managed in one place.
//
// Covers:
//   • Quick add (natural-language one-liner that routes to the right primitive)
//   • Manual events (single + recurring, optional profile/doc links)
//   • Recurring obligations of all 9 kinds (bills, subscriptions, loans,
//     medications, maintenance, appointments, habits, doc expirations, tasks)
//   • Birthdays & anniversaries (yearly events linked to a person profile)
//   • Tasks with deadlines / reminders
//   • Document expiration tracking
//
// Reads & writes through existing routes:
//   POST/PATCH/DELETE /api/events
//   POST/PATCH/DELETE /api/obligations
//   POST/PATCH/DELETE /api/tasks
//   GET /api/obligation-occurrences (live status panel)
//   GET /api/profiles, /api/documents (for link pickers)

import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { formatApiError } from "@/lib/formatError";
import { useToast } from "@/hooks/use-toast";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  CalendarDays, Sparkles, Repeat, Cake, ListTodo, FileWarning, Plus, Trash2, Pencil,
  Receipt, CreditCard, Pill, Wrench, CalendarClock, Activity, CheckSquare, Bell,
  AlertTriangle, Loader2,
} from "lucide-react";
import { OBLIGATION_KIND_META, type ObligationKind } from "@shared/schema";
import type { Obligation } from "@shared/schema";

// ─── Helpers ──────────────────────────────────────────────────────────────

const KIND_ICON: Record<ObligationKind, any> = {
  bill: Receipt, subscription: Repeat, loan_payment: CreditCard,
  medication: Pill, maintenance: Wrench, appointment: CalendarClock,
  habit: Activity, doc_expiration: FileWarning, task: CheckSquare,
};

function invalidateAll() {
  queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });
  queryClient.invalidateQueries({ queryKey: ["/api/obligation-occurrences"] });
  queryClient.invalidateQueries({ queryKey: ["/api/events"] });
  queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
  queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
  queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
  queryClient.invalidateQueries({ queryKey: ["/api/cashflow"] });
  queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
  queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
}

function isoDay(d: Date = new Date()): string {
  return d.toLocaleDateString("en-CA");
}

// ─── Quick Add: natural-language one-liner ────────────────────────────────
// Parses very simple patterns like:
//   "Pay rent every month on the 1st $2500"
//   "Car insurance every 6 months"
//   "Medication refill every 30 days"
//   "Doctor appointment Tuesday at 3pm"
//   "Mom birthday on March 12"
// Falls back to creating a manual event if no recurrence pattern is detected.

function parseQuickAdd(text: string): { kind: "obligation" | "event" | "task"; payload: any } | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;

  // Amount
  const amountMatch = text.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
  const amount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, "")) : 0;

  // Frequency
  let frequency: string | null = null;
  let kindGuess: ObligationKind = "bill";
  if (/every\s+week|weekly/.test(t)) frequency = "weekly";
  else if (/every\s+2\s+weeks|biweekly|every\s+other\s+week/.test(t)) frequency = "biweekly";
  else if (/every\s+month|monthly/.test(t)) frequency = "monthly";
  else if (/every\s+3\s+months|every\s+quarter|quarterly/.test(t)) frequency = "quarterly";
  else if (/every\s+6\s+months|semi-?annually/.test(t)) frequency = "monthly"; // store as monthly with custom day, fallback
  else if (/every\s+year|yearly|annually/.test(t)) frequency = "yearly";
  else if (/every\s+(\d+)\s+days?/.test(t)) frequency = "monthly"; // we don't have custom-N-days yet on obligations; route to event with description

  // Kind hints
  if (/rent|bill|utilit|electric|water|gas|internet|phone/.test(t)) kindGuess = "bill";
  else if (/netflix|spotify|prime|subscri/.test(t)) kindGuess = "subscription";
  else if (/loan|mortgage|car payment|auto pay/.test(t)) kindGuess = "loan_payment";
  else if (/refill|medication|prescription|pill/.test(t)) kindGuess = "medication";
  else if (/oil change|maintenance|service|tune.?up/.test(t)) kindGuess = "maintenance";
  else if (/doctor|dentist|appointment|checkup/.test(t)) kindGuess = "appointment";
  else if (/birthday|anniversary/.test(t)) kindGuess = "appointment";
  else if (/passport|license|expir/.test(t)) kindGuess = "doc_expiration";

  // Date hints — pick out a date if present, else first-of-next-month for obligations
  let dueDate: string | null = null;
  const dateMatch = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (dateMatch) dueDate = dateMatch[1];
  const dayOfMonthMatch = t.match(/on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?/);
  if (!dueDate && dayOfMonthMatch) {
    const day = Math.min(28, Math.max(1, parseInt(dayOfMonthMatch[1])));
    const today = new Date();
    const d = new Date(today.getFullYear(), today.getMonth(), day);
    if (d < today) d.setMonth(d.getMonth() + 1);
    dueDate = isoDay(d);
  }
  if (!dueDate) {
    const today = new Date();
    dueDate = isoDay(new Date(today.getFullYear(), today.getMonth(), today.getDate()));
  }

  // Extract a clean name: strip the amount, frequency phrase, and date phrase
  let name = text
    .replace(/\$\s*[\d,]+(?:\.\d{1,2})?/g, "")
    .replace(/every\s+\w+(?:\s+\w+)?/gi, "")
    .replace(/on\s+the\s+\d{1,2}(?:st|nd|rd|th)?/gi, "")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "")
    .replace(/\bpay\b|\bdue\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) name = "Untitled";

  if (frequency) {
    return {
      kind: "obligation",
      payload: {
        name, amount, frequency,
        nextDueDate: dueDate,
        category: kindGuess === "bill" ? "utility" : kindGuess === "subscription" ? "subscription"
          : kindGuess === "loan_payment" ? "loan" : "other",
        kind: kindGuess,
        autopay: false,
        leadTimeDays: OBLIGATION_KIND_META[kindGuess].defaultLeadDays,
        autoLogExpense: kindGuess === "bill" || kindGuess === "subscription",
      },
    };
  }

  // No recurrence → calendar event
  return {
    kind: "event",
    payload: {
      title: name, date: dueDate, allDay: true,
      category: kindGuess === "appointment" ? "health" : "personal",
      recurrence: "none",
      source: "manual",
    },
  };
}

// ─── Quick Add component ──────────────────────────────────────────────────

function QuickAddSection({ onCreated }: { onCreated: () => void }) {
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ReturnType<typeof parseQuickAdd> | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      if (!preview) throw new Error("Nothing to create");
      const path = preview.kind === "obligation" ? "/api/obligations"
        : preview.kind === "task" ? "/api/tasks" : "/api/events";
      return apiRequest("POST", path, preview.payload).then(r => r.json());
    },
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Added to calendar", description: text });
      setText(""); setPreview(null);
      onCreated();
    },
    onError: (err: Error) => toast({ title: "Couldn't add", description: formatApiError(err), variant: "destructive" }),
  });

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <p className="text-sm font-medium">Quick add</p>
        </div>
        <p className="text-xs text-muted-foreground">
          Try: <span className="text-foreground">"Pay rent every month on the 1st $2500"</span> ·
          <span className="text-foreground"> "Car insurance every 6 months"</span> ·
          <span className="text-foreground"> "Medication refill every 30 days"</span>
        </p>
        <div className="flex gap-2">
          <Input
            value={text}
            onChange={(e) => { setText(e.target.value); setPreview(parseQuickAdd(e.target.value)); }}
            placeholder="Describe a one-time or recurring item…"
            data-testid="quick-add-input"
            onKeyDown={(e) => { if (e.key === "Enter" && preview) create.mutate(); }}
          />
          <Button size="sm" disabled={!preview || create.isPending} onClick={() => create.mutate()} data-testid="quick-add-submit">
            {create.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Add"}
          </Button>
        </div>
        {preview && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs space-y-0.5">
            <div className="flex items-center gap-1.5">
              <Badge variant="outline" className="h-4 text-[10px]">
                {preview.kind === "obligation" ? "Recurring" : preview.kind === "task" ? "Task" : "Event"}
              </Badge>
              <span className="font-medium">{preview.payload.name || preview.payload.title}</span>
            </div>
            {preview.kind === "obligation" && (
              <p className="text-muted-foreground">
                {OBLIGATION_KIND_META[(preview.payload.kind as ObligationKind)].label} ·
                {" "}{preview.payload.frequency} · starts {preview.payload.nextDueDate}
                {preview.payload.amount > 0 ? ` · $${preview.payload.amount}` : ""}
              </p>
            )}
            {preview.kind === "event" && (
              <p className="text-muted-foreground">{preview.payload.date} · all-day</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Manual Event Section ─────────────────────────────────────────────────

function ManualEventSection() {
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(isoDay());
  const [time, setTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [allDay, setAllDay] = useState(true);
  const [location, setLocation] = useState("");
  const [category, setCategory] = useState("personal");
  const [recurrence, setRecurrence] = useState("none");
  const [recurrenceEnd, setRecurrenceEnd] = useState("");
  const [description, setDescription] = useState("");

  const { data: profiles = [] } = useQuery<any[]>({
    queryKey: ["/api/profiles"], queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
  });
  const { data: documents = [] } = useQuery<any[]>({
    queryKey: ["/api/documents"], queryFn: () => apiRequest("GET", "/api/documents").then(r => r.json()),
  });
  const [linkedProfile, setLinkedProfile] = useState<string>("");
  const [linkedDoc, setLinkedDoc] = useState<string>("");

  const create = useMutation({
    mutationFn: () => apiRequest("POST", "/api/events", {
      title: title.trim(), date,
      time: !allDay && time ? time : undefined,
      endTime: !allDay && endTime ? endTime : undefined,
      allDay,
      location: location || undefined,
      category,
      recurrence,
      recurrenceEnd: recurrence !== "none" && recurrenceEnd ? recurrenceEnd : undefined,
      description: description || undefined,
      linkedProfiles: linkedProfile ? [linkedProfile] : [],
      linkedDocuments: linkedDoc ? [linkedDoc] : [],
      source: "manual",
    }).then(r => r.json()),
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Event added" });
      setTitle(""); setLocation(""); setDescription(""); setRecurrence("none"); setLinkedProfile(""); setLinkedDoc("");
    },
    onError: (err: Error) => toast({ title: "Couldn't add event", description: formatApiError(err), variant: "destructive" }),
  });

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4" />
          <p className="text-sm font-medium">Manual event</p>
        </div>
        <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Event title" data-testid="event-title" />
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs">Date</Label>
            <Input type="date" value={date} onChange={e => setDate(e.target.value)} data-testid="event-date" />
          </div>
          <div className="flex items-end gap-2">
            <Switch checked={allDay} onCheckedChange={setAllDay} id="all-day" />
            <Label htmlFor="all-day" className="text-xs">All-day</Label>
          </div>
        </div>
        {!allDay && (
          <div className="grid grid-cols-2 gap-2">
            <div><Label className="text-xs">Start time</Label><Input type="time" value={time} onChange={e => setTime(e.target.value)} /></div>
            <div><Label className="text-xs">End time</Label><Input type="time" value={endTime} onChange={e => setEndTime(e.target.value)} /></div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs">Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {["personal","work","health","finance","family","social","travel","education","other"].map(c =>
                  <SelectItem key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Repeats</Label>
            <Select value={recurrence} onValueChange={setRecurrence}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No repeat</SelectItem>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="biweekly">Biweekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="yearly">Yearly</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {recurrence !== "none" && (
          <div>
            <Label className="text-xs">Repeat until (optional)</Label>
            <Input type="date" value={recurrenceEnd} onChange={e => setRecurrenceEnd(e.target.value)} />
          </div>
        )}
        <Input value={location} onChange={e => setLocation(e.target.value)} placeholder="Location (optional)" />
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs">Link person</Label>
            <Select value={linkedProfile || "none"} onValueChange={(v) => setLinkedProfile(v === "none" ? "" : v)}>
              <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— None —</SelectItem>
                {profiles.filter((p: any) => p.entityType === "person").map((p: any) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Link document</Label>
            <Select value={linkedDoc || "none"} onValueChange={(v) => setLinkedDoc(v === "none" ? "" : v)}>
              <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— None —</SelectItem>
                {documents.map((d: any) => (
                  <SelectItem key={d.id} value={d.id}>{d.name || d.title || "Untitled"}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <Textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Notes (optional)" rows={2} />
        <Button size="sm" className="w-full" disabled={!title.trim() || create.isPending} onClick={() => create.mutate()} data-testid="event-create">
          {create.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><Plus className="h-3.5 w-3.5 mr-1" /> Add event</>}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Recurring Obligation Section ─────────────────────────────────────────

function RecurringObligationSection() {
  const { toast } = useToast();
  const [kind, setKind] = useState<ObligationKind>("bill");
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] = useState("monthly");
  const [dueDate, setDueDate] = useState(isoDay());
  const [recurrenceEnd, setRecurrenceEnd] = useState("");
  const [leadTimeDays, setLeadTimeDays] = useState(String(OBLIGATION_KIND_META.bill.defaultLeadDays));
  const [autopay, setAutopay] = useState(false);
  const [autoLog, setAutoLog] = useState(true);
  const [notes, setNotes] = useState("");

  const { data: profiles = [] } = useQuery<any[]>({
    queryKey: ["/api/profiles"], queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
  });
  const { data: documents = [] } = useQuery<any[]>({
    queryKey: ["/api/documents"], queryFn: () => apiRequest("GET", "/api/documents").then(r => r.json()),
  });
  const [linkedAsset, setLinkedAsset] = useState<string>("");
  const [linkedLiability, setLinkedLiability] = useState<string>("");
  const [linkedDoc, setLinkedDoc] = useState<string>("");

  const handleKindChange = (k: ObligationKind) => {
    setKind(k);
    setLeadTimeDays(String(OBLIGATION_KIND_META[k].defaultLeadDays));
    setAutoLog(k === "bill" || k === "subscription");
  };

  const create = useMutation({
    mutationFn: () => apiRequest("POST", "/api/obligations", {
      name: name.trim(),
      amount: parseFloat(amount || "0"),
      frequency,
      category: kind === "bill" ? "utility" : kind === "subscription" ? "subscription"
        : kind === "loan_payment" ? "loan" : kind === "appointment" || kind === "medication" ? "health" : "other",
      nextDueDate: dueDate,
      kind,
      leadTimeDays: parseInt(leadTimeDays) || 0,
      autopay,
      autoLogExpense: autoLog,
      recurrenceEnd: recurrenceEnd || undefined,
      notes: notes || undefined,
      linkedAssetId: linkedAsset || undefined,
      linkedLiabilityId: linkedLiability || undefined,
      linkedDocumentId: linkedDoc || undefined,
    }).then(r => r.json()),
    onSuccess: () => {
      invalidateAll();
      toast({ title: `"${name}" added`, description: `${OBLIGATION_KIND_META[kind].label} · ${frequency}` });
      setName(""); setAmount(""); setNotes(""); setLinkedAsset(""); setLinkedLiability(""); setLinkedDoc("");
    },
    onError: (err: Error) => toast({ title: "Couldn't create", description: formatApiError(err), variant: "destructive" }),
  });

  const meta = OBLIGATION_KIND_META[kind];
  const Icon = KIND_ICON[kind];

  const personProfiles = profiles.filter((p: any) => p.entityType === "person");
  const assetProfiles = profiles.filter((p: any) => p.entityType === "asset");
  const liabilityProfiles = profiles.filter((p: any) => p.entityType === "liability");

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Repeat className="h-4 w-4" />
          <p className="text-sm font-medium">Recurring obligation</p>
        </div>

        <div>
          <Label className="text-xs">Type</Label>
          <Select value={kind} onValueChange={(v) => handleKindChange(v as ObligationKind)}>
            <SelectTrigger data-testid="obl-kind"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(OBLIGATION_KIND_META) as ObligationKind[]).map(k => {
                const K = KIND_ICON[k];
                return (
                  <SelectItem key={k} value={k}>
                    <span className="inline-flex items-center gap-2"><K className="h-3.5 w-3.5" style={{ color: OBLIGATION_KIND_META[k].color }} /> {OBLIGATION_KIND_META[k].label}</span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>

        <Input value={name} onChange={e => setName(e.target.value)} placeholder={`${meta.label} name (e.g. "Rent", "Netflix", "Oil change")`} data-testid="obl-name" />

        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs">Amount ($)</Label>
            <Input type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" data-testid="obl-amount" />
          </div>
          <div>
            <Label className="text-xs">Frequency</Label>
            <Select value={frequency} onValueChange={setFrequency}>
              <SelectTrigger data-testid="obl-frequency"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="biweekly">Biweekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="quarterly">Quarterly</SelectItem>
                <SelectItem value="yearly">Yearly</SelectItem>
                <SelectItem value="once">One-time</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs">First due date</Label>
            <Input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} data-testid="obl-due-date" />
          </div>
          <div>
            <Label className="text-xs">Repeat until (optional)</Label>
            <Input type="date" value={recurrenceEnd} onChange={e => setRecurrenceEnd(e.target.value)} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs">Remind me (days before)</Label>
            <Input type="number" min="0" max="60" value={leadTimeDays} onChange={e => setLeadTimeDays(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2 pt-4">
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={autopay} onCheckedChange={setAutopay} /> Autopay
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={autoLog} onCheckedChange={setAutoLog} /> Auto-log expense
            </label>
          </div>
        </div>

        {/* Link to existing asset / liability / document */}
        <div className="grid grid-cols-1 gap-2 pt-1">
          {(kind === "maintenance" || kind === "bill") && assetProfiles.length > 0 && (
            <div>
              <Label className="text-xs">Link to asset</Label>
              <Select value={linkedAsset || "none"} onValueChange={(v) => setLinkedAsset(v === "none" ? "" : v)}>
                <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— None —</SelectItem>
                  {assetProfiles.map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          {kind === "loan_payment" && liabilityProfiles.length > 0 && (
            <div>
              <Label className="text-xs">Link to liability</Label>
              <Select value={linkedLiability || "none"} onValueChange={(v) => setLinkedLiability(v === "none" ? "" : v)}>
                <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— None —</SelectItem>
                  {liabilityProfiles.map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          {(kind === "doc_expiration" || kind === "appointment" || kind === "medication") && documents.length > 0 && (
            <div>
              <Label className="text-xs">Link to document</Label>
              <Select value={linkedDoc || "none"} onValueChange={(v) => setLinkedDoc(v === "none" ? "" : v)}>
                <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— None —</SelectItem>
                  {documents.map((d: any) => <SelectItem key={d.id} value={d.id}>{d.name || d.title || "Untitled"}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes (optional)" rows={2} />

        <Button size="sm" className="w-full"
          disabled={!name.trim() || !dueDate || create.isPending}
          onClick={() => create.mutate()} data-testid="obl-create">
          {create.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> :
            <><Icon className="h-3.5 w-3.5 mr-1" style={{ color: meta.color }} /> Add {meta.label}</>}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Birthday / Anniversary section ───────────────────────────────────────

function BirthdaySection() {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [type, setType] = useState<"birthday" | "anniversary">("birthday");
  const [date, setDate] = useState(isoDay());

  const { data: profiles = [] } = useQuery<any[]>({
    queryKey: ["/api/profiles"], queryFn: () => apiRequest("GET", "/api/profiles").then(r => r.json()),
  });
  const [linkedPerson, setLinkedPerson] = useState<string>("");

  const create = useMutation({
    mutationFn: () => apiRequest("POST", "/api/events", {
      title: type === "birthday" ? `🎂 ${name}'s birthday` : `💞 ${name} — anniversary`,
      date,
      allDay: true,
      category: "family",
      recurrence: "yearly",
      linkedProfiles: linkedPerson ? [linkedPerson] : [],
      source: "manual",
    }).then(r => r.json()),
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Added", description: `Recurs every year on ${date}` });
      setName(""); setLinkedPerson("");
    },
    onError: (err: Error) => toast({ title: "Couldn't add", description: formatApiError(err), variant: "destructive" }),
  });

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Cake className="h-4 w-4 text-pink-500" />
          <p className="text-sm font-medium">Birthday or anniversary</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Select value={type} onValueChange={(v) => setType(v as any)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="birthday">🎂 Birthday</SelectItem>
              <SelectItem value="anniversary">💞 Anniversary</SelectItem>
            </SelectContent>
          </Select>
          <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>
        <Input value={name} onChange={e => setName(e.target.value)} placeholder="Name (e.g. Mom, Alex)" data-testid="bday-name" />
        <div>
          <Label className="text-xs">Link to person (optional)</Label>
          <Select value={linkedPerson || "none"} onValueChange={(v) => setLinkedPerson(v === "none" ? "" : v)}>
            <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">— None —</SelectItem>
              {profiles.filter((p: any) => p.entityType === "person").map((p: any) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button size="sm" className="w-full" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()} data-testid="bday-create">
          {create.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><Plus className="h-3.5 w-3.5 mr-1" /> Add (recurs yearly)</>}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Task / Reminder section ──────────────────────────────────────────────

function TaskSection() {
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState(isoDay());
  const [priority, setPriority] = useState("medium");
  const [description, setDescription] = useState("");

  const create = useMutation({
    mutationFn: () => apiRequest("POST", "/api/tasks", {
      title: title.trim(), dueDate, priority, description: description || undefined,
    }).then(r => r.json()),
    onSuccess: () => {
      invalidateAll();
      toast({ title: "Reminder added" });
      setTitle(""); setDescription("");
    },
    onError: (err: Error) => toast({ title: "Couldn't add", description: formatApiError(err), variant: "destructive" }),
  });

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-purple-500" />
          <p className="text-sm font-medium">Task or reminder</p>
        </div>
        <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="What needs to be done?" data-testid="task-title" />
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs">Due date</Label>
            <Input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">Priority</Label>
            <Select value={priority} onValueChange={setPriority}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <Textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Details (optional)" rows={2} />
        <Button size="sm" className="w-full" disabled={!title.trim() || create.isPending} onClick={() => create.mutate()} data-testid="task-create">
          {create.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><Plus className="h-3.5 w-3.5 mr-1" /> Add reminder</>}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Manage tab: list everything time-based ───────────────────────────────

type AnyItem =
  | { kind: "obligation"; id: string; title: string; subtitle: string; due: string; tint: string; raw: Obligation }
  | { kind: "event"; id: string; title: string; subtitle: string; due: string; tint: string; raw: any }
  | { kind: "task"; id: string; title: string; subtitle: string; due: string; tint: string; raw: any };

function ManageList({ filter }: { filter: string }) {
  const { toast } = useToast();
  const { data: obligations = [] } = useQuery<Obligation[]>({
    queryKey: ["/api/obligations"], queryFn: () => apiRequest("GET", "/api/obligations").then(r => r.json()),
  });
  const { data: events = [] } = useQuery<any[]>({
    queryKey: ["/api/events"], queryFn: () => apiRequest("GET", "/api/events").then(r => r.json()),
  });
  const { data: tasks = [] } = useQuery<any[]>({
    queryKey: ["/api/tasks"], queryFn: () => apiRequest("GET", "/api/tasks").then(r => r.json()),
  });

  const deleteObligation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/obligations/${id}`),
    onSuccess: () => { invalidateAll(); toast({ title: "Deleted" }); },
    onError: (err: Error) => toast({ title: "Delete failed", description: formatApiError(err), variant: "destructive" }),
  });
  const deleteEvent = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/events/${id}`),
    onSuccess: () => { invalidateAll(); toast({ title: "Deleted" }); },
    onError: (err: Error) => toast({ title: "Delete failed", description: formatApiError(err), variant: "destructive" }),
  });
  const deleteTask = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/tasks/${id}`),
    onSuccess: () => { invalidateAll(); toast({ title: "Deleted" }); },
    onError: (err: Error) => toast({ title: "Delete failed", description: formatApiError(err), variant: "destructive" }),
  });

  const items = useMemo<AnyItem[]>(() => {
    const out: AnyItem[] = [];
    for (const o of obligations) {
      const k = (o.kind || "bill") as ObligationKind;
      out.push({
        kind: "obligation",
        id: o.id,
        title: o.name,
        subtitle: `${OBLIGATION_KIND_META[k].label} · ${o.frequency} · $${Number(o.amount).toFixed(2)}`,
        due: (o.nextDueDate || "").slice(0, 10),
        tint: OBLIGATION_KIND_META[k].color,
        raw: o,
      });
    }
    for (const e of events) {
      out.push({
        kind: "event",
        id: e.id,
        title: e.title,
        subtitle: `Event${e.recurrence && e.recurrence !== "none" ? ` · repeats ${e.recurrence}` : ""}${e.location ? ` · ${e.location}` : ""}`,
        due: (e.date || "").slice(0, 10),
        tint: "#60a5fa",
        raw: e,
      });
    }
    for (const t of tasks) {
      if (t.completed) continue;
      out.push({
        kind: "task",
        id: t.id,
        title: t.title,
        subtitle: `Task · ${t.priority || "medium"} priority`,
        due: (t.dueDate || "").slice(0, 10) || "—",
        tint: "#a78bfa",
        raw: t,
      });
    }
    return out.sort((a, b) => (a.due || "").localeCompare(b.due || ""));
  }, [obligations, events, tasks]);

  const filtered = useMemo(() => {
    if (filter === "all") return items;
    if (filter === "events") return items.filter(i => i.kind === "event");
    if (filter === "tasks") return items.filter(i => i.kind === "task");
    if (filter === "obligations") return items.filter(i => i.kind === "obligation");
    // kind-specific
    return items.filter(i => i.kind === "obligation" && (i.raw as Obligation).kind === filter);
  }, [items, filter]);

  if (filtered.length === 0) {
    return (
      <div className="text-center py-10 text-xs text-muted-foreground">
        <CalendarDays className="h-8 w-8 mx-auto mb-2 opacity-30" />
        Nothing in this view yet.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {filtered.map(it => {
        const Icon = it.kind === "obligation" ? KIND_ICON[((it.raw as Obligation).kind as ObligationKind) || "bill"]
          : it.kind === "task" ? ListTodo : CalendarDays;
        const onDelete = () => {
          if (!confirm(`Delete "${it.title}"?`)) return;
          if (it.kind === "obligation") deleteObligation.mutate(it.id);
          else if (it.kind === "event") deleteEvent.mutate(it.id);
          else deleteTask.mutate(it.id);
        };
        return (
          <div key={`${it.kind}-${it.id}`} className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
            data-testid={`manage-row-${it.kind}-${it.id}`}>
            <span className="inline-flex items-center justify-center rounded-md shrink-0"
              style={{ width: 28, height: 28, background: `${it.tint}22`, color: it.tint }}>
              <Icon className="h-3.5 w-3.5" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{it.title}</p>
              <p className="text-[11px] text-muted-foreground truncate">{it.subtitle} · {it.due}</p>
            </div>
            <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={onDelete} title="Delete">
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────

export interface CalendarManagerPanelProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export default function CalendarManagerPanel({ open, onOpenChange }: CalendarManagerPanelProps) {
  const [tab, setTab] = useState("create");
  const [manageFilter, setManageFilter] = useState("all");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl p-0 flex flex-col" data-testid="calendar-manager-panel">
        <SheetHeader className="px-4 py-3 border-b border-border">
          <SheetTitle className="text-base flex items-center gap-2">
            <CalendarDays className="h-4 w-4" />
            Calendar Manager
          </SheetTitle>
          <SheetDescription className="text-xs">
            Calendar is the compass. Add, edit, and manage every time-based item in one place.
          </SheetDescription>
        </SheetHeader>

        <Tabs value={tab} onValueChange={setTab} className="flex-1 flex flex-col overflow-hidden">
          <TabsList className="mx-4 mt-3 grid grid-cols-2" data-testid="manager-tabs">
            <TabsTrigger value="create" data-testid="manager-tab-create">
              <Plus className="h-3.5 w-3.5 mr-1.5" /> Create
            </TabsTrigger>
            <TabsTrigger value="manage" data-testid="manager-tab-manage">
              <Pencil className="h-3.5 w-3.5 mr-1.5" /> Manage
            </TabsTrigger>
          </TabsList>

          <TabsContent value="create" className="flex-1 overflow-hidden mt-3">
            <ScrollArea className="h-full px-4 pb-6">
              <div className="space-y-3">
                <QuickAddSection onCreated={() => setTab("manage")} />
                <RecurringObligationSection />
                <ManualEventSection />
                <BirthdaySection />
                <TaskSection />
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="manage" className="flex-1 overflow-hidden mt-3">
            <div className="px-4 pb-2">
              <div className="flex flex-wrap gap-1.5">
                {[
                  { k: "all", l: "All" },
                  { k: "obligations", l: "Recurring" },
                  { k: "events", l: "Events" },
                  { k: "tasks", l: "Tasks" },
                  { k: "bill", l: "Bills" },
                  { k: "subscription", l: "Subs" },
                  { k: "loan_payment", l: "Loans" },
                  { k: "appointment", l: "Appts" },
                  { k: "medication", l: "Meds" },
                  { k: "maintenance", l: "Maint" },
                  { k: "doc_expiration", l: "Docs" },
                  { k: "habit", l: "Habits" },
                ].map(f => (
                  <Button key={f.k} size="sm" variant={manageFilter === f.k ? "default" : "outline"}
                    className="h-6 px-2 text-[11px]" onClick={() => setManageFilter(f.k)}
                    data-testid={`manager-filter-${f.k}`}>
                    {f.l}
                  </Button>
                ))}
              </div>
            </div>
            <ScrollArea className="h-full px-4 pb-6">
              <ManageList filter={manageFilter} />
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
