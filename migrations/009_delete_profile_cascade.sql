-- Migration 009: Atomic delete-profile cascade
--
-- [P0.1] deleteProfile() in server/supabase-storage.ts was a non-transactional
-- read-then-loop cascade: it read every entity table into memory, then issued
-- one UPDATE/DELETE per row. A concurrent write between the read and the
-- per-row write was silently lost, and a crash mid-loop left half-cascaded
-- orphans. This function performs the entire cascade in ONE transaction
-- (every Postgres function call is atomic).
--
-- Semantics deliberately MIRROR the legacy TS cascade exactly:
--   * trackers: any tracker linked to the profile is hard-deleted entirely
--     (including ALL its entries) — there is no shared-tracker concept.
--     Orphan tracker_entries carrying profile_id are deleted too.
--   * expenses / tasks / habits / obligations / events / documents /
--     artifacts / goals / journal_entries: sole owner → hard DELETE the row;
--     co-owned → strip just this profile id from linked_profiles.
--   * incomes: sole owner → SOFT delete (deleted_at = now()); co-owned → strip.
--   * Soft-delete visibility matches the TS getters the loop used:
--     expenses/tasks/habits/documents/incomes only consider rows with
--     deleted_at IS NULL; trackers/obligations/events/artifacts/goals/
--     journal_entries have no such filter.
--   * Link cleanup: entity_links (profile as source or target),
--     asset_party_links, liability_profile_links, liability_asset_links.
--   * Finally hard-deletes the profile row itself.
--
-- Child profiles are still cascaded recursively by the CALLER (deleteProfile
-- recurses over parent_profile_id children in TS before invoking this
-- function), so this function intentionally handles a single profile.
--
-- Column-type note: linked_profiles is JSONB on expenses/tasks/habits/
-- obligations/events/documents/artifacts/goals/trackers but a PG text[] ARRAY
-- on incomes/journal_entries — the removal expressions differ accordingly.
--
-- IDEMPOTENT: safe to re-run (CREATE OR REPLACE).

