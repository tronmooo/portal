// ── Create Profile Dialog ────────────────────────────────────────────────────
// Extracted (2026-07-08) from pages/profiles.tsx so it survives the retirement
// of the profiles grid page. Reused by the Trackers page and the QuickCreateFab
// to create Person / Asset / Subscription / Loan / etc. profiles. Presentation +
// mutation only — no page chrome.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import ProfileTypeSelector from "@/components/registry/ProfileTypeSelector";
import type { TypeDefinition } from "@/components/registry/ProfileTypeSelector";
import DynamicProfileForm from "@/components/registry/DynamicProfileForm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import type { ProfileType, InsertProfile } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateDomains } from "@/lib/cache-bus";
import { isAssetTabProfile, isLiabilityTabProfile } from "@shared/asset-value";
import { useToast } from "@/hooks/use-toast";

function FieldRow({
  label,
  id,
  children,
}: {
  label: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

// ─── Helper: map registry category/type_key → legacy profile type ────────────

function mapTypeKeyToLegacyType(typeKey: string, category: string): ProfileType {
  // people category
  if (category === "people") {
    if (typeKey === "self") return "self" as ProfileType;
    if (typeKey === "pet") return "pet";
    return "person";
  }
  // "liability" is the canonical type post-Phase-1; the legacy "loan" alias is
  // only kept around for backward compatibility on un-migrated rows. New
  // creations must go in as "liability" so the dedicated liability profile
  // page renders, the rollups include them, and the type_key registry binding
  // works for the subtype badge.
  if (category === "liabilities") return "liability";
  if (category === "subscriptions") return "subscription";
  if (category === "investments") return "investment";
  if (category === "property") return "property" as ProfileType;
  // assets, insurance → asset
  return "asset";
}

export function CreateProfileDialog({
  open,
  onClose,
  initialCategoryFilter,
  titleOverride,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** If set, the type-picker only shows types in this category (e.g. "assets", "liabilities", "subscriptions"). */
  initialCategoryFilter?: string | string[];
  /** Optional override for the step-1 dialog title. */
  titleOverride?: string;
  /** Fired after a profile is successfully created — used to clear stale search etc. */
  onCreated?: (created: { id: string; name: string; type: string }) => void;
}) {
  const { toast } = useToast();
  // Step 1: pick a type; Step 2: fill details
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedTypeKey, setSelectedTypeKey] = useState<string | undefined>(undefined);
  const [selectedTypeDef, setSelectedTypeDef] = useState<TypeDefinition | null>(null);

  // Step-2 state
  const [name, setName] = useState("");
  const [fields, setFields] = useState<Record<string, any>>({});
  const [tagsInput, setTagsInput] = useState("");
  const [notes, setNotes] = useState("");
  const [dupWarning, setDupWarning] = useState<{ name: string; type: string; payload: any } | null>(null);

  const createMutation = useMutation({
    mutationFn: async (payload: InsertProfile & { type_key?: string; skipDupCheck?: boolean }) => {
      if (!payload.skipDupCheck) {
        // PERF: this used to `await GET /api/profiles` on every create — a full
        // profile scan on a serverless round-trip, strictly BEFORE the POST
        // could even start. That serial pair is most of the "the popup took a
        // while" delay. The profile list is already in the query cache (the
        // dashboard bootstrap seeds it, and this dialog is only reachable from
        // screens that render it), so read it from there and only fall back to
        // the network when the cache is genuinely empty.
        let existing = queryClient.getQueryData<any[]>(["/api/profiles"]);
        if (!Array.isArray(existing)) {
          existing = await apiRequest("GET", "/api/profiles").then(r => r.json()) as any[];
        }
        const dup = existing?.find((p: any) => p.name.toLowerCase() === payload.name.toLowerCase());
        if (dup) {
          setDupWarning({ name: dup.name, type: dup.type, payload });
          throw new Error("__DUP_CHECK__");
        }
      }
      const { skipDupCheck, ...rest } = payload;
      const res = await apiRequest("POST", "/api/profiles", rest);
      return res.json();
    },
    onSuccess: (created: any) => {
      // OPTIMISTIC INSERT (§4/§5/§21): put the created row into the shared
      // profile list synchronously so every screen reading `["/api/profiles"]`
      // — Assets, Liabilities, the owner's profile, the net-worth strip —
      // renders it on this tick, without waiting for the refetch below.
      // The server response IS the row, so there is nothing to roll back: this
      // is a confirmed write, not a guess. (A guessed pre-flight insert would
      // need rollback; we deliberately don't do that here because the server
      // assigns the id every downstream link is keyed by.)
      if (created?.id) {
        queryClient.setQueryData<any[]>(["/api/profiles"], (old) =>
          Array.isArray(old)
            ? (old.some((p) => p.id === created.id) ? old : [...old, created])
            : old,
        );
      }
      // PROPAGATION (§4/§5): the previous two-key invalidation
      // (["/api/profiles"] + ["/api/stats"]) left dashboard-enhanced, the
      // relationship lists, cash flow, obligations, the calendar timeline and
      // the bootstrap aggregates all serving pre-create data — which is why a
      // new asset needed a manual browser refresh to appear everywhere. Route
      // it through the bus, which knows the full ripple for each domain, and
      // declare the domains this specific profile type actually touches.
      const domains: Parameters<typeof invalidateDomains> = ["profiles", "dashboard"];
      if (isAssetTabProfile(created)) domains.push("assets");
      if (isLiabilityTabProfile(created)) {
        // A liability also drives bills, the payment calendar and cash flow.
        domains.push("liabilities", "obligations", "events");
      }
      void invalidateDomains(...domains);
      toast({ title: `"${name}" profile created`, description: selectedTypeDef?.label || selectedTypeKey });
      try { onCreated?.({ id: created?.id, name: created?.name || name, type: created?.type || "" }); } catch {}
      handleClose();
    },
    onError: (err: Error) => {
      if (err.message === "__DUP_CHECK__") return;
      toast({
        title: "Failed to create profile",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const handleClose = () => {
    setStep(1);
    setSelectedTypeKey(undefined);
    setSelectedTypeDef(null);
    setName("");
    setFields({});
    setTagsInput("");
    setNotes("");
    onClose();
  };

  const handleTypeSelect = (typeKey: string, typeDef: TypeDefinition) => {
    setSelectedTypeKey(typeKey);
    setSelectedTypeDef(typeDef);
  };

  const handleNext = () => {
    if (!selectedTypeKey || !selectedTypeDef) {
      toast({ title: "Please select a profile type", variant: "destructive" });
      return;
    }
    setStep(2);
  };

  const handleBack = () => {
    setStep(1);
    setName("");
    setFields({});
    setTagsInput("");
    setNotes("");
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    if (!selectedTypeDef) {
      toast({ title: "Profile type is required", variant: "destructive" });
      return;
    }
    const tags = tagsInput
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const cleanFields = Object.fromEntries(
      Object.entries(fields).filter(([_, v]) => v !== "" && v !== null && v !== undefined)
    );
    const legacyType = mapTypeKeyToLegacyType(selectedTypeDef.type_key, selectedTypeDef.category);
    createMutation.mutate({
      type: legacyType,
      // @ts-ignore — type_key is stored as extra field on the profile
      type_key: selectedTypeDef.type_key,
      name: name.trim(),
      fields: cleanFields,
      tags,
      notes,
    });
  };

  return (
    <>
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent
        className="max-w-lg max-h-[90vh] flex flex-col p-0"
        data-testid="dialog-create-profile"
      >
        <DialogHeader className="px-6 pt-6 pb-2 shrink-0">
          <DialogTitle>
            {step === 1 ? (titleOverride || "Choose Profile Type") : "Create Profile"}
          </DialogTitle>
          {step === 2 && selectedTypeDef && (
            <p className="text-sm text-muted-foreground">{selectedTypeDef.label}</p>
          )}
        </DialogHeader>

        {step === 1 ? (
          <>
            <div className="flex-1 overflow-y-auto px-6 py-4" style={{ WebkitOverflowScrolling: "touch" }}>
              <ProfileTypeSelector
                onSelect={handleTypeSelect}
                selectedKey={selectedTypeKey}
                categoryFilter={initialCategoryFilter}
              />
            </div>
            <DialogFooter className="px-6 py-3 border-t shrink-0">
              <Button
                type="button"
                variant="outline"
                onClick={handleClose}
                data-testid="btn-cancel-create-profile"
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleNext}
                disabled={!selectedTypeKey}
                data-testid="btn-next-create-profile"
              >
                Next
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
            <div className="flex-1 overflow-y-auto px-6 space-y-4 pb-4" style={{ WebkitOverflowScrolling: "touch" }}>
              {/* Name */}
              <FieldRow label="Name *" id="profile-name">
                <Input
                  id="profile-name"
                  data-testid="input-profile-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Enter name"
                  autoFocus
                />
              </FieldRow>

              {/* Dynamic fields from schema */}
              {selectedTypeDef && selectedTypeDef.field_schema && selectedTypeDef.field_schema.length > 0 && (
                <div className="border-t pt-3">
                  <p className="micro-label text-muted-foreground mb-3">
                    {selectedTypeDef.label} Details
                  </p>
                  <DynamicProfileForm
                    fieldSchema={selectedTypeDef.field_schema}
                    values={fields}
                    onChange={setFields}
                    disabled={createMutation.isPending}
                  />
                </div>
              )}

              {/* Tags */}
              <div className="border-t pt-3 space-y-3">
                <FieldRow label="Tags" id="profile-tags">
                  <Input
                    id="profile-tags"
                    data-testid="input-profile-tags"
                    value={tagsInput}
                    onChange={(e) => setTagsInput(e.target.value)}
                    placeholder="family, important, review (comma-separated)"
                  />
                </FieldRow>

                {/* Notes */}
                <FieldRow label="Notes" id="profile-notes">
                  <Textarea
                    id="profile-notes"
                    data-testid="textarea-profile-notes"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Any additional notes..."
                    rows={3}
                  />
                </FieldRow>
              </div>
            </div>

            <DialogFooter className="px-6 py-3 border-t shrink-0">
              <Button
                type="button"
                variant="outline"
                onClick={handleBack}
                data-testid="btn-back-create-profile"
                disabled={createMutation.isPending}
              >
                Back
              </Button>
              <Button
                type="submit"
                data-testid="btn-submit-create-profile"
                disabled={createMutation.isPending}
              >
                {createMutation.isPending ? "Creating…" : "Create Profile"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>

    {/* Duplicate profile warning */}
    <AlertDialog open={!!dupWarning} onOpenChange={(open) => { if (!open) setDupWarning(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Duplicate Profile</AlertDialogTitle>
          <AlertDialogDescription>
            A profile named "{dupWarning?.name}" already exists ({dupWarning?.type}). Create another?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => { if (dupWarning?.payload) { createMutation.mutate({ ...dupWarning.payload, skipDupCheck: true }); } setDupWarning(null); }}>
            Create Anyway
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
