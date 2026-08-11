-- ============================================================
-- 20260811_delete_profile_cascade_v3.sql
--
-- Recreates delete_profile_cascade() — the atomic cascade
-- server/supabase-storage.ts:deleteProfile prefers over its legacy
-- read-then-write loop — with two changes and one correction of record.
--
-- 1. CHAT ARTIFACTS. `chat_artifacts.profile_id` is a bare text column with
--    no foreign key, and no version of this function has ever touched it. A
--    deleted person left their saved charts and tables behind, pointing at an
--    id that resolves to nothing. That is exactly the "orphaned records after
--    deleting a profile" class this function exists to prevent.
--
-- 2. PRIMARY OWNER GUARD. The profile with type 'self' is the account owner:
--    it is the root of the profile tree, the default parent of every ownerless
--    asset, and the fallback the client's profile filter falls back TO. There
--    is no UI to recreate it. The API refuses to delete it
--    (server/routes.ts) and so does the storage layer
--    (shared/profile-protection.ts) — this raise is the last one, so no
--    caller can route around the rule by invoking the RPC directly.
--
-- 3. CORRECTION OF RECORD. `20260701_delete_profile_cascade_drop_obligations.sql`
--    described its change in prose and left the canonical body "in the
--    Supabase migration history", so the repo has not held a runnable
--    definition of this function since. This file restores that: what follows
--    is the complete current body, obligations already removed.
--
-- Semantics are otherwise UNCHANGED from the deployed version:
--   * trackers linked to the profile are deleted entirely (entries first);
--   * multi-owner tables delete a row only when this profile is its SOLE
--     owner, and otherwise just strip the id out of linked_profiles;
--   * incomes soft-delete (deleted_at) rather than hard delete;
--   * child profiles are NOT handled here — the caller recurses first.
--
-- Column-type note: linked_profiles is JSONB on expenses / tasks / habits /
-- events / documents / artifacts / goals / trackers, but a Postgres text[] on
-- incomes and journal_entries. Both shapes appear below, deliberately.
--
-- Idempotent: CREATE OR REPLACE, safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.delete_profile_cascade(p_user_id uuid, p_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pid    text  := p_profile_id::text;
  v_member jsonb := to_jsonb(p_profile_id::text);
  v_counts jsonb := '{}'::jsonb;
  v_n      bigint;
  v_type   text;
BEGIN
  -- The primary account owner is not deletable. Raise rather than return a
  -- count: a silent no-op would let the caller report success for a profile
  -- that is still there.
  SELECT type INTO v_type
    FROM profiles
   WHERE id = p_profile_id AND user_id = p_user_id;

  IF v_type = 'self' THEN
    RAISE EXCEPTION 'primary account owner profile % cannot be deleted', p_profile_id
      USING ERRCODE = 'check_violation';
  END IF;

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

  DELETE FROM tracker_entries
  WHERE user_id = p_user_id AND profile_id = v_pid;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('tracker_entries_deleted', v_n);

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

  -- Obligations retired (2026-07): tables dropped; recurring bills are liability
  -- profiles now and are deleted through the normal profiles path below.

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

  -- Chat artifacts (charts / tables saved from a conversation). profile_id is
  -- plain text with no FK, so nothing else cleans these up.
  DELETE FROM chat_artifacts
  WHERE user_id = p_user_id AND profile_id = v_pid;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('chat_artifacts_deleted', v_n);

  DELETE FROM entity_links
  WHERE user_id = p_user_id
    AND ((source_type = 'profile' AND source_id = v_pid)
      OR (target_type = 'profile' AND target_id = v_pid));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('entity_links_deleted', v_n);

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

  DELETE FROM profiles
  WHERE user_id = p_user_id AND id = p_profile_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('profile_deleted', v_n > 0);

  RETURN v_counts;
END;
$function$;