CREATE OR REPLACE FUNCTION public.delete_profile_cascade(p_user_id uuid, p_profile_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pid    text  := p_profile_id::text;        -- JSONB/text[] element form
  v_member jsonb := to_jsonb(p_profile_id::text); -- single JSONB element
  v_counts jsonb := '{}'::jsonb;
  v_n      bigint;
BEGIN
  -- ── 1. Trackers: hard-delete every linked tracker + ALL its entries ──────
  DELETE FROM tracker_entries te
  USING trackers t
  WHERE te.tracker_id = t.id
    AND te.user_id = p_user_id
    AND t.user_id = p_user_id
    AND t.linked_profiles @> jsonb_build_array(v_pid);

  DELETE FROM trackers
  WHERE user_id = p_user_id
    AND linked_profiles @> jsonb_build_array(v_pid);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('trackers_deleted', v_n);

  -- Orphan entries logged directly against the profile on other trackers.
  -- NB: tracker_entries.profile_id is TEXT (verified live 2026-06-10).
  DELETE FROM tracker_entries
  WHERE user_id = p_user_id AND profile_id = v_pid;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('tracker_entries_deleted', v_n);

  -- ── 2. Expenses (live rows; sole owner → delete, co-owned → strip) ───────
  DELETE FROM expenses
  WHERE user_id = p_user_id AND deleted_at IS NULL
    AND linked_profiles @> jsonb_build_array(v_pid)
    AND jsonb_array_length(linked_profiles) <= 1;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('expenses_deleted', v_n);

  UPDATE expenses
  SET linked_profiles = (
        SELECT coalesce(jsonb_agg(elem), '[]'::jsonb)
        FROM jsonb_array_elements(linked_profiles) elem
        WHERE elem <> v_member)
  WHERE user_id = p_user_id AND deleted_at IS NULL
    AND linked_profiles @> jsonb_build_array(v_pid);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('expenses_unlinked', v_n);

  -- ── 3. Tasks ──────────────────────────────────────────────────────────────
  DELETE FROM tasks
  WHERE user_id = p_user_id AND deleted_at IS NULL
    AND linked_profiles @> jsonb_build_array(v_pid)
    AND jsonb_array_length(linked_profiles) <= 1;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('tasks_deleted', v_n);

  UPDATE tasks
  SET linked_profiles = (
        SELECT coalesce(jsonb_agg(elem), '[]'::jsonb)
        FROM jsonb_array_elements(linked_profiles) elem
        WHERE elem <> v_member)
  WHERE user_id = p_user_id AND deleted_at IS NULL
    AND linked_profiles @> jsonb_build_array(v_pid);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('tasks_unlinked', v_n);

  -- ── 4. Habits (+ check-ins for sole-owned habits) ─────────────────────────
  DELETE FROM habit_checkins hc
  USING habits h
  WHERE hc.habit_id = h.id
    AND hc.user_id = p_user_id
    AND h.user_id = p_user_id AND h.deleted_at IS NULL
    AND h.linked_profiles @> jsonb_build_array(v_pid)
    AND jsonb_array_length(h.linked_profiles) <= 1;

  DELETE FROM habits
  WHERE user_id = p_user_id AND deleted_at IS NULL
    AND linked_profiles @> jsonb_build_array(v_pid)
    AND jsonb_array_length(linked_profiles) <= 1;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('habits_deleted', v_n);

  UPDATE habits
  SET linked_profiles = (
        SELECT coalesce(jsonb_agg(elem), '[]'::jsonb)
        FROM jsonb_array_elements(linked_profiles) elem
        WHERE elem <> v_member)
  WHERE user_id = p_user_id AND deleted_at IS NULL
    AND linked_profiles @> jsonb_build_array(v_pid);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('habits_unlinked', v_n);

  -- ── 5. Obligations ────────────────────────────────────────────────────────
  -- Belt-and-suspenders: clear occurrences for sole-owned obligations first
  -- (obligation_payments has ON DELETE CASCADE; occurrences may not).
  IF to_regclass('public.obligation_occurrences') IS NOT NULL THEN
    DELETE FROM obligation_occurrences oo
    USING obligations o
    WHERE oo.obligation_id = o.id
      AND oo.user_id = p_user_id
      AND o.user_id = p_user_id
      AND o.linked_profiles @> jsonb_build_array(v_pid)
      AND jsonb_array_length(o.linked_profiles) <= 1;
  END IF;

  DELETE FROM obligations
  WHERE user_id = p_user_id
    AND linked_profiles @> jsonb_build_array(v_pid)
    AND jsonb_array_length(linked_profiles) <= 1;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('obligations_deleted', v_n);

  UPDATE obligations
  SET linked_profiles = (
        SELECT coalesce(jsonb_agg(elem), '[]'::jsonb)
        FROM jsonb_array_elements(linked_profiles) elem
        WHERE elem <> v_member)
  WHERE user_id = p_user_id
    AND linked_profiles @> jsonb_build_array(v_pid);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('obligations_unlinked', v_n);

  -- ── 6. Events (profile cascade hard-deletes deliberately, matching the
  --       legacy loop; user-facing deleteEvent() soft-deletes) ───────────────
  DELETE FROM events
  WHERE user_id = p_user_id
    AND linked_profiles @> jsonb_build_array(v_pid)
    AND jsonb_array_length(linked_profiles) <= 1;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('events_deleted', v_n);

  UPDATE events
  SET linked_profiles = (
        SELECT coalesce(jsonb_agg(elem), '[]'::jsonb)
        FROM jsonb_array_elements(linked_profiles) elem
        WHERE elem <> v_member)
  WHERE user_id = p_user_id
    AND linked_profiles @> jsonb_build_array(v_pid);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('events_unlinked', v_n);

  -- ── 7. Documents (live rows; row delete only — Storage blob cleanup is the
  --       app's concern, exactly like the legacy loop) ───────────────────────
  DELETE FROM documents
  WHERE user_id = p_user_id AND deleted_at IS NULL
    AND linked_profiles @> jsonb_build_array(v_pid)
    AND jsonb_array_length(linked_profiles) <= 1;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('documents_deleted', v_n);

  UPDATE documents
  SET linked_profiles = (
        SELECT coalesce(jsonb_agg(elem), '[]'::jsonb)
        FROM jsonb_array_elements(linked_profiles) elem
        WHERE elem <> v_member)
  WHERE user_id = p_user_id AND deleted_at IS NULL
    AND linked_profiles @> jsonb_build_array(v_pid);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('documents_unlinked', v_n);

  -- ── 8. Artifacts ──────────────────────────────────────────────────────────
  DELETE FROM artifacts
  WHERE user_id = p_user_id
    AND linked_profiles @> jsonb_build_array(v_pid)
    AND jsonb_array_length(linked_profiles) <= 1;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('artifacts_deleted', v_n);

  UPDATE artifacts
  SET linked_profiles = (
        SELECT coalesce(jsonb_agg(elem), '[]'::jsonb)
        FROM jsonb_array_elements(linked_profiles) elem
        WHERE elem <> v_member)
  WHERE user_id = p_user_id
    AND linked_profiles @> jsonb_build_array(v_pid);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('artifacts_unlinked', v_n);

  -- ── 9. Goals ──────────────────────────────────────────────────────────────
  DELETE FROM goals
  WHERE user_id = p_user_id
    AND linked_profiles @> jsonb_build_array(v_pid)
    AND jsonb_array_length(linked_profiles) <= 1;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('goals_deleted', v_n);

  UPDATE goals
  SET linked_profiles = (
        SELECT coalesce(jsonb_agg(elem), '[]'::jsonb)
        FROM jsonb_array_elements(linked_profiles) elem
        WHERE elem <> v_member)
  WHERE user_id = p_user_id
    AND linked_profiles @> jsonb_build_array(v_pid);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('goals_unlinked', v_n);

  -- ── 9b. Incomes (text[] column; sole owner → SOFT delete) ────────────────
  UPDATE incomes
  SET deleted_at = now()
  WHERE user_id = p_user_id AND deleted_at IS NULL
    AND linked_profiles @> array[v_pid]
    AND coalesce(array_length(linked_profiles, 1), 0) <= 1;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('incomes_soft_deleted', v_n);

  UPDATE incomes
  SET linked_profiles = array_remove(linked_profiles, v_pid)
  WHERE user_id = p_user_id AND deleted_at IS NULL
    AND linked_profiles @> array[v_pid];
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('incomes_unlinked', v_n);

  -- ── 10. Journal entries (text[] column) ──────────────────────────────────
  DELETE FROM journal_entries
  WHERE user_id = p_user_id
    AND linked_profiles @> array[v_pid]
    AND coalesce(array_length(linked_profiles, 1), 0) <= 1;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('journal_deleted', v_n);

  UPDATE journal_entries
  SET linked_profiles = array_remove(linked_profiles, v_pid)
  WHERE user_id = p_user_id
    AND linked_profiles @> array[v_pid];
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('journal_unlinked', v_n);

  -- ── 11. entity_links graph rows (source_id/target_id are TEXT) ───────────
  DELETE FROM entity_links
  WHERE user_id = p_user_id
    AND ((source_type = 'profile' AND source_id = v_pid)
      OR (target_type = 'profile' AND target_id = v_pid));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('entity_links_deleted', v_n);

  -- ── 12. Asset/Liability ownership + collateral link rows ─────────────────
  DELETE FROM asset_party_links
  WHERE user_id = p_user_id
    AND (asset_profile_id = p_profile_id OR party_profile_id = p_profile_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('asset_party_links_deleted', v_n);

  DELETE FROM liability_profile_links
  WHERE user_id = p_user_id
    AND (liability_profile_id = p_profile_id OR party_profile_id = p_profile_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('liability_profile_links_deleted', v_n);

  DELETE FROM liability_asset_links
  WHERE user_id = p_user_id
    AND (liability_profile_id = p_profile_id OR asset_profile_id = p_profile_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('liability_asset_links_deleted', v_n);

  -- ── 13. The profile row itself ────────────────────────────────────────────
  DELETE FROM profiles
  WHERE user_id = p_user_id AND id = p_profile_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('profile_deleted', v_n > 0);

  RETURN v_counts;
END;
$$;

-- SECURITY DEFINER + caller-supplied p_user_id means this MUST only be
-- callable by the server (service role). Never grant to authenticated —
-- a user could pass another user's id and delete their data.
REVOKE ALL ON FUNCTION public.delete_profile_cascade(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_profile_cascade(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.delete_profile_cascade(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.delete_profile_cascade(uuid, uuid) TO service_role;
