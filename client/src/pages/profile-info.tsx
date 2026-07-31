// ── Info tab: the home for everything about a person ─────────────────────────
// Hub Info tab. Two modes:
//   • /profiles/:id/info  → one profile's Info (identity fields, notes, tags,
//     documents, chat-saved facts, recent activity, latest journal).
//   • /profiles           → "Everyone combined" — a per-person Info summary for
//     all people plus the shared chat-saved facts.
//
// This is the canonical place where ALL data that doesn't fit a tracker shows
// up: profile `fields` (edited here or written by chat's update_profile),
// uploaded documents linked to the profile, and free-form "remembered" facts
// from chat (the memories store). The deep per-type data (assets, liabilities,
// finance) lives on the other hub tabs.
//
// Data comes from /api/profile-bootstrap/:id under the SAME cache key the
// detail page uses (["/api/profiles", id, "detail"]), so it's instant when
// you've already visited the profile and edits here reflect there too.
import { useState, useRef, useEffect } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useRoute, useLocation, Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { flattenProfile } from "@/lib/flattenProfile";
import { infoFieldsForType, readField, computeAge } from "@/lib/profile-fields";
import { useToast } from "@/hooks/use-toast";
import { formatApiError } from "@/lib/formatError";
import { DocumentViewerDialog } from "@/components/DocumentViewer";
import { prefetchDocument } from "@/lib/document-preview";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Plus, Check, X, Pencil, BookOpen, Activity as ActivityIcon, FileText, Brain, Layers, StickyNote, Tag } from "lucide-react";
import { deleteProfileFields } from "@shared/profile-field-identity";
import { stringifyField, previewUnrenderable } from "@/lib/field-display";
import { SectionHeading } from "@/components/ui/section-heading";
import { BubbleSkeletonGrid } from "@/components/ui/skeleton";

function timeAgo(ts: string | undefined): string {
  if (!ts) return "";
  const d = new Date(ts).getTime();
  if (isNaN(d)) return "";
  const s = Math.max(0, Date.now() - d) / 1000;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// The Executive tab's accents, so a heading here is the same colour it is
// there: blue = informational, purple = AI/derived, orange = documents.
const INFO_TONE = {
  fields: "213 90% 62%",
  group: "240 60% 65%",
  notes: "43 96% 53%",
  tags: "173 60% 44%",
  docs: "25 80% 54%",
  memories: "280 75% 62%",
  activity: "155 65% 45%",
  journal: "262 70% 62%",
};

function fieldLabel(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, c => c.toUpperCase());
}

// Nested storage groups on a profile's `fields`. We no longer hide these — they
// render as labeled sub-sections so nothing the user (or chat) saved is buried.
const NESTED_GROUP_KEYS = new Set([
  "vehicles", "insurance", "housing", "other", "finance", "subscriptions",
  "utilities", "personal", "identity", "health", "contact", "emergency",
  "pets", "pet",
]);

// ── Route dispatcher: single-profile Info, else redirect to Self's Info ───────
// There is no standalone "everyone" Info page — /profiles resolves to the Self
// profile's Info tab (the hub switcher is how you change whose Info you view).
export default function ProfileInfoPage() {
  const [singleMatch, singleParams] = useRoute("/profiles/:id/info");
  const id = singleMatch ? ((singleParams as { id?: string } | null)?.id || "") : "";
  if (id) return <SingleProfileInfo id={id} />;
  return <InfoSelfRedirect />;
}

// When no single person is selected, send the Info tab to the Self profile.
function InfoSelfRedirect() {
  const [, navigate] = useLocation();
  // PERF Phase 2.3 (2026-07-16): this redirect only needs id+type to find the
  // Self profile, but it fetched the FULL /api/profiles (select * incl. heavy
  // JSONB — measured 6.4s in production) before navigating. Use the lite
  // endpoint (same key shape the hub switcher + route dispatcher share), and
  // when the bootstrap already seeded the full list, resolve with ZERO network.
  const fullProfilesCache = queryClient.getQueryData<any[]>(["/api/profiles"]);
  const { data: profiles, isLoading } = useQuery<any[]>({
    queryKey: ["/api/profiles", "lite"],
    queryFn: async () => (await apiRequest("GET", "/api/profiles/lite")).json(),
    initialData: fullProfilesCache as any[] | undefined,
    staleTime: 30_000,
  });
  const self = (profiles || []).find((p: any) => p.type === "self");
  useEffect(() => {
    if (self?.id) navigate(`/profiles/${self.id}/info`, { replace: true });
  }, [self?.id]);

  if (isLoading || self?.id) {
    return (
      <div className="p-6 flex items-center justify-center h-full" data-testid="page-profile-info">
        <Skeleton className="h-16 w-48" />
      </div>
    );
  }
  return (
    <div className="p-6 text-center" data-testid="page-profile-info">
      <p className="text-sm text-muted-foreground">No profile to show yet.</p>
    </div>
  );
}

