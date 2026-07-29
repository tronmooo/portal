-- Faithful replica of the PRODUCTION schema for every table the 2026-07-29
-- audit migrations touch. Column names, types, nullability and defaults are
-- transcribed from information_schema on the live project so the migrations
-- are exercised against the real shapes — including the two `text[]`
-- linked_profiles columns and the `text` (not uuid) tracker_entries.profile_id
-- that a hand-written fixture would be likely to get wrong.
--
-- Regenerate with:
--   SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_schema='public' AND table_name IN (...) ORDER BY table_name, ordinal_position;

DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
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
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  parent_profile_id uuid,
  type_key text,
  deleted_at timestamptz
);
-- The unique index the self-profile auto-creation races against.
CREATE UNIQUE INDEX profiles_one_self_per_user ON public.profiles (user_id) WHERE (type = 'self');

CREATE TABLE public.artifacts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  content text DEFAULT ''::text,
  items jsonb DEFAULT '[]'::jsonb,
  tags jsonb DEFAULT '[]'::jsonb,
  linked_profiles jsonb DEFAULT '[]'::jsonb,
  pinned boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  metadata jsonb DEFAULT '{}'::jsonb,
  deleted_at timestamptz
);

CREATE TABLE public.documents (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  type text DEFAULT 'other'::text,
  mime_type text DEFAULT 'image/jpeg'::text,
  file_data text,
  extracted_data jsonb DEFAULT '{}'::jsonb,
  linked_profiles jsonb DEFAULT '[]'::jsonb,
  tags jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  storage_path text,
  deleted_at timestamptz,
  expiration_date text,
  superseded_by uuid,
  source_confidence real DEFAULT 0,
  auto_committed boolean DEFAULT false
);

CREATE TABLE public.events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  title text NOT NULL,
  date date NOT NULL,
  time text,
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
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE public.expenses (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  amount numeric NOT NULL,
  category text DEFAULT 'general'::text,
  description text NOT NULL,
  vendor text,
  is_recurring boolean DEFAULT false,
  linked_profiles jsonb DEFAULT '[]'::jsonb,
  tags jsonb DEFAULT '[]'::jsonb,
  date date,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz,
  source text DEFAULT 'manual'::text,
  status text DEFAULT 'active'::text,
  payment_method text
);

CREATE TABLE public.goals (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
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
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  linked_profiles jsonb DEFAULT '[]'::jsonb,
  deleted_at timestamptz
);

CREATE TABLE public.habits (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  icon text,
  color text,
  frequency text DEFAULT 'daily'::text,
  target_days jsonb DEFAULT '[]'::jsonb,
  current_streak integer DEFAULT 0,
  longest_streak integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  linked_profiles jsonb DEFAULT '[]'::jsonb,
  target_per_day integer DEFAULT 1,
  source text DEFAULT 'manual'::text,
  status text DEFAULT 'active'::text,
  deleted_at timestamptz,
  time_of_day text,
  scheduled_time text
);

-- NOTE: linked_profiles here is text[], not jsonb.
CREATE TABLE public.incomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  description text NOT NULL,
  amount numeric NOT NULL,
  category text DEFAULT 'salary'::text,
  frequency text DEFAULT 'monthly'::text,
  date text,
  source text DEFAULT 'manual'::text,
  linked_profiles text[] DEFAULT '{}'::text[],
  tags text[] DEFAULT '{}'::text[],
  deleted_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- NOTE: linked_profiles here is text[], not jsonb.
CREATE TABLE public.journal_entries (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  date date NOT NULL,
  mood text NOT NULL,
  content text DEFAULT ''::text,
  tags jsonb DEFAULT '[]'::jsonb,
  energy integer,
  gratitude jsonb DEFAULT '[]'::jsonb,
  highlights jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now(),
  linked_profiles text[] DEFAULT ARRAY[]::text[],
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE public.tasks (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  status text DEFAULT 'todo'::text,
  priority text DEFAULT 'medium'::text,
  due_date date,
  linked_profiles jsonb DEFAULT '[]'::jsonb,
  tags jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz,
  source text DEFAULT 'manual'::text
);

CREATE TABLE public.trackers (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  category text DEFAULT 'custom'::text,
  unit text,
  icon text,
  fields jsonb DEFAULT '[]'::jsonb,
  linked_profiles jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz,
  metric_definition jsonb
);

-- NOTE: profile_id is text, not uuid.
CREATE TABLE public.tracker_entries (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  tracker_id uuid NOT NULL,
  entry_values jsonb DEFAULT '{}'::jsonb,
  computed jsonb DEFAULT '{}'::jsonb,
  notes text,
  mood text,
  tags jsonb DEFAULT '[]'::jsonb,
  timestamp timestamptz DEFAULT now(),
  for_profile text,
  updated_at timestamptz DEFAULT now(),
  source text DEFAULT 'manual'::text,
  profile_id text,
  deleted_at timestamptz
);
