// hooks/useProfileScope.ts — THE single, reactive source of truth for "which
// profile(s) is the app currently scoped to?".
//
// Why this exists
// ---------------
// The active-profile selection lives in client/src/lib/profileFilter.ts (a
// localStorage-backed module store, broadcast via a CustomEvent). That store was
// correct, but every page read it a DIFFERENT way:
//
//   - some subscribed reactively (subscribeProfileFilter) — correct
//   - some resynced only on the window `focus` DOM event — stale until refocus
//   - some read getProfileFilter() once per render with no subscription — stale
//     until an unrelated re-render
//   - tasks.tsx called setFilterEveryone() on mount — actively WIPED the
//     selection every time you navigated to it
//
// Those divergences are the root cause of "the app shows data from the wrong
// profile": the selection was fine, but individual features lost, ignored, or
// reset it. This hook collapses all of that into ONE reactive binding so every
// query, mutation, popup, chart and AI call observes the same active profile and
// re-renders the instant it changes — with no per-page subscription bookkeeping.
//
// Read scope:    const scope = useProfileScope();
// Query param:   profileScopeParam(scope)  -> "" | "?profileIds=a,b"
// Query key:     profileScopeKey("/api/x", scope)
// Create target: useActiveCreateProfileId(profiles) -> id a NEW record links to

import { useSyncExternalStore } from "react";
import {
  getProfileFilterSnapshot,
  subscribeProfileFilterRaw,
  type FilterMode,
} from "@/lib/profileFilter";
import { profileFilteredKey } from "@shared/query-keys";

export interface ProfileScope {
  /** "everyone" = no filter (all data) or "selected" = one+ profiles chosen. */
  mode: FilterMode;
  /** Profile IDs in the active selection (empty when mode === "everyone"). */
  selectedIds: string[];
  /** Display names parallel to selectedIds. */
  selectedNames: string[];
  /** Convenience: true when a real profile filter is active. */
  isFiltered: boolean;
}

/**
 * Subscribe to the active profile scope. Reactive and tear-free: the component
 * re-renders the moment the selection changes — whether the change came from
 * THIS page's filter chip, another page, or another browser tab.
 *
 * This is the ONLY approved way to read the active profile in a component.
 * Do not call getProfileFilter() in render and do not roll a bespoke `focus`
 * listener — those are exactly the stale-data patterns this replaces.
 */
export function useProfileScope(): ProfileScope {
  const snap = useSyncExternalStore(
    subscribeProfileFilterRaw,
    getProfileFilterSnapshot,
    getProfileFilterSnapshot, // SSR/initial: same snapshot (store is client-only)
  );
  return {
    mode: snap.mode,
    selectedIds: snap.selectedIds as string[],
    selectedNames: snap.selectedNames as string[],
    isFiltered: snap.mode === "selected" && snap.selectedIds.length > 0,
  };
}

/**
 * The `?profileIds=...` query-string fragment for the active scope, or "" when
 * unfiltered. Append directly to any list endpoint so the SERVER scopes the
 * response — the default react-query fetcher only uses queryKey[0] as the URL,
 * so the scope MUST be in the URL, not just the key.
 */
export function profileScopeParam(scope: Pick<ProfileScope, "selectedIds" | "mode">): string {
  if (scope.mode !== "selected" || scope.selectedIds.length === 0) return "";
  return `?profileIds=${scope.selectedIds.join(",")}`;
}

/**
 * Canonical react-query key for a profile-scoped endpoint. Delegates to the
 * shared profileFilteredKey so client and server agree and caches collapse to
 * one slot per (endpoint, selection).
 */
export function profileScopeKey(
  endpoint: string,
  scope: Pick<ProfileScope, "selectedIds">,
): readonly unknown[] {
  return profileFilteredKey(endpoint, scope.selectedIds);
}

interface ProfileLite {
  id: string;
  type?: string | null;
}

/**
 * The profile a NEWLY created record should be linked to so it lands inside the
 * profile the user is currently working in — instead of silently defaulting to
 * "me" (the long-standing bug where creating a task while "Jane" was selected
 * linked it to the self profile and it vanished from Jane's view).
 *
 * Rules, in order:
 *   1. Exactly one profile selected -> that profile (the unambiguous case).
 *   2. Several selected, self among them -> self (the natural primary owner).
 *   3. Several selected, no self -> the first selected (keeps the record in the
 *      active view rather than dropping it into an out-of-scope profile).
 *   4. Unfiltered ("everyone") -> the self profile (the household default).
 *
 * Returns "" when no suitable profile exists yet (profiles still loading).
 * Pure helper — takes the scope explicitly so it is unit-testable without React.
 */
export function resolveActiveCreateProfileId(
  profiles: ReadonlyArray<ProfileLite> | null | undefined,
  scope: Pick<ProfileScope, "selectedIds" | "mode">,
): string {
  const list = profiles || [];
  const selfId = list.find((p) => p?.type === "self")?.id || "";
  const selected = scope.mode === "selected" ? scope.selectedIds.filter(Boolean) : [];

  if (selected.length === 1) return selected[0];
  if (selected.length > 1) {
    const selfInSel = selfId && selected.includes(selfId) ? selfId : "";
    return selfInSel || selected[0];
  }
  return selfId;
}

/**
 * React hook form of resolveActiveCreateProfileId — reads the live scope so a
 * create dialog always pre-targets the profile currently in view.
 */
export function useActiveCreateProfileId(
  profiles: ReadonlyArray<ProfileLite> | null | undefined,
): string {
  const scope = useProfileScope();
  return resolveActiveCreateProfileId(profiles, scope);
}