// ── One profile's Info ────────────────────────────────────────────────────────
function SingleProfileInfo({ id }: { id: string }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [addingField, setAddingField] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");

  const { data: profile, isLoading, error } = useQuery<any>({
    queryKey: ["/api/profiles", id, "detail"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/profile-bootstrap/${id}`);
      const b = await res.json();
      if (b?.detail) {
        if (b.profiles) queryClient.setQueryData(["/api/profiles"], b.profiles);
        return flattenProfile(b.detail);
      }
      const r2 = await apiRequest("GET", `/api/profiles/${id}/detail`);
      return flattenProfile(await r2.json());
    },
    enabled: !!id,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (profile?.name) document.title = `${profile.name} · Info — Portol`;
  }, [profile?.name]);

  // Single PATCH mutation for every field/notes/tags edit — merges into the
  // existing fields object so we never clobber sibling keys (same shape the
  // detail page uses).
  const patch = useMutation({
    mutationFn: async (body: any) => { await apiRequest("PATCH", `/api/profiles/${id}`, body); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", id, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
    },
    onError: (err: Error) => toast({ title: "Failed to save", description: formatApiError(err), variant: "destructive" }),
  });

  const saveField = (key: string, value: string) =>
    patch.mutate({ fields: { [key]: value } });
  // Profile field delete must use the explicit `fieldsToDelete` signal.
  // The storage layer (mergeAndApplyDeletes) MERGES incoming `fields` on top
  // of the existing JSONB, so sending `{ fields: rest }` with the key omitted
  // is a no-op — the removed key stays in storage and re-surfaces on refresh.
  // Optimistically strip the key from the detail cache so the X click feels
  // instant, and roll back if the PATCH fails. Mirrors the pattern used in
  // profile-detail.tsx so both Info and Detail pages behave the same way.
  const removeField = (key: string) => {
    (async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/profiles", id, "detail"] });
      const prev = queryClient.getQueryData(["/api/profiles", id, "detail"]);
      queryClient.setQueryData(["/api/profiles", id, "detail"], (old: any) => {
        if (!old?.fields) return old;
        // Use the SAME resolver the server uses, so the optimistic view and the
        // saved result agree. Destructuring `{ [key]: _drop, ...rest }` only
        // removed an exact top-level key — a nested `identity.licenseNumber`
        // stayed put and the card sat there until the refetch landed.
        return { ...old, fields: deleteProfileFields(old.fields, [key]).fields };
      });
      try {
        await apiRequest("PATCH", `/api/profiles/${id}`, { fieldsToDelete: [key] });
        queryClient.invalidateQueries({ queryKey: ["/api/profiles", id, "detail"] });
        queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
        queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"], refetchType: "none" });
      } catch (err: any) {
        if (prev !== undefined) queryClient.setQueryData(["/api/profiles", id, "detail"], prev);
        toast({ title: "Failed to remove", description: formatApiError(err), variant: "destructive" });
      }
    })();
  };

  const avatarMutation = useMutation({
    mutationFn: async (payload: { fileData: string; mimeType: string }) => {
      await apiRequest("POST", `/api/profiles/${id}/photo`, payload);
    },
    onSuccess: () => {
      toast({ title: "Photo updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles", id, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
    },
    onError: (err: Error) => toast({ title: "Failed to update photo", description: formatApiError(err), variant: "destructive" }),
  });
  const onAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast({ title: "Image too large", description: "Choose an image under 5MB", variant: "destructive" }); return; }
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      avatarMutation.mutate({ fileData: result.includes(",") ? result.split(",")[1] : result, mimeType: file.type || "image/jpeg" });
    };
    reader.readAsDataURL(file);
  };

  if (isLoading) {
    return (
      <div className="p-4 md:p-6 space-y-4" data-testid="page-profile-info">
        <Skeleton className="h-11 w-48 rounded-full" />
        <BubbleSkeletonGrid count={6} rows={1} height={72}
          className="grid-cols-2 sm:grid-cols-3 lg:grid-cols-6" />
      </div>
    );
  }
  if (error || !profile) {
    return (
      <div className="p-6 text-center" data-testid="page-profile-info">
        <p className="text-sm text-destructive mb-2">Profile not found</p>
        <Link href="/profiles" className="text-xs text-primary underline">Back to Info</Link>
      </div>
    );
  }

  const fields = profile.fields || {};
  const defs = infoFieldsForType(profile.type);
  const shownKeys = new Set(defs.map(d => d.key.toLowerCase()));
  // Identity fields that have a value, in declared order.
  const rows: Array<{ key: string; label: string; value: string }> = [];
  const age = computeAge(readField(fields, "birthday"));
  if (age) rows.push({ key: "__age", label: "Age", value: age });
  for (const d of defs) {
    const v = readField(fields, d.key);
    if (v === undefined || v === null || v === "") continue;
    // String(v) on a composite field renders the literal "[object Object]" —
    // which is what ADDRESS showed on this screen.
    //
    // Do NOT skip a field stringifyField can't render. This row carries the
    // delete button, so skipping it leaves a field the user can neither read
    // nor remove — the same "why won't it let me delete them" dead end that
    // the always-visible X was added to fix. Show a preview instead.
    const text = stringifyField(v) || previewUnrenderable(v);
    rows.push({ key: d.key, label: d.label, value: text });
  }
  // Custom scalar fields the user (or chat) added that aren't in the identity
  // whitelist and aren't nested storage groups — surfaced so "+ Add field" AND
  // anything saved from chat via update_profile shows up.
  const nestedGroups: Array<{ key: string; entries: Array<[string, any]> }> = [];
  for (const [k, v] of Object.entries(fields)) {
    if (shownKeys.has(k.toLowerCase())) continue;
    if (["dateofbirth", "dob"].includes(k.toLowerCase())) continue;
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "object") {
      // Render nested groups (and known group keys) as their own sub-section.
      const entries = Array.isArray(v)
        ? v.map((item, i) => [String(i + 1), typeof item === "object" ? JSON.stringify(item) : item] as [string, any])
        : Object.entries(v).filter(([, vv]) => vv !== undefined && vv !== null && vv !== "" && typeof vv !== "object");
      if (entries.length > 0) nestedGroups.push({ key: k, entries });
      continue;
    }
    if (NESTED_GROUP_KEYS.has(k)) continue; // group key holding a scalar — skip label noise
    rows.push({ key: k, label: fieldLabel(k), value: stringifyField(v) });
  }

  const timeline: any[] = Array.isArray(profile.timeline) ? profile.timeline.slice(0, 6) : [];
  const journal: any[] = Array.isArray(profile.relatedJournal) ? profile.relatedJournal : [];
  const latestJournal = journal[0];
  const documents: any[] = Array.isArray(profile.relatedDocuments) ? profile.relatedDocuments : [];
  const initial = (profile.name || "?").charAt(0).toUpperCase();
  const isSelf = profile.type === "self";

  return (
    <div className="p-4 md:p-6 space-y-5 overflow-y-auto h-full pb-24" data-testid="page-profile-info">
      {/* Header — info-focused, compact identity chip (avatar de-emphasized). */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => avatarInputRef.current?.click()}
          className="medallion pressable relative w-11 h-11 overflow-hidden"
          style={{ ["--accent-hsl" as any]: INFO_TONE.fields }}
          aria-label="Change photo"
          data-testid="info-avatar"
          title="Change photo"
        >
          {profile.avatar
            ? <img src={profile.avatar} alt="" className="w-full h-full object-cover rounded-full" />
            : <span className="text-base font-bold">{initial}</span>}
        </button>
        <input ref={avatarInputRef} type="file" accept="image/*" className="hidden" onChange={onAvatarChange} />
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-bold tracking-tight leading-tight truncate" data-testid="info-name">{profile.name}</h1>
          <p className="text-xs text-muted-foreground capitalize">{profile.type}</p>
        </div>
        <Button variant="outline" size="sm" className="h-8 gap-1 text-xs" onClick={() => setAddingField(v => !v)} data-testid="info-add-field">
          <Plus className="h-3.5 w-3.5" /> Add field
        </Button>
      </div>

      {/* Add-field inline form */}
      {addingField && (
        <Card className="p-3 flex flex-wrap items-end gap-2" data-testid="info-add-field-form">
          <div className="flex-1 min-w-[120px]">
            <label className="micro-label text-muted-foreground">Field</label>
            <Input value={newKey} onChange={e => setNewKey(e.target.value)} placeholder="e.g. Nickname" className="h-8 text-xs" data-testid="info-new-key" />
          </div>
          <div className="flex-1 min-w-[120px]">
            <label className="micro-label text-muted-foreground">Value</label>
            <Input value={newVal} onChange={e => setNewVal(e.target.value)} placeholder="Value" className="h-8 text-xs" data-testid="info-new-val" />
          </div>
          <Button
            size="sm" className="h-8 text-xs"
            disabled={!newKey.trim() || !newVal.trim()}
            onClick={() => { saveField(newKey.trim(), newVal.trim()); setNewKey(""); setNewVal(""); setAddingField(false); }}
            data-testid="info-new-save"
          >Add</Button>
        </Card>
      )}

      {/* Identity field grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2" data-testid="info-fields">
        {rows.map(r => (
          <FieldCell
            key={r.key}
            label={r.label}
            value={r.value}
            editable={r.key !== "__age"}
            onSave={r.key !== "__age" ? (v) => saveField(r.key, v) : undefined}
            onRemove={r.key !== "__age" && !["birthday"].includes(r.key) ? () => removeField(r.key) : undefined}
          />
        ))}
        {rows.length === 0 && (
          <p className="col-span-full text-xs text-muted-foreground py-4 text-center">No details yet — tap “Add field”.</p>
        )}
      </div>

      {/* Nested field groups (e.g. finance, health, credentials) */}
      {nestedGroups.map(g => (
        <Card className="p-4" key={g.key} data-testid={`info-group-${g.key}`}>
          <SectionHeading title={fieldLabel(g.key)} icon={Layers} accent={INFO_TONE.group} count={g.entries.length} />
          {/*
            Nested-group fields used to render as plain <div> text — no
            FieldCell, no onSave, no onRemove. Every value under IDENTITY,
            PERSONAL, VEHICLES etc. was permanently read-only, which is most of
            what a scanned document writes.

            User, 2026-07-26: "Why won't it let me edit these or delete them".
            They were right: on this screen those fields had no CRUD at all.

            They now use the SAME FieldCell as the top-level grid, so a nested
            field edits and deletes exactly like any other. `removeField` sweeps
            nested groups by field identity (shared/profile-field-identity), so
            deleting `identity.licenseNumber` really removes it rather than
            leaving a twin to be promoted back on the next read.
          */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 mt-2">
            {g.entries.map(([k, v]) => (
              <FieldCell
                key={k}
                label={fieldLabel(k)}
                value={stringifyField(v)}
                editable
                onSave={(nv) => saveField(k, nv)}
                onRemove={() => removeField(k)}
              />
            ))}
          </div>
        </Card>
      ))}

      {/* Notes + Tags */}
      <NotesTags
        notes={profile.notes || ""}
        tags={profile.tags || []}
        onSaveNotes={(notes) => patch.mutate({ notes })}
        onSaveTags={(tags) => patch.mutate({ tags })}
      />

      {/* Documents linked to this profile */}
      <DocumentsSection documents={documents} />

      {/* Chat-saved facts (the memories store) — user-level, shown on Self */}
      {isSelf && <MemoriesSection />}

      {/* Activity + Journal */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card className="p-4" data-testid="info-activity">
          <SectionHeading title={`Activity · ${profile.name}`} icon={ActivityIcon} accent={INFO_TONE.activity} count={timeline.length} />
          {timeline.length === 0 ? (
            <p className="text-xs text-muted-foreground">No recent activity.</p>
          ) : (
            <div className="space-y-2">
              {timeline.map((t: any) => (
                <div key={t.id} className="flex items-baseline gap-3 text-sm">
                  <span className="text-[11px] font-mono text-muted-foreground w-8 shrink-0">{timeAgo(t.timestamp)}</span>
                  <span className="truncate">{t.title}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* The whole card opens the journal (user report 2026-07-16: "when I
            press that it should show me everything I said"); the button
            deep-links straight into the free-write composer. */}
        <Card
          className="p-4 flex flex-col cursor-pointer hover:bg-muted/30 transition-colors"
          data-testid="info-journal"
          role="button"
          tabIndex={0}
          onClick={() => navigate("/journal")}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") navigate("/journal"); }}
        >
          <SectionHeading
            title="Journal" icon={BookOpen} accent={INFO_TONE.journal}
            meta={latestJournal ? `Last ${timeAgo(latestJournal.date || latestJournal.createdAt)} ago` : undefined}
          />
          {latestJournal ? (
            <p className="text-sm italic text-foreground/90 flex-1">"{String(latestJournal.content || "").slice(0, 140)}…"</p>
          ) : (
            <p className="text-xs text-muted-foreground flex-1">No journal entries yet.</p>
          )}
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" className="h-8 text-xs" onClick={(e) => { e.stopPropagation(); navigate("/journal?new=1"); }} data-testid="info-write-entry">
              <Pencil className="h-3.5 w-3.5 mr-1.5" /> Write entry
            </Button>
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={(e) => { e.stopPropagation(); navigate("/journal"); }} data-testid="info-view-journal">
              View all
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ── Documents section ─────────────────────────────────────────────────────────
function DocumentsSection({ documents }: { documents: any[] }) {
  const [viewing, setViewing] = useState<any | null>(null);
  if (!documents || documents.length === 0) return null;
  return (
    <Card className="p-4" data-testid="info-documents">
      <SectionHeading title="Documents" icon={FileText} accent={INFO_TONE.docs} count={documents.length} />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {documents.map((d: any) => (
          <button
            key={d.id}
            onPointerDown={() => prefetchDocument(d.id, d.mimeType)}
            onClick={() => setViewing(d)}
            className="flex items-center gap-2 p-2.5 rounded-lg border hover:border-primary/50 text-left min-w-0"
            data-testid={`info-doc-${d.id}`}
          >
            <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="min-w-0">
              <span className="block text-sm font-medium truncate">{d.name}</span>
              <span className="block text-[11px] text-muted-foreground truncate">{d.type || d.mimeType}</span>
            </span>
          </button>
        ))}
      </div>
      {viewing && (
        <DocumentViewerDialog
          open={!!viewing}
          onOpenChange={() => setViewing(null)}
          id={viewing.id}
          name={viewing.name}
          mimeType={viewing.mimeType}
          data={viewing.fileData || ""}
        />
      )}
    </Card>
  );
}

// ── Chat-saved facts (memories store) ─────────────────────────────────────────
function MemoriesSection() {
  const { toast } = useToast();
  const { data: memories } = useQuery<any[]>({
    queryKey: ["/api/memories"],
    queryFn: async () => (await apiRequest("GET", "/api/memories")).json(),
    staleTime: 30_000,
  });

  const update = useMutation({
    mutationFn: async ({ id, value }: { id: string; value: string }) => { await apiRequest("PATCH", `/api/memories/${id}`, { value }); },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/memories"] }),
    onError: (err: Error) => toast({ title: "Failed to save", description: formatApiError(err), variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/memories/${id}`); },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/memories"] }),
    onError: (err: Error) => toast({ title: "Failed to remove", description: formatApiError(err), variant: "destructive" }),
  });

  if (!memories || memories.length === 0) return null;

  return (
    <Card className="p-4" data-testid="info-memories">
      <SectionHeading title="Facts from chat" icon={Brain} accent={INFO_TONE.memories} count={memories.length} />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {memories.map((m: any) => (
          <FieldCell
            key={m.id}
            label={fieldLabel(m.key || m.category || "note")}
            value={stringifyField(m.value)}
            editable
            onSave={(v) => update.mutate({ id: m.id, value: v })}
            onRemove={() => remove.mutate(m.id)}
          />
        ))}
      </div>
    </Card>
  );
}

