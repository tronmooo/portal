-- 20260903_shared_tracker_cascade.sql
--
-- D250: deleting a person deleted every tracker she SHARED with Self — a
-- family steps tracker linked to Self and Kim vanished with all of Self's
-- entries when Kim's profile was removed — while shared habits, tasks,
-- expenses and documents were merely unlinked. The cascade was written when
-- "there was no shared-tracker concept"; there is one now.
--
-- Re-creates delete_profile_cascade as deployed (the self-owner guard, no
-- obligations table, chat_artifacts, entity/ownership links) with ONLY the
-- tracker section changed: sole-owner trackers are deleted entirely (entries
-- first); co-owned trackers lose this profile from linked_profiles and the
-- entries logged for it. Everything else is unchanged.

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
  SELECT type INTO v_type
    FROM profiles
   WHERE id = p_profile_id AND user_id = p_user_id;

  IF v_type = 'self' THEN
    RAISE EXCEPTION 'primary account owner profile % cannot be deleted', p_profile_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── Trackers (D250) ──────────────────────────────────────────────────────
  -- Sole-owner trackers go entirely (entries first); co-owned trackers keep
  -- the other owners' data and lose only this profile and its entries.
  DELETE FROM tracker_entries te
  USING trackers t
  WHERE te.tracker_id = t.id
    AND te.user_id = p_user_id
    AND t.user_id = p_user_id
    AND t.linked_profiles @> jsonb_build_array(v_pid)
    AND jsonb_array_length(t.linked_profiles) <= 1;

  DELETE FROM trackers
  WHERE user_id = p_user_id
    AND linked_profiles @> jsonb_build_array(v_pid)
    AND jsonb_array_length(linked_profiles) <= 1;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('trackers_deleted', v_n);

  UPDATE trackers
  SET linked_profiles = (
        SELECT coalesce(jsonb_agg(elem), '[]'::jsonb)
        FROM jsonb_array_elements(linked_profiles) elem
        WHERE elem <> v_member)
  WHERE user_id = p_user_id
    AND linked_profiles @> jsonb_build_array(v_pid);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('trackers_unlinked', v_n);

  -- Entries logged for this profile on any tracker (shared ones included).
  -- NB: tracker_entries.profile_id is TEXT.
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
