-- @@section sequences

-- @@section functions
CREATE OR REPLACE FUNCTION public.auth_rate_limit_hit(p_key text, p_max integer, p_window_ms integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO public.auth_rate_limits AS r (key, count, reset_at)
  VALUES (p_key, 1, now() + make_interval(secs => p_window_ms / 1000.0))
  ON CONFLICT (key) DO UPDATE
    SET count    = CASE WHEN r.reset_at <= now() THEN 1 ELSE r.count + 1 END,
        reset_at = CASE WHEN r.reset_at <= now() THEN EXCLUDED.reset_at ELSE r.reset_at END
  RETURNING r.count INTO v_count;

  IF random() < 0.02 THEN
    DELETE FROM public.auth_rate_limits WHERE reset_at < now() - interval '1 hour';
  END IF;

  RETURN v_count > p_max;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.bump_user_data_version(p_user_id uuid)
 RETURNS bigint
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  INSERT INTO public.user_data_versions (user_id, version, updated_at)
  VALUES (p_user_id, 1, now())
  ON CONFLICT (user_id)
  DO UPDATE SET version = public.user_data_versions.version + 1, updated_at = now()
  RETURNING version;
$function$
;

CREATE OR REPLACE FUNCTION public.bump_user_domain_versions(p_user_id uuid, p_domains text[])
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  INSERT INTO public.user_data_versions (user_id, version, domains, updated_at)
  VALUES (
    p_user_id,
    1,
    COALESCE((SELECT jsonb_object_agg(d, 1) FROM unnest(p_domains) AS d), '{}'::jsonb),
    now()
  )
  ON CONFLICT (user_id) DO UPDATE
    SET
      version = public.user_data_versions.version
                + CASE WHEN COALESCE(array_length(p_domains, 1), 0) = 0 THEN 1 ELSE 0 END,
      domains = COALESCE(
        (
          SELECT jsonb_object_agg(k, v)
          FROM (
            SELECT k, MAX(v) AS v
            FROM (
              SELECT key AS k, (value #>> '{}')::bigint AS v
                FROM jsonb_each(public.user_data_versions.domains)
              UNION ALL
              SELECT d AS k,
                     COALESCE((public.user_data_versions.domains ->> d)::bigint, 0) + 1 AS v
                FROM unnest(p_domains) AS d
            ) merged
            GROUP BY k
          ) agg
        ),
        '{}'::jsonb
      ),
      updated_at = now()
  RETURNING jsonb_build_object('epoch', version) || domains;
$function$
;

CREATE OR REPLACE FUNCTION public.captures_set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

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

  -- Trackers (D250): sole-owner trackers go entirely (entries first);
  -- co-owned trackers keep the other owners' data and lose only this
  -- profile and the entries logged for it.
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
$function$
;

CREATE OR REPLACE FUNCTION public.enforce_linked_profiles_ownership()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  new_links  jsonb;
  old_links  jsonb;
  elem       jsonb;
  pid_text   text;
  pid        uuid;
  row_owner  uuid;
  prof_owner uuid;
  prof_gone  timestamptz;
  is_new     boolean;
BEGIN
  new_links := to_jsonb(NEW) -> 'linked_profiles';
  IF new_links IS NULL OR jsonb_typeof(new_links) <> 'array' OR jsonb_array_length(new_links) = 0 THEN
    RETURN NEW;
  END IF;

  row_owner := NULLIF(to_jsonb(NEW) ->> 'user_id', '')::uuid;
  IF row_owner IS NULL THEN
    RAISE EXCEPTION 'linked_profiles on %.% requires a non-null user_id',
      TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    old_links := to_jsonb(OLD) -> 'linked_profiles';
    IF old_links IS NULL OR jsonb_typeof(old_links) <> 'array' THEN
      old_links := '[]'::jsonb;
    END IF;
    IF new_links = old_links THEN
      RETURN NEW;
    END IF;
  ELSE
    old_links := '[]'::jsonb;
  END IF;

  FOR elem IN SELECT * FROM jsonb_array_elements(new_links)
  LOOP
    pid_text := elem #>> '{}';
    CONTINUE WHEN pid_text IS NULL OR btrim(pid_text) = '';
    BEGIN
      pid := pid_text::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'linked_profiles on %.% contains a non-UUID profile reference %',
        TG_TABLE_SCHEMA, TG_TABLE_NAME, pid_text USING ERRCODE = 'check_violation';
    END;

    is_new := NOT (old_links @> jsonb_build_array(to_jsonb(pid_text)));

    SELECT p.user_id, p.deleted_at INTO prof_owner, prof_gone
      FROM public.profiles p WHERE p.id = pid;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'linked_profiles on %.% references profile % which does not exist',
        TG_TABLE_SCHEMA, TG_TABLE_NAME, pid USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF prof_owner IS DISTINCT FROM row_owner THEN
      RAISE EXCEPTION 'cross-user profile association rejected on %.%: profile % belongs to another user',
        TG_TABLE_SCHEMA, TG_TABLE_NAME, pid USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF is_new AND prof_gone IS NOT NULL THEN
      RAISE EXCEPTION 'linked_profiles on %.% references profile % which is deleted',
        TG_TABLE_SCHEMA, TG_TABLE_NAME, pid USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.finance_touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.guard_asset_party_ownership_sum()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_total numeric;
BEGIN
  SELECT COALESCE(SUM(ownership_percentage),0) INTO v_total
  FROM asset_party_links
  WHERE asset_profile_id = NEW.asset_profile_id AND user_id = NEW.user_id
    AND lower(coalesce(role,'owner')) IN ('owner','co_owner','co-owner');
  IF v_total > 100.05 THEN
    RAISE EXCEPTION 'Ownership for asset % would total % percent (must not exceed 100)', NEW.asset_profile_id, v_total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $function$
;

CREATE OR REPLACE FUNCTION public.guard_liability_party_ownership_sum()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_total numeric;
BEGIN
  SELECT COALESCE(SUM(ownership_percentage),0) INTO v_total
  FROM liability_profile_links
  WHERE liability_profile_id = NEW.liability_profile_id AND user_id = NEW.user_id
    AND lower(coalesce(role,'owner')) IN ('owner','co_owner','co-owner');
  IF v_total > 100.05 THEN
    RAISE EXCEPTION 'Ownership for liability % would total % percent (must not exceed 100)', NEW.liability_profile_id, v_total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $function$
;

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$
;
-- @@section tables
CREATE TABLE public.ai_action_log (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  tool text NOT NULL,
  action_type text NOT NULL,
  entity_type text,
  entity_id text,
  entity_name text,
  input jsonb,
  before jsonb,
  after jsonb,
  reversible boolean DEFAULT false NOT NULL,
  reverse_plan jsonb,
  source text DEFAULT 'chat'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  undone_at timestamp with time zone,
  undone_by_log_id uuid,
  turn_id text,
  request_id text,
  operation_id text
);

CREATE TABLE public.ai_bulk_plans (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  operation text NOT NULL,
  criteria jsonb NOT NULL,
  plan_hash text NOT NULL,
  preview jsonb NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  affected jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  executed_at timestamp with time zone
);

CREATE TABLE public.ai_chat_runs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  request_id text NOT NULL,
  status text NOT NULL,
  turn_id text,
  message text,
  result jsonb,
  error text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.artifacts (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  content text DEFAULT ''::text,
  items jsonb DEFAULT '[]'::jsonb,
  tags jsonb DEFAULT '[]'::jsonb,
  linked_profiles jsonb DEFAULT '[]'::jsonb,
  pinned boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  metadata jsonb DEFAULT '{}'::jsonb,
  deleted_at timestamp with time zone
);

CREATE TABLE public.asset_party_links (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  asset_profile_id uuid NOT NULL,
  party_profile_id uuid NOT NULL,
  ownership_percentage numeric(6,3) DEFAULT 100,
  role text DEFAULT 'owner'::text NOT NULL,
  effective_from timestamp with time zone,
  effective_to timestamp with time zone,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.audit_log (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  entity_name text,
  details jsonb DEFAULT '{}'::jsonb,
  source text DEFAULT 'manual'::text,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.auth_rate_limits (
  key text NOT NULL,
  count integer NOT NULL,
  reset_at timestamp with time zone NOT NULL
);

CREATE TABLE public.captures (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  owner_profile_id uuid,
  type text DEFAULT 'unknown'::text NOT NULL,
  title text DEFAULT ''::text NOT NULL,
  raw_input text NOT NULL,
  structured_data jsonb DEFAULT '{}'::jsonb NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  relationships jsonb DEFAULT '[]'::jsonb NOT NULL,
  source text DEFAULT 'chat'::text NOT NULL,
  confidence numeric(4,3) DEFAULT 0.5 NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  projections jsonb DEFAULT '[]'::jsonb NOT NULL,
  clarifying_question text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.cashflow_projections (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  month text NOT NULL,
  week integer NOT NULL,
  projected_income numeric(12,2) DEFAULT 0,
  projected_expenses numeric(12,2) DEFAULT 0,
  actual_income numeric(12,2) DEFAULT 0,
  actual_expenses numeric(12,2) DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.chat_artifacts (
  id text NOT NULL,
  user_id uuid DEFAULT auth.uid() NOT NULL,
  profile_id text NOT NULL,
  conversation_id text,
  version integer DEFAULT 1 NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  data jsonb DEFAULT '{}'::jsonb NOT NULL,
  update_type text DEFAULT 'create'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.chat_idempotency (
  user_id text NOT NULL,
  idem_key text NOT NULL,
  status text NOT NULL,
  result jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.documents (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  type text DEFAULT 'other'::text,
  mime_type text DEFAULT 'image/jpeg'::text,
  file_data text,
  extracted_data jsonb DEFAULT '{}'::jsonb,
  linked_profiles jsonb DEFAULT '[]'::jsonb,
  tags jsonb DEFAULT '[]'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  storage_path text,
  deleted_at timestamp with time zone,
  expiration_date text,
  superseded_by uuid,
  source_confidence real DEFAULT 0,
  auto_committed boolean DEFAULT false
);

CREATE TABLE public.domain_entries (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  domain_id uuid NOT NULL,
  entry_values jsonb DEFAULT '{}'::jsonb,
  tags jsonb DEFAULT '[]'::jsonb,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.domains (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  slug text NOT NULL,
  icon text,
  color text,
  description text,
  fields jsonb DEFAULT '[]'::jsonb,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.entity_links (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  relationship text NOT NULL,
  confidence numeric DEFAULT 1,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.event_documents (
  event_id uuid NOT NULL,
  document_id uuid NOT NULL,
  user_id uuid NOT NULL
);

CREATE TABLE public.events (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  title text NOT NULL,
  date date NOT NULL,
  "time" text,
  end_time text,
  end_date date,
  all_day boolean DEFAULT false,
  description text,
  location text,
  category text DEFAULT 'personal'::text,
  color text,
  recurrence text DEFAULT 'none'::text,
  recurrence_end date,
  linked_profiles jsonb DEFAULT '[]'::jsonb,
  linked_documents jsonb DEFAULT '[]'::jsonb,
  tags jsonb DEFAULT '[]'::jsonb,
  source text DEFAULT 'manual'::text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  deleted_at timestamp with time zone
);

CREATE TABLE public.expenses (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  amount numeric NOT NULL,
  category text DEFAULT 'general'::text,
  description text NOT NULL,
  vendor text,
  is_recurring boolean DEFAULT false,
  linked_profiles jsonb DEFAULT '[]'::jsonb,
  tags jsonb DEFAULT '[]'::jsonb,
  date date,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  deleted_at timestamp with time zone,
  source text DEFAULT 'manual'::text,
  status text DEFAULT 'active'::text,
  payment_method text
);

CREATE TABLE public.extraction_corrections (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  document_id uuid,
  document_type text NOT NULL,
  field_key text NOT NULL,
  old_value text,
  new_value text,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.finance_imports (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  profile_id uuid,
  status text DEFAULT 'committed'::text NOT NULL,
  summary jsonb DEFAULT '{}'::jsonb NOT NULL,
  record_count integer DEFAULT 0 NOT NULL,
  created_records jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  undone_at timestamp with time zone
);

CREATE TABLE public.finance_sync_runs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  financial_connection_id uuid,
  sync_type text NOT NULL,
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  completed_at timestamp with time zone,
  status text DEFAULT 'running'::text NOT NULL,
  accounts_processed integer DEFAULT 0 NOT NULL,
  transactions_inserted integer DEFAULT 0 NOT NULL,
  transactions_updated integer DEFAULT 0 NOT NULL,
  error_code text,
  error_message text
);

CREATE TABLE public.finance_webhook_events (
  stripe_event_id text NOT NULL,
  event_type text NOT NULL,
  received_at timestamp with time zone DEFAULT now() NOT NULL,
  processed_at timestamp with time zone,
  status text DEFAULT 'received'::text NOT NULL,
  error_code text
);

CREATE TABLE public.financial_accounts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  financial_connection_id uuid,
  stripe_financial_connections_account_id text NOT NULL,
  institution_name text,
  account_name text,
  account_display_name text,
  account_category text,
  account_subcategory text,
  account_type text,
  last_four text,
  currency text DEFAULT 'usd'::text NOT NULL,
  current_balance bigint,
  available_balance bigint,
  balance_as_of timestamp with time zone,
  status text DEFAULT 'active'::text NOT NULL,
  is_hidden boolean DEFAULT false NOT NULL,
  include_in_net_worth boolean DEFAULT true NOT NULL,
  matched_profile_id uuid,
  permissions text[] DEFAULT '{}'::text[] NOT NULL,
  subscriptions text[] DEFAULT '{}'::text[] NOT NULL,
  last_transaction_refresh_id text,
  inactive_cause text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.financial_connections (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  stripe_account_holder_id text NOT NULL,
  stripe_session_id text,
  institution_name text,
  connection_status text DEFAULT 'connecting'::text NOT NULL,
  last_successful_sync_at timestamp with time zone,
  last_attempted_sync_at timestamp with time zone,
  last_sync_status text,
  last_sync_error text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  disconnected_at timestamp with time zone
);

CREATE TABLE public.financial_transaction_overrides (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  financial_transaction_id uuid NOT NULL,
  category text,
  subcategory text,
  merchant_name text,
  is_income boolean,
  is_expense boolean,
  is_transfer boolean,
  is_refund boolean,
  excluded_from_totals boolean,
  note text,
  linked_profile_id uuid,
  linked_subscription_profile_id uuid,
  linked_liability_profile_id uuid,
  linked_asset_profile_id uuid,
  budget_category text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.financial_transactions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  financial_account_id uuid NOT NULL,
  stripe_transaction_id text NOT NULL,
  transaction_date date NOT NULL,
  posted_at timestamp with time zone,
  description text,
  merchant_name text,
  amount bigint NOT NULL,
  currency text DEFAULT 'usd'::text NOT NULL,
  transaction_type text,
  status text DEFAULT 'posted'::text NOT NULL,
  category text,
  subcategory text,
  is_income boolean DEFAULT false NOT NULL,
  is_expense boolean DEFAULT false NOT NULL,
  is_transfer boolean DEFAULT false NOT NULL,
  is_refund boolean DEFAULT false NOT NULL,
  is_duplicate boolean DEFAULT false NOT NULL,
  excluded_from_totals boolean DEFAULT false NOT NULL,
  source text DEFAULT 'stripe_financial_connections'::text NOT NULL,
  raw_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.financial_transfer_links (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  transfer_group_id uuid DEFAULT gen_random_uuid() NOT NULL,
  outflow_transaction_id uuid NOT NULL,
  inflow_transaction_id uuid NOT NULL,
  confidence numeric(4,3) DEFAULT 0 NOT NULL,
  state text DEFAULT 'detected'::text NOT NULL,
  signals jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.goals (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  title text NOT NULL,
  type text NOT NULL,
  target numeric NOT NULL,
  current numeric DEFAULT 0,
  unit text NOT NULL,
  start_value numeric,
  deadline text,
  tracker_id uuid,
  habit_id uuid,
  category text,
  status text DEFAULT 'active'::text,
  milestones jsonb DEFAULT '[]'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  linked_profiles jsonb DEFAULT '[]'::jsonb,
  deleted_at timestamp with time zone
);

CREATE TABLE public.habit_checkins (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  habit_id uuid NOT NULL,
  date date NOT NULL,
  value numeric,
  notes text,
  "timestamp" timestamp with time zone DEFAULT now(),
  source text DEFAULT 'manual'::text,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.habits (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  icon text,
  color text,
  frequency text DEFAULT 'daily'::text,
  target_days jsonb DEFAULT '[]'::jsonb,
  current_streak integer DEFAULT 0,
  longest_streak integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  linked_profiles jsonb DEFAULT '[]'::jsonb,
  target_per_day integer DEFAULT 1,
  source text DEFAULT 'manual'::text,
  status text DEFAULT 'active'::text,
  deleted_at timestamp with time zone,
  time_of_day text,
  scheduled_time text,
  unit_label text,
  start_date text,
  end_date text,
  linked_tracker_id uuid,
  owner_profile_id uuid GENERATED ALWAYS AS (((linked_profiles ->> 0))::uuid) STORED
);

CREATE TABLE public.incomes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  description text NOT NULL,
  amount numeric NOT NULL,
  category text DEFAULT 'salary'::text,
  frequency text DEFAULT 'monthly'::text,
  date text,
  source text DEFAULT 'manual'::text,
  linked_profiles text[] DEFAULT '{}'::text[],
  tags text[] DEFAULT '{}'::text[],
  deleted_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.journal_entries (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  date date NOT NULL,
  mood text NOT NULL,
  content text DEFAULT ''::text,
  tags jsonb DEFAULT '[]'::jsonb,
  energy integer,
  gratitude jsonb DEFAULT '[]'::jsonb,
  highlights jsonb DEFAULT '[]'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  linked_profiles text[] DEFAULT ARRAY[]::text[],
  updated_at timestamp with time zone DEFAULT now(),
  deleted_at timestamp with time zone,
  title text
);

CREATE TABLE public.liability_asset_links (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  liability_profile_id uuid NOT NULL,
  asset_profile_id uuid NOT NULL,
  ownership_percentage numeric(6,3) DEFAULT 100,
  allocation_amount numeric(18,2),
  role text DEFAULT 'collateral'::text,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.liability_payments (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  liability_profile_id uuid NOT NULL,
  payment_date date NOT NULL,
  amount numeric(18,2) NOT NULL,
  principal_portion numeric(18,2) DEFAULT 0,
  interest_portion numeric(18,2) DEFAULT 0,
  fees numeric(18,2) DEFAULT 0,
  remaining_balance_after numeric(18,2),
  payment_type text DEFAULT 'standard'::text NOT NULL,
  source_account text,
  document_id uuid,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.liability_profile_links (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  liability_profile_id uuid NOT NULL,
  party_profile_id uuid NOT NULL,
  ownership_percentage numeric(6,3) DEFAULT 100,
  role text DEFAULT 'owner'::text NOT NULL,
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.loan_amortization (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  loan_id uuid NOT NULL,
  loan_name text NOT NULL,
  payment_number integer NOT NULL,
  payment_date date NOT NULL,
  principal_amount numeric(12,2) NOT NULL,
  interest_amount numeric(12,2) NOT NULL,
  total_payment numeric(12,2) NOT NULL,
  remaining_balance numeric(12,2) NOT NULL,
  paid boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.memories (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  key text NOT NULL,
  value text NOT NULL,
  category text DEFAULT 'general'::text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  deleted_at timestamp with time zone
);

CREATE TABLE public.net_worth_snapshots (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  profile_id uuid,
  snapshot_date date NOT NULL,
  assets_total numeric DEFAULT 0 NOT NULL,
  liabilities_total numeric DEFAULT 0 NOT NULL,
  net_worth numeric DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.ownership_history (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  link_kind text NOT NULL,
  link_id uuid,
  subject_id uuid,
  counterparty_id uuid,
  action text NOT NULL,
  field_changed text,
  old_value text,
  new_value text,
  changed_by text DEFAULT 'user'::text NOT NULL,
  note text,
  changed_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.paychecks (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  source text NOT NULL,
  amount numeric(12,2) NOT NULL,
  expected_date date NOT NULL,
  received_date date,
  confirmed boolean DEFAULT false,
  actual_amount numeric(12,2),
  notes text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.preferences (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  key text NOT NULL,
  value text
);

CREATE TABLE public.profile_type_definitions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  type_key text NOT NULL,
  label text NOT NULL,
  category text NOT NULL,
  description text DEFAULT ''::text,
  icon text DEFAULT 'Star'::text,
  field_schema jsonb DEFAULT '[]'::jsonb NOT NULL,
  tab_config jsonb DEFAULT '[]'::jsonb NOT NULL,
  default_parent_type text,
  is_system boolean DEFAULT true,
  sort_order integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.profiles (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  type text NOT NULL,
  name text NOT NULL,
  avatar text,
  fields jsonb DEFAULT '{}'::jsonb,
  tags jsonb DEFAULT '[]'::jsonb,
  notes text DEFAULT ''::text,
  documents jsonb DEFAULT '[]'::jsonb,
  linked_trackers jsonb DEFAULT '[]'::jsonb,
  linked_expenses jsonb DEFAULT '[]'::jsonb,
  linked_tasks jsonb DEFAULT '[]'::jsonb,
  linked_events jsonb DEFAULT '[]'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  parent_profile_id uuid,
  type_key text,
  deleted_at timestamp with time zone
);

CREATE TABLE public.response_cache (
  key text NOT NULL,
  user_id uuid NOT NULL,
  payload jsonb NOT NULL,
  expires_at timestamp with time zone NOT NULL
);

CREATE TABLE public.stripe_account_holders (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  stripe_customer_id text NOT NULL,
  livemode boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.tasks (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  status text DEFAULT 'todo'::text,
  priority text DEFAULT 'medium'::text,
  due_date date,
  linked_profiles jsonb DEFAULT '[]'::jsonb,
  tags jsonb DEFAULT '[]'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  deleted_at timestamp with time zone,
  source text DEFAULT 'manual'::text,
  due_time text
);

CREATE TABLE public.tracker_entries (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  tracker_id uuid NOT NULL,
  entry_values jsonb DEFAULT '{}'::jsonb,
  computed jsonb DEFAULT '{}'::jsonb,
  notes text,
  mood text,
  tags jsonb DEFAULT '[]'::jsonb,
  "timestamp" timestamp with time zone DEFAULT now(),
  for_profile text,
  updated_at timestamp with time zone DEFAULT now(),
  source text DEFAULT 'manual'::text,
  profile_id text,
  deleted_at timestamp with time zone
);

CREATE TABLE public.trackers (
  id uuid DEFAULT uuid_generate_v4() NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  category text DEFAULT 'custom'::text,
  unit text,
  icon text,
  fields jsonb DEFAULT '[]'::jsonb,
  linked_profiles jsonb DEFAULT '[]'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  deleted_at timestamp with time zone,
  metric_definition jsonb,
  owner_profile_id uuid GENERATED ALWAYS AS (((linked_profiles ->> 0))::uuid) STORED,
  linked_habit_id uuid
);

CREATE TABLE public.undo_log (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  before_state jsonb,
  after_state jsonb,
  message text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  undone_at timestamp with time zone
);

CREATE TABLE public.user_data_versions (
  user_id uuid NOT NULL,
  version bigint DEFAULT 1 NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  domains jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE TABLE public.user_notifications (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  title text NOT NULL,
  message text DEFAULT ''::text NOT NULL,
  severity text DEFAULT 'info'::text NOT NULL,
  entity_type text,
  entity_id text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  read_at timestamp with time zone,
  dismissed_at timestamp with time zone
);
-- @@section constraints
ALTER TABLE public.ai_action_log ADD CONSTRAINT ai_action_log_pkey PRIMARY KEY (id);
ALTER TABLE public.ai_bulk_plans ADD CONSTRAINT ai_bulk_plans_pkey PRIMARY KEY (id);
ALTER TABLE public.ai_chat_runs ADD CONSTRAINT ai_chat_runs_pkey PRIMARY KEY (id);
ALTER TABLE public.artifacts ADD CONSTRAINT artifacts_pkey PRIMARY KEY (id);
ALTER TABLE public.asset_party_links ADD CONSTRAINT asset_party_links_pkey PRIMARY KEY (id);
ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);
ALTER TABLE public.auth_rate_limits ADD CONSTRAINT auth_rate_limits_pkey PRIMARY KEY (key);
ALTER TABLE public.captures ADD CONSTRAINT captures_pkey PRIMARY KEY (id);
ALTER TABLE public.cashflow_projections ADD CONSTRAINT cashflow_projections_pkey PRIMARY KEY (id);
ALTER TABLE public.chat_artifacts ADD CONSTRAINT chat_artifacts_pkey PRIMARY KEY (id);
ALTER TABLE public.chat_idempotency ADD CONSTRAINT chat_idempotency_pkey PRIMARY KEY (user_id, idem_key);
ALTER TABLE public.documents ADD CONSTRAINT documents_pkey PRIMARY KEY (id);
ALTER TABLE public.domain_entries ADD CONSTRAINT domain_entries_pkey PRIMARY KEY (id);
ALTER TABLE public.domains ADD CONSTRAINT domains_pkey PRIMARY KEY (id);
ALTER TABLE public.entity_links ADD CONSTRAINT entity_links_pkey PRIMARY KEY (id);
ALTER TABLE public.event_documents ADD CONSTRAINT event_documents_pkey PRIMARY KEY (event_id, document_id);
ALTER TABLE public.events ADD CONSTRAINT events_pkey PRIMARY KEY (id);
ALTER TABLE public.expenses ADD CONSTRAINT expenses_pkey PRIMARY KEY (id);
ALTER TABLE public.extraction_corrections ADD CONSTRAINT extraction_corrections_pkey PRIMARY KEY (id);
ALTER TABLE public.finance_imports ADD CONSTRAINT finance_imports_pkey PRIMARY KEY (id);
ALTER TABLE public.finance_sync_runs ADD CONSTRAINT finance_sync_runs_pkey PRIMARY KEY (id);
ALTER TABLE public.finance_webhook_events ADD CONSTRAINT finance_webhook_events_pkey PRIMARY KEY (stripe_event_id);
ALTER TABLE public.financial_accounts ADD CONSTRAINT financial_accounts_pkey PRIMARY KEY (id);
ALTER TABLE public.financial_connections ADD CONSTRAINT financial_connections_pkey PRIMARY KEY (id);
ALTER TABLE public.financial_transaction_overrides ADD CONSTRAINT financial_transaction_overrides_pkey PRIMARY KEY (id);
ALTER TABLE public.financial_transactions ADD CONSTRAINT financial_transactions_pkey PRIMARY KEY (id);
ALTER TABLE public.financial_transfer_links ADD CONSTRAINT financial_transfer_links_pkey PRIMARY KEY (id);
ALTER TABLE public.goals ADD CONSTRAINT goals_pkey PRIMARY KEY (id);
ALTER TABLE public.habit_checkins ADD CONSTRAINT habit_checkins_pkey PRIMARY KEY (id);
ALTER TABLE public.habits ADD CONSTRAINT habits_pkey PRIMARY KEY (id);
ALTER TABLE public.incomes ADD CONSTRAINT incomes_pkey PRIMARY KEY (id);
ALTER TABLE public.journal_entries ADD CONSTRAINT journal_entries_pkey PRIMARY KEY (id);
ALTER TABLE public.liability_asset_links ADD CONSTRAINT liability_asset_links_pkey PRIMARY KEY (id);
ALTER TABLE public.liability_payments ADD CONSTRAINT liability_payments_pkey PRIMARY KEY (id);
ALTER TABLE public.liability_profile_links ADD CONSTRAINT liability_profile_links_pkey PRIMARY KEY (id);
ALTER TABLE public.loan_amortization ADD CONSTRAINT loan_amortization_pkey PRIMARY KEY (id);
ALTER TABLE public.memories ADD CONSTRAINT memories_pkey PRIMARY KEY (id);
ALTER TABLE public.net_worth_snapshots ADD CONSTRAINT net_worth_snapshots_pkey PRIMARY KEY (id);
ALTER TABLE public.ownership_history ADD CONSTRAINT ownership_history_pkey PRIMARY KEY (id);
ALTER TABLE public.paychecks ADD CONSTRAINT paychecks_pkey PRIMARY KEY (id);
ALTER TABLE public.preferences ADD CONSTRAINT preferences_pkey PRIMARY KEY (id);
ALTER TABLE public.profile_type_definitions ADD CONSTRAINT profile_type_definitions_pkey PRIMARY KEY (id);
ALTER TABLE public.profiles ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);
ALTER TABLE public.response_cache ADD CONSTRAINT response_cache_pkey PRIMARY KEY (key);
ALTER TABLE public.stripe_account_holders ADD CONSTRAINT stripe_account_holders_pkey PRIMARY KEY (id);
ALTER TABLE public.tasks ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);
ALTER TABLE public.tracker_entries ADD CONSTRAINT tracker_entries_pkey PRIMARY KEY (id);
ALTER TABLE public.trackers ADD CONSTRAINT trackers_pkey PRIMARY KEY (id);
ALTER TABLE public.undo_log ADD CONSTRAINT undo_log_pkey PRIMARY KEY (id);
ALTER TABLE public.user_data_versions ADD CONSTRAINT user_data_versions_pkey PRIMARY KEY (user_id);
ALTER TABLE public.user_notifications ADD CONSTRAINT user_notifications_pkey PRIMARY KEY (id);
ALTER TABLE public.ai_chat_runs ADD CONSTRAINT ai_chat_runs_user_id_request_id_key UNIQUE (user_id, request_id);
ALTER TABLE public.asset_party_links ADD CONSTRAINT asset_party_links_asset_profile_id_party_profile_id_role_key UNIQUE (asset_profile_id, party_profile_id, role);
ALTER TABLE public.cashflow_projections ADD CONSTRAINT cashflow_projections_user_id_month_week_key UNIQUE (user_id, month, week);
ALTER TABLE public.domains ADD CONSTRAINT domains_unique_slug UNIQUE (user_id, slug);
ALTER TABLE public.entity_links ADD CONSTRAINT entity_links_unique_pair UNIQUE (user_id, source_type, source_id, target_type, target_id);
ALTER TABLE public.liability_asset_links ADD CONSTRAINT liability_asset_links_liability_profile_id_asset_profile_id_key UNIQUE (liability_profile_id, asset_profile_id);
ALTER TABLE public.liability_profile_links ADD CONSTRAINT liability_profile_links_liability_profile_id_party_profile__key UNIQUE (liability_profile_id, party_profile_id, role);
ALTER TABLE public.memories ADD CONSTRAINT memories_unique_key UNIQUE (user_id, key);
ALTER TABLE public.preferences ADD CONSTRAINT preferences_user_id_key_key UNIQUE (user_id, key);
ALTER TABLE public.profile_type_definitions ADD CONSTRAINT profile_type_definitions_type_key_key UNIQUE (type_key);
ALTER TABLE public.stripe_account_holders ADD CONSTRAINT stripe_account_holders_stripe_customer_id_key UNIQUE (stripe_customer_id);
ALTER TABLE public.stripe_account_holders ADD CONSTRAINT stripe_account_holders_user_id_key UNIQUE (user_id);
ALTER TABLE public.ai_chat_runs ADD CONSTRAINT ai_chat_runs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])));
ALTER TABLE public.artifacts ADD CONSTRAINT artifacts_type_check CHECK ((type = ANY (ARRAY['checklist'::text, 'note'::text, 'markdown'::text, 'code'::text, 'html'::text, 'react'::text, 'svg'::text, 'mermaid'::text, 'chart'::text, 'doc'::text, 'sheet'::text])));
ALTER TABLE public.asset_party_links ADD CONSTRAINT asset_party_links_ownership_percentage_check CHECK (((ownership_percentage >= (0)::numeric) AND (ownership_percentage <= (100)::numeric)));
ALTER TABLE public.asset_party_links ADD CONSTRAINT asset_party_links_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'co_owner'::text, 'beneficiary'::text, 'trustee'::text, 'custodian'::text, 'authorized_user'::text])));
ALTER TABLE public.asset_party_links ADD CONSTRAINT asset_party_pct_range CHECK (((ownership_percentage >= (0)::numeric) AND (ownership_percentage <= (100)::numeric))) NOT VALID;
ALTER TABLE public.captures ADD CONSTRAINT captures_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)));
ALTER TABLE public.captures ADD CONSTRAINT captures_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'projected'::text, 'dismissed'::text, 'failed'::text])));
ALTER TABLE public.cashflow_projections ADD CONSTRAINT cashflow_projections_week_check CHECK (((week >= 1) AND (week <= 5)));
ALTER TABLE public.chat_artifacts ADD CONSTRAINT chat_artifacts_type_check CHECK ((type = ANY (ARRAY['chart'::text, 'structured_plan'::text, 'summary_report'::text, 'kpi_cards'::text, 'calculator'::text, 'quick_entry_form'::text, 'checklist'::text])));
ALTER TABLE public.chat_artifacts ADD CONSTRAINT chat_artifacts_update_type_check CHECK ((update_type = ANY (ARRAY['create'::text, 'full_replace'::text, 'patch'::text])));
ALTER TABLE public.chat_idempotency ADD CONSTRAINT chat_idempotency_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'done'::text])));
ALTER TABLE public.finance_imports ADD CONSTRAINT finance_imports_status_check CHECK ((status = ANY (ARRAY['committed'::text, 'undone'::text])));
ALTER TABLE public.finance_sync_runs ADD CONSTRAINT finance_sync_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'success'::text, 'partial'::text, 'failed'::text])));
ALTER TABLE public.finance_sync_runs ADD CONSTRAINT finance_sync_runs_sync_type_check CHECK ((sync_type = ANY (ARRAY['initial'::text, 'manual'::text, 'scheduled'::text, 'webhook'::text, 'relink'::text])));
ALTER TABLE public.financial_accounts ADD CONSTRAINT financial_accounts_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'disconnected'::text, 'action_required'::text])));
ALTER TABLE public.financial_connections ADD CONSTRAINT financial_connections_connection_status_check CHECK ((connection_status = ANY (ARRAY['connecting'::text, 'active'::text, 'action_required'::text, 'disconnected'::text, 'failed'::text])));
ALTER TABLE public.financial_connections ADD CONSTRAINT financial_connections_last_sync_status_check CHECK ((last_sync_status = ANY (ARRAY['success'::text, 'partial'::text, 'failed'::text])));
ALTER TABLE public.financial_transactions ADD CONSTRAINT financial_transactions_transaction_type_check CHECK ((transaction_type = ANY (ARRAY['debit'::text, 'credit'::text])));
ALTER TABLE public.financial_transfer_links ADD CONSTRAINT financial_transfer_links_state_check CHECK ((state = ANY (ARRAY['detected'::text, 'confirmed'::text, 'rejected'::text])));
ALTER TABLE public.habit_checkins ADD CONSTRAINT habit_checkins_source_check CHECK (((source IS NULL) OR (source = ANY (ARRAY['manual'::text, 'ai_chat'::text, 'automation'::text, 'import'::text]))));
ALTER TABLE public.habits ADD CONSTRAINT habits_time_of_day_check CHECK (((time_of_day IS NULL) OR (time_of_day = ANY (ARRAY['morning'::text, 'afternoon'::text, 'evening'::text, 'bedtime'::text, 'anytime'::text]))));
ALTER TABLE public.journal_entries ADD CONSTRAINT journal_entries_mood_check CHECK ((mood = ANY (ARRAY['amazing'::text, 'great'::text, 'good'::text, 'okay'::text, 'neutral'::text, 'bad'::text, 'awful'::text, 'terrible'::text])));
ALTER TABLE public.liability_asset_links ADD CONSTRAINT liability_asset_links_ownership_percentage_check CHECK (((ownership_percentage >= (0)::numeric) AND (ownership_percentage <= (100)::numeric)));
ALTER TABLE public.liability_payments ADD CONSTRAINT liability_payments_amount_check CHECK ((amount >= (0)::numeric));
ALTER TABLE public.liability_payments ADD CONSTRAINT liability_payments_fees_check CHECK ((fees >= (0)::numeric));
ALTER TABLE public.liability_payments ADD CONSTRAINT liability_payments_interest_portion_check CHECK ((interest_portion >= (0)::numeric));
ALTER TABLE public.liability_payments ADD CONSTRAINT liability_payments_payment_type_check CHECK ((payment_type = ANY (ARRAY['standard'::text, 'minimum'::text, 'custom'::text, 'extra_principal'::text, 'interest_only'::text, 'partial'::text, 'payoff'::text, 'reversal'::text, 'deferred'::text, 'skipped'::text])));
ALTER TABLE public.liability_payments ADD CONSTRAINT liability_payments_principal_portion_check CHECK ((principal_portion >= (0)::numeric));
ALTER TABLE public.liability_profile_links ADD CONSTRAINT liability_party_pct_range CHECK (((ownership_percentage >= (0)::numeric) AND (ownership_percentage <= (100)::numeric))) NOT VALID;
ALTER TABLE public.liability_profile_links ADD CONSTRAINT liability_profile_links_ownership_percentage_check CHECK (((ownership_percentage >= (0)::numeric) AND (ownership_percentage <= (100)::numeric)));
ALTER TABLE public.liability_profile_links ADD CONSTRAINT liability_profile_links_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'co_signer'::text, 'guarantor'::text, 'responsible_party'::text, 'authorized_user'::text])));
ALTER TABLE public.ownership_history ADD CONSTRAINT ownership_history_action_check CHECK ((action = ANY (ARRAY['create'::text, 'update'::text, 'delete'::text, 'move'::text])));
ALTER TABLE public.ownership_history ADD CONSTRAINT ownership_history_link_kind_check CHECK ((link_kind = ANY (ARRAY['asset_party'::text, 'liability_party'::text, 'liability_asset'::text])));
ALTER TABLE public.tracker_entries ADD CONSTRAINT tracker_entries_mood_check CHECK (((mood IS NULL) OR (mood = ANY (ARRAY['amazing'::text, 'great'::text, 'good'::text, 'okay'::text, 'neutral'::text, 'bad'::text, 'awful'::text, 'terrible'::text]))));
ALTER TABLE public.ai_action_log ADD CONSTRAINT ai_action_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.ai_bulk_plans ADD CONSTRAINT ai_bulk_plans_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.ai_chat_runs ADD CONSTRAINT ai_chat_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.artifacts ADD CONSTRAINT artifacts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.asset_party_links ADD CONSTRAINT asset_party_links_asset_profile_id_fkey FOREIGN KEY (asset_profile_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public.asset_party_links ADD CONSTRAINT asset_party_links_party_profile_id_fkey FOREIGN KEY (party_profile_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public.asset_party_links ADD CONSTRAINT asset_party_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.captures ADD CONSTRAINT captures_owner_profile_id_fkey FOREIGN KEY (owner_profile_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.captures ADD CONSTRAINT captures_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.cashflow_projections ADD CONSTRAINT cashflow_projections_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.documents ADD CONSTRAINT documents_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES documents(id);
ALTER TABLE public.documents ADD CONSTRAINT documents_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.domain_entries ADD CONSTRAINT domain_entries_domain_id_fkey FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE;
ALTER TABLE public.domain_entries ADD CONSTRAINT domain_entries_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.domains ADD CONSTRAINT domains_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.entity_links ADD CONSTRAINT entity_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.event_documents ADD CONSTRAINT event_documents_document_id_fkey FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE;
ALTER TABLE public.event_documents ADD CONSTRAINT event_documents_event_id_fkey FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE;
ALTER TABLE public.event_documents ADD CONSTRAINT event_documents_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.events ADD CONSTRAINT events_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.expenses ADD CONSTRAINT expenses_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.extraction_corrections ADD CONSTRAINT extraction_corrections_document_id_fkey FOREIGN KEY (document_id) REFERENCES documents(id);
ALTER TABLE public.extraction_corrections ADD CONSTRAINT extraction_corrections_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
ALTER TABLE public.finance_imports ADD CONSTRAINT finance_imports_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.finance_imports ADD CONSTRAINT finance_imports_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.finance_sync_runs ADD CONSTRAINT finance_sync_runs_financial_connection_id_fkey FOREIGN KEY (financial_connection_id) REFERENCES financial_connections(id) ON DELETE CASCADE;
ALTER TABLE public.finance_sync_runs ADD CONSTRAINT finance_sync_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.financial_accounts ADD CONSTRAINT financial_accounts_financial_connection_id_fkey FOREIGN KEY (financial_connection_id) REFERENCES financial_connections(id) ON DELETE SET NULL;
ALTER TABLE public.financial_accounts ADD CONSTRAINT financial_accounts_matched_profile_id_fkey FOREIGN KEY (matched_profile_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.financial_accounts ADD CONSTRAINT financial_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.financial_connections ADD CONSTRAINT financial_connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.financial_transaction_overrides ADD CONSTRAINT financial_transaction_overrid_linked_subscription_profile__fkey FOREIGN KEY (linked_subscription_profile_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.financial_transaction_overrides ADD CONSTRAINT financial_transaction_override_linked_liability_profile_id_fkey FOREIGN KEY (linked_liability_profile_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.financial_transaction_overrides ADD CONSTRAINT financial_transaction_overrides_financial_transaction_id_fkey FOREIGN KEY (financial_transaction_id) REFERENCES financial_transactions(id) ON DELETE CASCADE;
ALTER TABLE public.financial_transaction_overrides ADD CONSTRAINT financial_transaction_overrides_linked_asset_profile_id_fkey FOREIGN KEY (linked_asset_profile_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.financial_transaction_overrides ADD CONSTRAINT financial_transaction_overrides_linked_profile_id_fkey FOREIGN KEY (linked_profile_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.financial_transaction_overrides ADD CONSTRAINT financial_transaction_overrides_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.financial_transactions ADD CONSTRAINT financial_transactions_financial_account_id_fkey FOREIGN KEY (financial_account_id) REFERENCES financial_accounts(id) ON DELETE CASCADE;
ALTER TABLE public.financial_transactions ADD CONSTRAINT financial_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.financial_transfer_links ADD CONSTRAINT financial_transfer_links_inflow_transaction_id_fkey FOREIGN KEY (inflow_transaction_id) REFERENCES financial_transactions(id) ON DELETE CASCADE;
ALTER TABLE public.financial_transfer_links ADD CONSTRAINT financial_transfer_links_outflow_transaction_id_fkey FOREIGN KEY (outflow_transaction_id) REFERENCES financial_transactions(id) ON DELETE CASCADE;
ALTER TABLE public.financial_transfer_links ADD CONSTRAINT financial_transfer_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.goals ADD CONSTRAINT goals_habit_fk FOREIGN KEY (habit_id) REFERENCES habits(id) ON DELETE SET NULL;
ALTER TABLE public.goals ADD CONSTRAINT goals_tracker_fk FOREIGN KEY (tracker_id) REFERENCES trackers(id) ON DELETE SET NULL;
ALTER TABLE public.goals ADD CONSTRAINT goals_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.habit_checkins ADD CONSTRAINT habit_checkins_habit_id_fkey FOREIGN KEY (habit_id) REFERENCES habits(id) ON DELETE CASCADE;
ALTER TABLE public.habit_checkins ADD CONSTRAINT habit_checkins_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.habits ADD CONSTRAINT habits_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.incomes ADD CONSTRAINT incomes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.journal_entries ADD CONSTRAINT journal_entries_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.liability_asset_links ADD CONSTRAINT liability_asset_links_asset_profile_id_fkey FOREIGN KEY (asset_profile_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public.liability_asset_links ADD CONSTRAINT liability_asset_links_liability_profile_id_fkey FOREIGN KEY (liability_profile_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public.liability_asset_links ADD CONSTRAINT liability_asset_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.liability_payments ADD CONSTRAINT liability_payments_document_id_fkey FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE SET NULL;
ALTER TABLE public.liability_payments ADD CONSTRAINT liability_payments_liability_profile_id_fkey FOREIGN KEY (liability_profile_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public.liability_payments ADD CONSTRAINT liability_payments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.liability_profile_links ADD CONSTRAINT liability_profile_links_liability_profile_id_fkey FOREIGN KEY (liability_profile_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public.liability_profile_links ADD CONSTRAINT liability_profile_links_party_profile_id_fkey FOREIGN KEY (party_profile_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public.liability_profile_links ADD CONSTRAINT liability_profile_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.loan_amortization ADD CONSTRAINT loan_amortization_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.memories ADD CONSTRAINT memories_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.net_worth_snapshots ADD CONSTRAINT net_worth_snapshots_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public.net_worth_snapshots ADD CONSTRAINT net_worth_snapshots_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.ownership_history ADD CONSTRAINT ownership_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.paychecks ADD CONSTRAINT paychecks_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.preferences ADD CONSTRAINT preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_parent_profile_id_fkey FOREIGN KEY (parent_profile_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.stripe_account_holders ADD CONSTRAINT stripe_account_holders_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.tracker_entries ADD CONSTRAINT tracker_entries_tracker_id_fkey FOREIGN KEY (tracker_id) REFERENCES trackers(id) ON DELETE CASCADE;
ALTER TABLE public.tracker_entries ADD CONSTRAINT tracker_entries_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.trackers ADD CONSTRAINT trackers_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.user_notifications ADD CONSTRAINT user_notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
-- @@section indexes
CREATE INDEX ai_action_log_entity_idx ON public.ai_action_log USING btree (user_id, entity_type, entity_id);
CREATE UNIQUE INDEX ai_action_log_operation_uidx ON public.ai_action_log USING btree (user_id, operation_id) WHERE (operation_id IS NOT NULL);
CREATE INDEX ai_action_log_request_idx ON public.ai_action_log USING btree (user_id, request_id) WHERE (request_id IS NOT NULL);
CREATE INDEX ai_action_log_user_created_idx ON public.ai_action_log USING btree (user_id, created_at DESC);
CREATE INDEX ai_bulk_plans_user_idx ON public.ai_bulk_plans USING btree (user_id, created_at DESC);
CREATE INDEX ai_chat_runs_user_updated_idx ON public.ai_chat_runs USING btree (user_id, updated_at DESC);
CREATE INDEX auth_rate_limits_reset_at_idx ON public.auth_rate_limits USING btree (reset_at);
CREATE INDEX captures_owner_profile_idx ON public.captures USING btree (owner_profile_id) WHERE (owner_profile_id IS NOT NULL);
CREATE INDEX captures_user_created_idx ON public.captures USING btree (user_id, created_at DESC);
CREATE INDEX captures_user_owner_idx ON public.captures USING btree (user_id, owner_profile_id, created_at DESC) WHERE (owner_profile_id IS NOT NULL);
CREATE INDEX captures_user_status_idx ON public.captures USING btree (user_id, status, created_at DESC);
CREATE INDEX documents_user_live_created_idx ON public.documents USING btree (user_id, created_at DESC) WHERE (deleted_at IS NULL);
CREATE INDEX events_deleted_at_idx ON public.events USING btree (user_id) WHERE (deleted_at IS NULL);
CREATE INDEX events_user_live_date_idx ON public.events USING btree (user_id, date DESC) WHERE (deleted_at IS NULL);
CREATE INDEX expenses_deleted_at_idx ON public.expenses USING btree (user_id) WHERE (deleted_at IS NULL);
CREATE INDEX expenses_user_live_date_idx ON public.expenses USING btree (user_id, date DESC) WHERE (deleted_at IS NULL);
CREATE INDEX finance_imports_user_created_idx ON public.finance_imports USING btree (user_id, created_at DESC);
CREATE INDEX finance_sync_runs_connection_idx ON public.finance_sync_runs USING btree (financial_connection_id, started_at DESC);
CREATE INDEX finance_sync_runs_user_idx ON public.finance_sync_runs USING btree (user_id, started_at DESC);
CREATE INDEX finance_webhook_events_received_idx ON public.finance_webhook_events USING btree (received_at DESC);
CREATE INDEX financial_accounts_connection_idx ON public.financial_accounts USING btree (financial_connection_id);
CREATE INDEX financial_accounts_matched_profile_idx ON public.financial_accounts USING btree (matched_profile_id) WHERE (matched_profile_id IS NOT NULL);
CREATE INDEX financial_accounts_user_idx ON public.financial_accounts USING btree (user_id, status);
CREATE UNIQUE INDEX financial_accounts_user_stripe_uniq ON public.financial_accounts USING btree (user_id, stripe_financial_connections_account_id);
CREATE INDEX financial_connections_user_idx ON public.financial_connections USING btree (user_id, created_at DESC);
CREATE UNIQUE INDEX financial_connections_user_session_uniq ON public.financial_connections USING btree (user_id, stripe_session_id) WHERE (stripe_session_id IS NOT NULL);
CREATE INDEX financial_overrides_asset_profile_idx ON public.financial_transaction_overrides USING btree (linked_asset_profile_id) WHERE (linked_asset_profile_id IS NOT NULL);
CREATE INDEX financial_overrides_liability_profile_idx ON public.financial_transaction_overrides USING btree (linked_liability_profile_id) WHERE (linked_liability_profile_id IS NOT NULL);
CREATE INDEX financial_overrides_profile_idx ON public.financial_transaction_overrides USING btree (linked_profile_id) WHERE (linked_profile_id IS NOT NULL);
CREATE INDEX financial_overrides_subscription_profile_idx ON public.financial_transaction_overrides USING btree (linked_subscription_profile_id) WHERE (linked_subscription_profile_id IS NOT NULL);
CREATE UNIQUE INDEX financial_transaction_overrides_txn_uniq ON public.financial_transaction_overrides USING btree (financial_transaction_id);
CREATE INDEX financial_transaction_overrides_user_idx ON public.financial_transaction_overrides USING btree (user_id);
CREATE INDEX financial_transactions_account_date_idx ON public.financial_transactions USING btree (financial_account_id, transaction_date DESC);
CREATE INDEX financial_transactions_merchant_idx ON public.financial_transactions USING btree (user_id, merchant_name);
CREATE INDEX financial_transactions_user_date_idx ON public.financial_transactions USING btree (user_id, transaction_date DESC);
CREATE UNIQUE INDEX financial_transactions_user_stripe_uniq ON public.financial_transactions USING btree (user_id, stripe_transaction_id);
CREATE INDEX financial_transfer_links_inflow_idx ON public.financial_transfer_links USING btree (inflow_transaction_id);
CREATE UNIQUE INDEX financial_transfer_links_pair_uniq ON public.financial_transfer_links USING btree (outflow_transaction_id, inflow_transaction_id);
CREATE INDEX financial_transfer_links_user_idx ON public.financial_transfer_links USING btree (user_id, state);
CREATE INDEX habit_checkins_user_date_idx ON public.habit_checkins USING btree (user_id, date);
CREATE INDEX habits_user_end_date_idx ON public.habits USING btree (user_id, end_date) WHERE ((end_date IS NOT NULL) AND (deleted_at IS NULL));
CREATE INDEX habits_user_linked_tracker_idx ON public.habits USING btree (user_id, linked_tracker_id) WHERE ((linked_tracker_id IS NOT NULL) AND (deleted_at IS NULL));
CREATE INDEX idx_apl_asset ON public.asset_party_links USING btree (asset_profile_id);
CREATE INDEX idx_apl_party ON public.asset_party_links USING btree (party_profile_id);
CREATE INDEX idx_apl_user ON public.asset_party_links USING btree (user_id);
CREATE INDEX idx_artifacts_linked_profiles_gin ON public.artifacts USING gin (linked_profiles);
CREATE INDEX idx_artifacts_user ON public.artifacts USING btree (user_id);
CREATE INDEX idx_audit_log_entity ON public.audit_log USING btree (entity_type, entity_id);
CREATE INDEX idx_audit_log_time ON public.audit_log USING btree (created_at DESC);
CREATE INDEX idx_audit_log_user ON public.audit_log USING btree (user_id);
CREATE INDEX idx_cashflow_month ON public.cashflow_projections USING btree (month);
CREATE INDEX idx_cashflow_user ON public.cashflow_projections USING btree (user_id);
CREATE INDEX idx_chat_artifacts_profile ON public.chat_artifacts USING btree (profile_id);
CREATE INDEX idx_chat_artifacts_type ON public.chat_artifacts USING btree (type);
CREATE INDEX idx_chat_artifacts_user ON public.chat_artifacts USING btree (user_id);
CREATE INDEX idx_chat_idempotency_created_at ON public.chat_idempotency USING btree (created_at);
CREATE INDEX idx_corrections_doctype ON public.extraction_corrections USING btree (document_type, field_key);
CREATE INDEX idx_documents_deleted_at ON public.documents USING btree (user_id, deleted_at) WHERE (deleted_at IS NULL);
CREATE INDEX idx_documents_linked_profiles_gin ON public.documents USING gin (linked_profiles);
CREATE INDEX idx_documents_superseded_by ON public.documents USING btree (superseded_by) WHERE (superseded_by IS NOT NULL);
CREATE INDEX idx_documents_user ON public.documents USING btree (user_id);
CREATE INDEX idx_domain_entries_domain ON public.domain_entries USING btree (domain_id);
CREATE INDEX idx_domain_entries_user_id ON public.domain_entries USING btree (user_id);
CREATE INDEX idx_domains_user ON public.domains USING btree (user_id);
CREATE INDEX idx_entity_links_source ON public.entity_links USING btree (source_type, source_id);
CREATE INDEX idx_entity_links_target ON public.entity_links USING btree (target_type, target_id);
CREATE INDEX idx_entity_links_user ON public.entity_links USING btree (user_id);
CREATE INDEX idx_event_documents_document ON public.event_documents USING btree (document_id);
CREATE INDEX idx_event_documents_user_id ON public.event_documents USING btree (user_id);
CREATE INDEX idx_events_date ON public.events USING btree (user_id, date);
CREATE INDEX idx_events_linked_profiles_gin ON public.events USING gin (linked_profiles);
CREATE INDEX idx_events_user ON public.events USING btree (user_id);
CREATE INDEX idx_expenses_desc_search ON public.expenses USING gin (to_tsvector('english'::regconfig, ((((description || ' '::text) || COALESCE(vendor, ''::text)) || ' '::text) || category)));
CREATE INDEX idx_expenses_linked_profiles_gin ON public.expenses USING gin (linked_profiles);
CREATE INDEX idx_expenses_user ON public.expenses USING btree (user_id);
CREATE INDEX idx_expenses_user_category ON public.expenses USING btree (user_id, category);
CREATE INDEX idx_expenses_user_date ON public.expenses USING btree (user_id, date);
CREATE INDEX idx_extraction_corrections_document_id ON public.extraction_corrections USING btree (document_id);
CREATE INDEX idx_extraction_corrections_user_id ON public.extraction_corrections USING btree (user_id);
CREATE INDEX idx_finance_imports_profile_id ON public.finance_imports USING btree (profile_id);
CREATE INDEX idx_goals_habit_id ON public.goals USING btree (habit_id);
CREATE INDEX idx_goals_linked_profiles ON public.goals USING gin (linked_profiles);
CREATE INDEX idx_goals_linked_profiles_gin ON public.goals USING gin (linked_profiles jsonb_path_ops);
CREATE INDEX idx_goals_title_search ON public.goals USING gin (to_tsvector('english'::regconfig, ((title || ' '::text) || COALESCE(category, ''::text))));
CREATE INDEX idx_goals_tracker_id ON public.goals USING btree (tracker_id);
CREATE INDEX idx_goals_user ON public.goals USING btree (user_id);
CREATE INDEX idx_goals_user_status ON public.goals USING btree (user_id, status);
CREATE INDEX idx_habit_checkins_habit ON public.habit_checkins USING btree (habit_id);
CREATE INDEX idx_habit_checkins_habit_date ON public.habit_checkins USING btree (habit_id, date);
CREATE INDEX idx_habit_checkins_habit_date_ts ON public.habit_checkins USING btree (habit_id, date, "timestamp");
CREATE INDEX idx_habit_checkins_uid ON public.habit_checkins USING btree (user_id);
CREATE INDEX idx_habits_linked_profiles ON public.habits USING gin (linked_profiles);
CREATE INDEX idx_habits_linked_profiles_gin ON public.habits USING gin (linked_profiles jsonb_path_ops);
CREATE UNIQUE INDEX idx_habits_name_owner ON public.habits USING btree (user_id, COALESCE(owner_profile_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name)) WHERE (deleted_at IS NULL);
CREATE INDEX idx_habits_user ON public.habits USING btree (user_id);
CREATE INDEX idx_habits_user_frequency ON public.habits USING btree (user_id, frequency);
CREATE INDEX idx_incomes_linked_profiles_gin ON public.incomes USING gin (linked_profiles);
CREATE INDEX idx_incomes_user ON public.incomes USING btree (user_id);
CREATE INDEX idx_journal_date ON public.journal_entries USING btree (user_id, date);
CREATE INDEX idx_journal_entries_linked_profiles_gin ON public.journal_entries USING gin (linked_profiles);
CREATE INDEX idx_journal_user ON public.journal_entries USING btree (user_id);
CREATE INDEX idx_lal_asset ON public.liability_asset_links USING btree (asset_profile_id);
CREATE INDEX idx_lal_liability ON public.liability_asset_links USING btree (liability_profile_id);
CREATE INDEX idx_lal_user ON public.liability_asset_links USING btree (user_id);
CREATE INDEX idx_liability_payments_document_id ON public.liability_payments USING btree (document_id) WHERE (document_id IS NOT NULL);
CREATE INDEX idx_loan_amort_loan ON public.loan_amortization USING btree (loan_id);
CREATE INDEX idx_loan_amort_user ON public.loan_amortization USING btree (user_id);
CREATE INDEX idx_lp_date ON public.liability_payments USING btree (payment_date);
CREATE INDEX idx_lp_liability ON public.liability_payments USING btree (liability_profile_id);
CREATE INDEX idx_lp_user ON public.liability_payments USING btree (user_id);
CREATE INDEX idx_lpl_liability ON public.liability_profile_links USING btree (liability_profile_id);
CREATE INDEX idx_lpl_party ON public.liability_profile_links USING btree (party_profile_id);
CREATE INDEX idx_lpl_user ON public.liability_profile_links USING btree (user_id);
CREATE INDEX idx_memories_user ON public.memories USING btree (user_id);
CREATE INDEX idx_net_worth_snapshots_profile_id ON public.net_worth_snapshots USING btree (profile_id) WHERE (profile_id IS NOT NULL);
CREATE INDEX idx_oh_changed_at ON public.ownership_history USING btree (changed_at DESC);
CREATE INDEX idx_oh_counterparty ON public.ownership_history USING btree (counterparty_id);
CREATE INDEX idx_oh_subject ON public.ownership_history USING btree (subject_id);
CREATE INDEX idx_oh_user ON public.ownership_history USING btree (user_id);
CREATE INDEX idx_paychecks_date ON public.paychecks USING btree (expected_date);
CREATE INDEX idx_paychecks_user ON public.paychecks USING btree (user_id);
CREATE INDEX idx_profiles_deleted_at ON public.profiles USING btree (deleted_at) WHERE (deleted_at IS NOT NULL);
CREATE INDEX idx_profiles_documents_gin ON public.profiles USING gin (documents);
CREATE INDEX idx_profiles_linked_events_gin ON public.profiles USING gin (linked_events);
CREATE INDEX idx_profiles_linked_expenses_gin ON public.profiles USING gin (linked_expenses);
CREATE INDEX idx_profiles_linked_tasks_gin ON public.profiles USING gin (linked_tasks);
CREATE INDEX idx_profiles_linked_trackers_gin ON public.profiles USING gin (linked_trackers);
CREATE INDEX idx_profiles_parent ON public.profiles USING btree (parent_profile_id) WHERE (parent_profile_id IS NOT NULL);
CREATE INDEX idx_profiles_type_key ON public.profiles USING btree (type_key);
CREATE INDEX idx_profiles_user ON public.profiles USING btree (user_id);
CREATE INDEX idx_ptd_category ON public.profile_type_definitions USING btree (category);
CREATE INDEX idx_ptd_type_key ON public.profile_type_definitions USING btree (type_key);
CREATE INDEX idx_response_cache_expires ON public.response_cache USING btree (expires_at);
CREATE INDEX idx_response_cache_user ON public.response_cache USING btree (user_id);
CREATE INDEX idx_tasks_linked_profiles_gin ON public.tasks USING gin (linked_profiles);
CREATE INDEX idx_tasks_user ON public.tasks USING btree (user_id);
CREATE INDEX idx_tasks_user_due ON public.tasks USING btree (user_id, due_date);
CREATE INDEX idx_tracker_entries_profile_id ON public.tracker_entries USING btree (profile_id);
CREATE INDEX idx_tracker_entries_tracker ON public.tracker_entries USING btree (tracker_id);
CREATE INDEX idx_tracker_entries_tracker_time ON public.tracker_entries USING btree (tracker_id, "timestamp" DESC);
CREATE INDEX idx_tracker_entries_user ON public.tracker_entries USING btree (user_id);
CREATE INDEX idx_trackers_linked_profiles_gin ON public.trackers USING gin (linked_profiles);
CREATE UNIQUE INDEX idx_trackers_name_owner ON public.trackers USING btree (user_id, COALESCE(owner_profile_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name)) WHERE (deleted_at IS NULL);
CREATE INDEX idx_trackers_name_search ON public.trackers USING gin (to_tsvector('english'::regconfig, ((name || ' '::text) || category)));
CREATE INDEX idx_trackers_user ON public.trackers USING btree (user_id);
CREATE UNIQUE INDEX net_worth_snapshots_unique ON public.net_worth_snapshots USING btree (user_id, COALESCE(profile_id, '00000000-0000-0000-0000-000000000000'::uuid), snapshot_date);
CREATE INDEX net_worth_snapshots_user_date ON public.net_worth_snapshots USING btree (user_id, snapshot_date DESC);
CREATE INDEX profiles_deleted_at_idx ON public.profiles USING btree (user_id) WHERE (deleted_at IS NULL);
CREATE UNIQUE INDEX profiles_one_self_per_user ON public.profiles USING btree (user_id) WHERE (type = 'self'::text);
CREATE INDEX tasks_deleted_at_idx ON public.tasks USING btree (user_id) WHERE (deleted_at IS NULL);
CREATE INDEX tasks_user_due_time_idx ON public.tasks USING btree (user_id, due_date) WHERE ((due_time IS NOT NULL) AND (deleted_at IS NULL));
CREATE INDEX tasks_user_live_created_idx ON public.tasks USING btree (user_id, created_at DESC) WHERE (deleted_at IS NULL);
CREATE INDEX trackers_deleted_at_idx ON public.trackers USING btree (user_id) WHERE (deleted_at IS NULL);
CREATE INDEX trackers_linked_habit_idx ON public.trackers USING btree (user_id, linked_habit_id) WHERE (linked_habit_id IS NOT NULL);
CREATE INDEX trackers_metric_definition_data_type_idx ON public.trackers USING btree (((metric_definition ->> 'dataType'::text)));
CREATE INDEX undo_log_user_active_idx ON public.undo_log USING btree (user_id, created_at DESC) WHERE (undone_at IS NULL);
CREATE INDEX undo_log_user_idx ON public.undo_log USING btree (user_id, created_at DESC);
CREATE INDEX user_notifications_user_idx ON public.user_notifications USING btree (user_id, created_at DESC);
-- @@section triggers
CREATE TRIGGER trg_artifacts_updated_at BEFORE UPDATE ON public.artifacts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_linked_profiles_ownership BEFORE INSERT OR UPDATE OF linked_profiles ON public.artifacts FOR EACH ROW EXECUTE FUNCTION enforce_linked_profiles_ownership();
CREATE CONSTRAINT TRIGGER trg_asset_party_ownership_guard AFTER INSERT OR UPDATE ON public.asset_party_links DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_asset_party_ownership_sum();
CREATE TRIGGER captures_set_updated_at_trg BEFORE UPDATE ON public.captures FOR EACH ROW EXECUTE FUNCTION captures_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_documents_updated_at BEFORE UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_linked_profiles_ownership BEFORE INSERT OR UPDATE OF linked_profiles ON public.documents FOR EACH ROW EXECUTE FUNCTION enforce_linked_profiles_ownership();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_events_updated_at BEFORE UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_linked_profiles_ownership BEFORE INSERT OR UPDATE OF linked_profiles ON public.events FOR EACH ROW EXECUTE FUNCTION enforce_linked_profiles_ownership();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_expenses_updated_at BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_linked_profiles_ownership BEFORE INSERT OR UPDATE OF linked_profiles ON public.expenses FOR EACH ROW EXECUTE FUNCTION enforce_linked_profiles_ownership();
CREATE TRIGGER financial_accounts_touch_updated_at BEFORE UPDATE ON public.financial_accounts FOR EACH ROW EXECUTE FUNCTION finance_touch_updated_at();
CREATE TRIGGER financial_connections_touch_updated_at BEFORE UPDATE ON public.financial_connections FOR EACH ROW EXECUTE FUNCTION finance_touch_updated_at();
CREATE TRIGGER financial_transaction_overrides_touch_updated_at BEFORE UPDATE ON public.financial_transaction_overrides FOR EACH ROW EXECUTE FUNCTION finance_touch_updated_at();
CREATE TRIGGER financial_transactions_touch_updated_at BEFORE UPDATE ON public.financial_transactions FOR EACH ROW EXECUTE FUNCTION finance_touch_updated_at();
CREATE TRIGGER financial_transfer_links_touch_updated_at BEFORE UPDATE ON public.financial_transfer_links FOR EACH ROW EXECUTE FUNCTION finance_touch_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.goals FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_goals_updated_at BEFORE UPDATE ON public.goals FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_linked_profiles_ownership BEFORE INSERT OR UPDATE OF linked_profiles ON public.goals FOR EACH ROW EXECUTE FUNCTION enforce_linked_profiles_ownership();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.habits FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_habits_updated_at BEFORE UPDATE ON public.habits FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_linked_profiles_ownership BEFORE INSERT OR UPDATE OF linked_profiles ON public.habits FOR EACH ROW EXECUTE FUNCTION enforce_linked_profiles_ownership();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.incomes FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_linked_profiles_ownership BEFORE INSERT OR UPDATE OF linked_profiles ON public.incomes FOR EACH ROW EXECUTE FUNCTION enforce_linked_profiles_ownership();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.journal_entries FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_linked_profiles_ownership BEFORE INSERT OR UPDATE OF linked_profiles ON public.journal_entries FOR EACH ROW EXECUTE FUNCTION enforce_linked_profiles_ownership();
CREATE CONSTRAINT TRIGGER trg_liability_party_ownership_guard AFTER INSERT OR UPDATE ON public.liability_profile_links DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_liability_party_ownership_sum();
CREATE TRIGGER trg_memories_updated_at BEFORE UPDATE ON public.memories FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER stripe_account_holders_touch_updated_at BEFORE UPDATE ON public.stripe_account_holders FOR EACH ROW EXECUTE FUNCTION finance_touch_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_linked_profiles_ownership BEFORE INSERT OR UPDATE OF linked_profiles ON public.tasks FOR EACH ROW EXECUTE FUNCTION enforce_linked_profiles_ownership();
CREATE TRIGGER trg_tasks_updated_at BEFORE UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.tracker_entries FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.trackers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_linked_profiles_ownership BEFORE INSERT OR UPDATE OF linked_profiles ON public.trackers FOR EACH ROW EXECUTE FUNCTION enforce_linked_profiles_ownership();
CREATE TRIGGER trg_trackers_updated_at BEFORE UPDATE ON public.trackers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- @@section rls
ALTER TABLE public.ai_action_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_bulk_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_chat_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_party_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.captures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cashflow_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entity_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extraction_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_transaction_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_transfer_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.habit_checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.habits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.liability_asset_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.liability_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.liability_profile_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loan_amortization ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.net_worth_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ownership_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paychecks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile_type_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.response_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_account_holders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracker_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trackers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.undo_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_data_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_notifications ENABLE ROW LEVEL SECURITY;
-- @@section policies
CREATE POLICY ai_action_log_owner ON public.ai_action_log AS PERMISSIVE FOR ALL TO public USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY ai_bulk_plans_owner ON public.ai_bulk_plans AS PERMISSIVE FOR ALL TO public USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY ai_chat_runs_owner ON public.ai_chat_runs AS PERMISSIVE FOR ALL TO public USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "Users can delete own artifacts" ON public.artifacts AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can insert own artifacts" ON public.artifacts AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own artifacts" ON public.artifacts AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own artifacts" ON public.artifacts AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can delete own asset_party_links" ON public.asset_party_links AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can insert own asset_party_links" ON public.asset_party_links AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own asset_party_links" ON public.asset_party_links AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own asset_party_links" ON public.asset_party_links AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY audit_log_insert ON public.audit_log AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY audit_log_no_delete ON public.audit_log AS PERMISSIVE FOR DELETE TO public USING (false);
CREATE POLICY audit_log_no_update ON public.audit_log AS PERMISSIVE FOR UPDATE TO public USING (false) WITH CHECK (false);
CREATE POLICY audit_log_select ON public.audit_log AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY deny_all ON public.auth_rate_limits AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY captures_owner ON public.captures AS PERMISSIVE FOR ALL TO public USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY cashflow_projections_service ON public.cashflow_projections AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY cashflow_projections_user_policy ON public.cashflow_projections AS PERMISSIVE FOR ALL TO public USING ((( SELECT auth.uid() AS uid) = user_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY chat_artifacts_delete ON public.chat_artifacts AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY chat_artifacts_insert ON public.chat_artifacts AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY chat_artifacts_select ON public.chat_artifacts AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY chat_artifacts_update ON public.chat_artifacts AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY chat_idempotency_owner ON public.chat_idempotency AS PERMISSIVE FOR ALL TO public USING ((user_id = (( SELECT auth.uid() AS uid))::text)) WITH CHECK ((user_id = (( SELECT auth.uid() AS uid))::text));
CREATE POLICY "Users can delete own documents" ON public.documents AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can insert own documents" ON public.documents AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own documents" ON public.documents AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own documents" ON public.documents AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can delete own domain_entries" ON public.domain_entries AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can insert own domain_entries" ON public.domain_entries AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own domain_entries" ON public.domain_entries AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own domain_entries" ON public.domain_entries AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can delete own domains" ON public.domains AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can insert own domains" ON public.domains AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own domains" ON public.domains AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own domains" ON public.domains AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can delete own entity_links" ON public.entity_links AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can insert own entity_links" ON public.entity_links AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own entity_links" ON public.entity_links AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own entity_links" ON public.entity_links AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can delete own event_documents" ON public.event_documents AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can insert own event_documents" ON public.event_documents AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own event_documents" ON public.event_documents AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own event_documents" ON public.event_documents AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can delete own events" ON public.events AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can insert own events" ON public.events AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own events" ON public.events AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own events" ON public.events AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can delete own expenses" ON public.expenses AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can insert own expenses" ON public.expenses AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own expenses" ON public.expenses AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own expenses" ON public.expenses AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY extraction_corrections_user ON public.extraction_corrections AS PERMISSIVE FOR ALL TO public USING ((( SELECT auth.uid() AS uid) = user_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY finance_imports_owner ON public.finance_imports AS PERMISSIVE FOR ALL TO public USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY finance_sync_runs_delete_own ON public.finance_sync_runs AS PERMISSIVE FOR DELETE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY finance_sync_runs_insert_own ON public.finance_sync_runs AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY finance_sync_runs_select_own ON public.finance_sync_runs AS PERMISSIVE FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY finance_sync_runs_update_own ON public.finance_sync_runs AS PERMISSIVE FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY deny_all ON public.finance_webhook_events AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY financial_accounts_delete_own ON public.financial_accounts AS PERMISSIVE FOR DELETE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY financial_accounts_insert_own ON public.financial_accounts AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY financial_accounts_select_own ON public.financial_accounts AS PERMISSIVE FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY financial_accounts_update_own ON public.financial_accounts AS PERMISSIVE FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY financial_connections_delete_own ON public.financial_connections AS PERMISSIVE FOR DELETE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY financial_connections_insert_own ON public.financial_connections AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY financial_connections_select_own ON public.financial_connections AS PERMISSIVE FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY financial_connections_update_own ON public.financial_connections AS PERMISSIVE FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY financial_transaction_overrides_delete_own ON public.financial_transaction_overrides AS PERMISSIVE FOR DELETE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY financial_transaction_overrides_insert_own ON public.financial_transaction_overrides AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY financial_transaction_overrides_select_own ON public.financial_transaction_overrides AS PERMISSIVE FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY financial_transaction_overrides_update_own ON public.financial_transaction_overrides AS PERMISSIVE FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY financial_transactions_delete_own ON public.financial_transactions AS PERMISSIVE FOR DELETE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY financial_transactions_insert_own ON public.financial_transactions AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY financial_transactions_select_own ON public.financial_transactions AS PERMISSIVE FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY financial_transactions_update_own ON public.financial_transactions AS PERMISSIVE FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY financial_transfer_links_delete_own ON public.financial_transfer_links AS PERMISSIVE FOR DELETE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY financial_transfer_links_insert_own ON public.financial_transfer_links AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY financial_transfer_links_select_own ON public.financial_transfer_links AS PERMISSIVE FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY financial_transfer_links_update_own ON public.financial_transfer_links AS PERMISSIVE FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can delete own goals" ON public.goals AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can insert own goals" ON public.goals AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own goals" ON public.goals AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own goals" ON public.goals AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can delete own habit_checkins" ON public.habit_checkins AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can insert own habit_checkins" ON public.habit_checkins AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own habit_checkins" ON public.habit_checkins AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own habit_checkins" ON public.habit_checkins AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can delete own habits" ON public.habits AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can insert own habits" ON public.habits AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own habits" ON public.habits AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own habits" ON public.habits AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY incomes_delete ON public.incomes AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY incomes_insert ON public.incomes AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY incomes_select ON public.incomes AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY incomes_update ON public.incomes AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can delete own journal_entries" ON public.journal_entries AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can insert own journal_entries" ON public.journal_entries AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own journal_entries" ON public.journal_entries AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own journal_entries" ON public.journal_entries AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can delete own liability_asset_links" ON public.liability_asset_links AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can insert own liability_asset_links" ON public.liability_asset_links AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own liability_asset_links" ON public.liability_asset_links AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own liability_asset_links" ON public.liability_asset_links AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can delete own liability_payments" ON public.liability_payments AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can insert own liability_payments" ON public.liability_payments AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own liability_payments" ON public.liability_payments AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own liability_payments" ON public.liability_payments AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can delete own liability_profile_links" ON public.liability_profile_links AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can insert own liability_profile_links" ON public.liability_profile_links AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own liability_profile_links" ON public.liability_profile_links AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own liability_profile_links" ON public.liability_profile_links AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY loan_amortization_service ON public.loan_amortization AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY loan_amortization_user_policy ON public.loan_amortization AS PERMISSIVE FOR ALL TO public USING ((( SELECT auth.uid() AS uid) = user_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can delete own memories" ON public.memories AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can insert own memories" ON public.memories AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own memories" ON public.memories AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own memories" ON public.memories AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY snapshots_owner ON public.net_worth_snapshots AS PERMISSIVE FOR ALL TO public USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can delete own ownership_history" ON public.ownership_history AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can insert own ownership_history" ON public.ownership_history AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own ownership_history" ON public.ownership_history AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own ownership_history" ON public.ownership_history AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY paychecks_service ON public.paychecks AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY paychecks_user_policy ON public.paychecks AS PERMISSIVE FOR ALL TO public USING ((( SELECT auth.uid() AS uid) = user_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can delete own preferences" ON public.preferences AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can insert own preferences" ON public.preferences AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own preferences" ON public.preferences AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own preferences" ON public.preferences AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Public read only" ON public.profile_type_definitions AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY ptd_no_delete ON public.profile_type_definitions AS PERMISSIVE FOR DELETE TO public USING (false);
CREATE POLICY ptd_no_insert ON public.profile_type_definitions AS PERMISSIVE FOR INSERT TO public WITH CHECK (false);
CREATE POLICY ptd_no_update ON public.profile_type_definitions AS PERMISSIVE FOR UPDATE TO public USING (false) WITH CHECK (false);
CREATE POLICY "Users can delete own profiles" ON public.profiles AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can insert own profiles" ON public.profiles AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own profiles" ON public.profiles AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own profiles" ON public.profiles AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY deny_all ON public.response_cache AS PERMISSIVE FOR ALL TO public USING (false) WITH CHECK (false);
CREATE POLICY stripe_account_holders_delete_own ON public.stripe_account_holders AS PERMISSIVE FOR DELETE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY stripe_account_holders_insert_own ON public.stripe_account_holders AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY stripe_account_holders_select_own ON public.stripe_account_holders AS PERMISSIVE FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY stripe_account_holders_update_own ON public.stripe_account_holders AS PERMISSIVE FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can delete own tasks" ON public.tasks AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can insert own tasks" ON public.tasks AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own tasks" ON public.tasks AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own tasks" ON public.tasks AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can delete own tracker_entries" ON public.tracker_entries AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can insert own tracker_entries" ON public.tracker_entries AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own tracker_entries" ON public.tracker_entries AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own tracker_entries" ON public.tracker_entries AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can delete own trackers" ON public.trackers AS PERMISSIVE FOR DELETE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can insert own trackers" ON public.trackers AS PERMISSIVE FOR INSERT TO public WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update own trackers" ON public.trackers AS PERMISSIVE FOR UPDATE TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view own trackers" ON public.trackers AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY undo_log_delete_own ON public.undo_log AS PERMISSIVE FOR DELETE TO public USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY undo_log_insert_own ON public.undo_log AS PERMISSIVE FOR INSERT TO public WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY undo_log_select_own ON public.undo_log AS PERMISSIVE FOR SELECT TO public USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY undo_log_update_own ON public.undo_log AS PERMISSIVE FOR UPDATE TO public USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY user_data_versions_owner ON public.user_data_versions AS PERMISSIVE FOR ALL TO public USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY user_notifications_owner ON public.user_notifications AS PERMISSIVE FOR ALL TO public USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
-- @@section grants
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ai_action_log TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ai_action_log TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ai_action_log TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ai_bulk_plans TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ai_bulk_plans TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ai_bulk_plans TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ai_chat_runs TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ai_chat_runs TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ai_chat_runs TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.artifacts TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.artifacts TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.artifacts TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.asset_party_links TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.asset_party_links TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.asset_party_links TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.audit_log TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.audit_log TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.audit_log TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.auth_rate_limits TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.captures TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.captures TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.captures TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.cashflow_projections TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.cashflow_projections TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.cashflow_projections TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.chat_artifacts TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.chat_artifacts TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.chat_artifacts TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.chat_idempotency TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.chat_idempotency TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.chat_idempotency TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.documents TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.documents TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.documents TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.domain_entries TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.domain_entries TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.domain_entries TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.domains TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.domains TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.domains TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.entity_links TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.entity_links TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.entity_links TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.event_documents TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.event_documents TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.event_documents TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.events TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.events TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.events TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.expenses TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.expenses TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.expenses TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.extraction_corrections TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.extraction_corrections TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.extraction_corrections TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.finance_imports TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.finance_imports TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.finance_imports TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.finance_sync_runs TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.finance_sync_runs TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.finance_sync_runs TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.finance_webhook_events TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.financial_accounts TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.financial_accounts TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.financial_accounts TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.financial_connections TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.financial_connections TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.financial_connections TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.financial_transaction_overrides TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.financial_transaction_overrides TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.financial_transaction_overrides TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.financial_transactions TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.financial_transactions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.financial_transactions TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.financial_transfer_links TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.financial_transfer_links TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.financial_transfer_links TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.goals TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.goals TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.goals TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.habit_checkins TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.habit_checkins TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.habit_checkins TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.habits TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.habits TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.habits TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.incomes TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.incomes TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.incomes TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.journal_entries TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.journal_entries TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.journal_entries TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.liability_asset_links TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.liability_asset_links TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.liability_asset_links TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.liability_payments TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.liability_payments TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.liability_payments TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.liability_profile_links TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.liability_profile_links TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.liability_profile_links TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.loan_amortization TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.loan_amortization TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.loan_amortization TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.memories TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.memories TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.memories TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.net_worth_snapshots TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.net_worth_snapshots TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.net_worth_snapshots TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ownership_history TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ownership_history TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.ownership_history TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.paychecks TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.paychecks TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.paychecks TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.preferences TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.preferences TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.preferences TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.profile_type_definitions TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.profile_type_definitions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.profile_type_definitions TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.profiles TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.profiles TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.profiles TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.response_cache TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.stripe_account_holders TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.stripe_account_holders TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.stripe_account_holders TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.tasks TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.tasks TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.tasks TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.tracker_entries TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.tracker_entries TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.tracker_entries TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.trackers TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.trackers TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.trackers TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.undo_log TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.undo_log TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.undo_log TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_data_versions TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_data_versions TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_data_versions TO service_role;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_notifications TO anon;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_notifications TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.user_notifications TO service_role;
GRANT EXECUTE ON FUNCTION public.bump_user_data_version(p_user_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_profile_cascade(p_user_id uuid, p_profile_id uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_updated_at() TO anon;
GRANT EXECUTE ON FUNCTION public.set_updated_at() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_updated_at() TO service_role;
GRANT EXECUTE ON FUNCTION public.update_updated_at_column() TO anon;
GRANT EXECUTE ON FUNCTION public.update_updated_at_column() TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_updated_at_column() TO service_role;
GRANT EXECUTE ON FUNCTION public.guard_asset_party_ownership_sum() TO anon;
GRANT EXECUTE ON FUNCTION public.guard_asset_party_ownership_sum() TO authenticated;
GRANT EXECUTE ON FUNCTION public.guard_asset_party_ownership_sum() TO service_role;
GRANT EXECUTE ON FUNCTION public.guard_liability_party_ownership_sum() TO anon;
GRANT EXECUTE ON FUNCTION public.guard_liability_party_ownership_sum() TO authenticated;
GRANT EXECUTE ON FUNCTION public.guard_liability_party_ownership_sum() TO service_role;
GRANT EXECUTE ON FUNCTION public.auth_rate_limit_hit(p_key text, p_max integer, p_window_ms integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.finance_touch_updated_at() TO anon;
GRANT EXECUTE ON FUNCTION public.finance_touch_updated_at() TO authenticated;
GRANT EXECUTE ON FUNCTION public.finance_touch_updated_at() TO service_role;
GRANT EXECUTE ON FUNCTION public.bump_user_domain_versions(p_user_id uuid, p_domains text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.captures_set_updated_at() TO anon;
GRANT EXECUTE ON FUNCTION public.captures_set_updated_at() TO authenticated;
GRANT EXECUTE ON FUNCTION public.captures_set_updated_at() TO service_role;
GRANT EXECUTE ON FUNCTION public.enforce_linked_profiles_ownership() TO service_role;
