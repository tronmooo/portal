-- Minimal fixture mirroring the production shape for linked_profiles.
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  type text,
  name text,
  deleted_at timestamptz
);

-- JSONB linked_profiles tables (subset of prod, same shape)
CREATE TABLE public.habits (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, name text,
  linked_profiles jsonb DEFAULT '[]'::jsonb, deleted_at timestamptz
);
CREATE TABLE public.trackers (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, name text,
  linked_profiles jsonb DEFAULT '[]'::jsonb, deleted_at timestamptz
);
CREATE TABLE public.events (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, title text,
  linked_profiles jsonb DEFAULT '[]'::jsonb, deleted_at timestamptz
);
CREATE TABLE public.tasks (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, title text,
  linked_profiles jsonb DEFAULT '[]'::jsonb, deleted_at timestamptz
);
-- text[] linked_profiles table (incomes / journal_entries shape)
CREATE TABLE public.incomes (
  id uuid PRIMARY KEY, user_id uuid NOT NULL, source text,
  linked_profiles text[] DEFAULT ARRAY[]::text[], deleted_at timestamptz
);

-- Two accounts, mirroring the audited pair.
-- userA = d2064ce8…, userB = 6f63cf74…
INSERT INTO public.profiles (id, user_id, type, name) VALUES
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001','self','Me'),
  ('22222222-2222-2222-2222-222222222222','aaaaaaaa-0000-0000-0000-000000000001','person','Mom'),   -- A's Mom
  ('33333333-3333-3333-3333-333333333333','bbbbbbbb-0000-0000-0000-000000000002','self','Bob'),
  ('44444444-4444-4444-4444-444444444444','bbbbbbbb-0000-0000-0000-000000000002','pet','Rex'),      -- B's Rex
  ('55555555-5555-5555-5555-555555555555','bbbbbbbb-0000-0000-0000-000000000002','person','Mom');   -- B's own Mom
-- A soft-deleted profile owned by A, for the grandfathering test.
INSERT INTO public.profiles (id, user_id, type, name, deleted_at) VALUES
  ('66666666-6666-6666-6666-666666666666','aaaaaaaa-0000-0000-0000-000000000001','person','Gone', now());

-- ── The exact audited corruption ──
-- A's habit points at B's Rex (cross-user)
INSERT INTO public.habits (id, user_id, name, linked_profiles) VALUES
  ('a1111111-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-000000000001','Drink 8 glasses of water',
   '["44444444-4444-4444-4444-444444444444"]'::jsonb);
-- B's tracker points at A's Mom (cross-user)
INSERT INTO public.trackers (id, user_id, name, linked_profiles) VALUES
  ('b1111111-0000-0000-0000-00000000000b','bbbbbbbb-0000-0000-0000-000000000002','Medication - Mom',
   '["22222222-2222-2222-2222-222222222222"]'::jsonb);
-- Events referencing profiles that no longer exist (dangling)
INSERT INTO public.events (id, user_id, title, linked_profiles) VALUES
  ('c1111111-0000-0000-0000-00000000000c','aaaaaaaa-0000-0000-0000-000000000001','Phone Bill',
   '["99999999-9999-9999-9999-999999999999"]'::jsonb),
  ('c2222222-0000-0000-0000-00000000000c','aaaaaaaa-0000-0000-0000-000000000001','Renewal',
   '["99999999-9999-9999-9999-999999999998","11111111-1111-1111-1111-111111111111"]'::jsonb);
-- A legitimate same-user association that MUST survive untouched
INSERT INTO public.tasks (id, user_id, title, linked_profiles) VALUES
  ('d1111111-0000-0000-0000-00000000000d','aaaaaaaa-0000-0000-0000-000000000001','Call Mom',
   '["22222222-2222-2222-2222-222222222222","11111111-1111-1111-1111-111111111111"]'::jsonb);
-- text[] dangling reference
INSERT INTO public.incomes (id, user_id, source, linked_profiles) VALUES
  ('e1111111-0000-0000-0000-00000000000e','aaaaaaaa-0000-0000-0000-000000000001','Salary',
   ARRAY['99999999-9999-9999-9999-999999999997','11111111-1111-1111-1111-111111111111']),
  ('e2222222-0000-0000-0000-00000000000e','bbbbbbbb-0000-0000-0000-000000000002','Freelance',
   ARRAY['33333333-3333-3333-3333-333333333333']);
-- A soft-deleted row carrying a bad link (must also be cleaned)
INSERT INTO public.habits (id, user_id, name, linked_profiles, deleted_at) VALUES
  ('a2222222-0000-0000-0000-00000000000a','aaaaaaaa-0000-0000-0000-000000000001','Old habit',
   '["99999999-9999-9999-9999-999999999996"]'::jsonb, now());