// ── Single editable identity cell ────────────────────────────────────────────
function FieldCell({ label, value, editable, onSave, onRemove }: {
  label: string;
  value: string;
  editable: boolean;
  onSave?: (v: string) => void;
  onRemove?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);

  if (editing && editable) {
    return (
      <Card className="p-2.5">
        <label className="micro-label text-muted-foreground">{label}</label>
        <div className="flex items-center gap-1 mt-1">
          <Input value={draft} onChange={e => setDraft(e.target.value)} className="h-7 text-xs" autoFocus
            onKeyDown={e => { if (e.key === "Enter") { onSave?.(draft); setEditing(false); } if (e.key === "Escape") { setDraft(value); setEditing(false); } }}
            data-testid={`info-edit-${label}`} />
          <button onClick={() => { onSave?.(draft); setEditing(false); }} className="text-emerald-500" aria-label="Save"><Check className="h-4 w-4" /></button>
          <button onClick={() => { setDraft(value); setEditing(false); }} className="text-muted-foreground" aria-label="Cancel"><X className="h-4 w-4" /></button>
        </div>
      </Card>
    );
  }
  return (
    <Card
      className={`p-2.5 group relative ${editable ? "cursor-pointer hover:border-primary/50" : ""}`}
      onClick={() => editable && setEditing(true)}
      data-testid={`info-cell-${label}`}
    >
      <div className="micro-label text-muted-foreground">{label}</div>
      <div className="text-sm font-medium truncate mt-0.5">{value}</div>
      {onRemove && (
        // ALWAYS VISIBLE. This was `opacity-0 group-hover:opacity-100`, so the
        // delete control only existed under a mouse cursor. Portol is used on a
        // phone, where nothing ever hovers — the X was never rendered visibly
        // and the fields looked permanently undeletable.
        // User, 2026-07-26: "Why won't it let me edit these or delete them".
        // A hit target of 24px keeps it tappable without covering the value.
        <button
          onClick={e => { e.stopPropagation(); onRemove(); }}
          className="absolute top-0.5 right-0.5 h-6 w-6 grid place-items-center rounded-md text-muted-foreground/70 hover:text-destructive hover:bg-destructive/10 active:bg-destructive/20 transition-colors"
          aria-label={`Remove ${label}`}
          data-testid={`info-remove-${label}`}
        ><X className="h-3.5 w-3.5" /></button>
      )}
    </Card>
  );
}

