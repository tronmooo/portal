import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

// PERF regression guard (mileage-save fix). The ~30s "adding mileage does
// nothing" symptom was an ordinary profile field edit forcing a foreground
// AI-summary regeneration. These source-level assertions pin the fix on the
// (very large) profile-detail component, where a full render test is
// impractical:
//   1. Ordinary field edits (GroupedInlineField.save, delete paths) must NOT
//      invalidate the ai-summary query — only the explicit "Look up value" AI
//      action may, so exactly ONE such invalidation remains in the file.
//   2. save() must optimistically write the edited value into the profile
//      detail cache (instant UI) and roll back on error.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  resolve(__dirname, "../client/src/pages/profile-detail.tsx"),
  "utf8",
);

const AI_SUMMARY_INVALIDATION =
  /invalidateQueries\(\{\s*queryKey:\s*\["\/api\/profiles",\s*profileId,\s*"ai-summary"\]\s*\}\)/g;

// The codebase consolidates profile cache-busting behind `invalidateDomains(...)`
// (client/src/lib/cache-bus.ts). The "profiles" domain's predicate matches the
// `["/api/profiles", id, "ai-summary"]` key and refetches it with
// refetchType:"active" — i.e. calling `invalidateDomains("profiles")` DOES force
// an AI-summary regeneration. So "does this path regenerate the summary?" means
// "does it either invalidate the ai-summary key directly OR call invalidateDomains
// with the profiles domain?".
const REFRESHES_SUMMARY = /invalidateDomains\(\s*(?:"[^"]*",\s*)*"profiles"|invalidateQueries\(\{\s*queryKey:\s*\["\/api\/profiles",\s*profileId,\s*"ai-summary"\]/;

function sliceFn(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  expect(start, `marker not found: ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf(endMarker, start + startMarker.length);
  expect(end, `end marker not found after ${startMarker}: ${endMarker}`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("profile-detail — field edits do not auto-regenerate the AI summary", () => {
  it("the explicit Look up value action still refreshes the summary", () => {
    // The explicit AI valuation action may regenerate the summary (it just
    // produced a new value that should flow into the narrative). It does so via
    // invalidateDomains("profiles").
    const lookup = sliceFn(SRC, "const handleLookupValue = useCallback", "const headerActions");
    expect(REFRESHES_SUMMARY.test(lookup)).toBe(true);
  });

  it("GroupedInlineField.save does not refresh the AI summary", () => {
    // A plain field edit must not force a summary regeneration — neither the
    // direct ai-summary invalidation nor invalidateDomains("profiles").
    const save = sliceFn(SRC, "const save = async () => {", "const findValue = async");
    expect((save.match(AI_SUMMARY_INVALIDATION) || []).length).toBe(0);
    expect(REFRESHES_SUMMARY.test(save)).toBe(false);
  });

  it("does not re-add a profileUpdatedAt effect that invalidates the summary", () => {
    // The removed effect keyed a summary invalidation off profileUpdatedAt >
    // summaryGeneratedAt. Guard against it creeping back.
    const badEffect =
      /useEffect\([\s\S]{0,400}profileUpdatedAt[\s\S]{0,400}"ai-summary"/;
    expect(badEffect.test(SRC)).toBe(false);
  });
});

describe("profile-detail — save() is optimistic with rollback", () => {
  const save = sliceFn(SRC, "const save = async () => {", "const findValue = async");

  it("optimistically writes the edited field into the detail cache", () => {
    expect(save).toContain('setQueryData(["/api/profiles", profileId, "detail"]');
    expect(save).toMatch(/\[fieldKey\]:\s*draft/);
  });

  it("snapshots previous cache and rolls back on error", () => {
    expect(save).toMatch(/getQueryData\(\["\/api\/profiles",\s*profileId,\s*"detail"\]\)/);
    expect(save).toContain("catch");
    expect(save).toMatch(/setQueryData\(\["\/api\/profiles",\s*profileId,\s*"detail"\],\s*prev\)/);
  });

  it("does not eagerly refetch stats / dashboard-enhanced on a field edit", () => {
    // They are marked stale only (refetchType: "none") so the profile page save
    // can't cold-start those heavy aggregations.
    expect(save).toMatch(/dashboard-enhanced"\]\s*,\s*refetchType:\s*"none"/);
    expect(save).toMatch(/stats"\]\s*,\s*refetchType:\s*"none"/);
  });
});