// ── Notes + tags editor ──────────────────────────────────────────────────────
function NotesTags({ notes, tags, onSaveNotes, onSaveTags }: {
  notes: string;
  tags: string[];
  onSaveNotes: (v: string) => void;
  onSaveTags: (v: string[]) => void;
}) {
  const [editingNotes, setEditingNotes] = useState(false);
  const [draft, setDraft] = useState(notes);
  const [tagInput, setTagInput] = useState("");
  useEffect(() => { setDraft(notes); }, [notes]);

  const addTag = () => {
    const t = tagInput.trim();
    if (!t || tags.includes(t)) { setTagInput(""); return; }
    onSaveTags([...tags, t]);
    setTagInput("");
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <Card className="p-4" data-testid="info-notes">
        <SectionHeading
          title="Notes" icon={StickyNote} accent={INFO_TONE.notes}
          meta={!editingNotes ? (
            <button onClick={() => setEditingNotes(true)} className="text-muted-foreground hover:text-foreground" aria-label="Edit notes"><Pencil className="h-3.5 w-3.5" /></button>
          ) : undefined}
        />
        {editingNotes ? (
          <div className="space-y-2">
            <Textarea value={draft} onChange={e => setDraft(e.target.value)} rows={3} className="text-xs" placeholder="Add notes…" data-testid="info-notes-input" />
            <div className="flex gap-2">
              <Button size="sm" className="h-7 text-xs" onClick={() => { onSaveNotes(draft); setEditingNotes(false); }}>Save</Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setDraft(notes); setEditingNotes(false); }}>Cancel</Button>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground whitespace-pre-wrap min-h-[1.5rem]">{notes || "No notes."}</p>
        )}
      </Card>

      <Card className="p-4" data-testid="info-tags">
        <SectionHeading title="Tags" icon={Tag} accent={INFO_TONE.tags} count={tags.length} />
        <div className="flex flex-wrap items-center gap-1.5">
          {tags.map(tag => (
            <Badge key={tag} variant="secondary" className="gap-1 text-xs">
              {tag}
              <button onClick={() => onSaveTags(tags.filter(t => t !== tag))} aria-label={`Remove ${tag}`}><X className="h-3 w-3" /></button>
            </Badge>
          ))}
          <Input
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
            onBlur={addTag}
            placeholder="+ tag"
            className="h-6 w-20 text-xs border-dashed"
            data-testid="info-tag-input"
          />
        </div>
      </Card>
    </div>
  );
}
