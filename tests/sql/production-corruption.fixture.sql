-- The ACTUAL corruption the 2026-07-29 production audit found, reproduced with
-- the real row ids, user ids and profile ids read from the live database, on
-- top of the real production schema (tests/sql/production-schema.sql).
--
-- Loading the genuine identifiers (rather than invented ones) means the
-- migration is exercised against exactly the rows it will meet in production —
-- including the mirrored cross-account swap, which a symmetric hand-written
-- fixture would not naturally produce.

-- ── Accounts ────────────────────────────────────────────────────────────────
--   A = d2064ce8-527e-493c-a846-159769e81eac
--   B = 6f63cf74-ad8b-42f4-a8de-850f42219c06
--   C = 05df1674-ed60-4aad-80c6-e63eb7225a45   (the events owner)

-- ── Profiles (only the ones involved) ───────────────────────────────────────
INSERT INTO public.profiles (id, user_id, type, name) VALUES
  -- Account A
  ('4cd33a94-a612-45d6-af94-3948e181db7c','d2064ce8-527e-493c-a846-159769e81eac','self','Me'),
  ('1e0b9eef-981f-4ecc-a1ab-d33518b2bed2','d2064ce8-527e-493c-a846-159769e81eac','person','Mom'),
  ('5bca0896-3e9d-4075-8ca0-50926a4bbbe4','d2064ce8-527e-493c-a846-159769e81eac','pet','Max'),
  -- Account B
  ('dcd036ee-4050-4e4e-a1d4-c507c0e4efbe','6f63cf74-ad8b-42f4-a8de-850f42219c06','self','Bob'),
  ('e0654d9a-ab20-4e97-8357-1975dd142b53','6f63cf74-ad8b-42f4-a8de-850f42219c06','pet','Rex'),
  ('fc3a2470-1a87-4703-8897-8c7ecf68d9bb','6f63cf74-ad8b-42f4-a8de-850f42219c06','person','Mom'),
  -- Account C
  ('c0000000-0000-0000-0000-0000000000c1','05df1674-ed60-4aad-80c6-e63eb7225a45','self','C');

-- ── BLOCKER 1: the mirrored cross-account swap ──────────────────────────────
-- A's habit points at B's "Rex".
INSERT INTO public.habits (id, user_id, name, linked_profiles) VALUES
  ('32394c86-ec39-4a39-b879-ab97513e5cb4','d2064ce8-527e-493c-a846-159769e81eac',
   'Drink 8 glasses of water','["e0654d9a-ab20-4e97-8357-1975dd142b53"]'::jsonb);
-- B's tracker points at A's "Mom".
INSERT INTO public.trackers (id, user_id, name, linked_profiles) VALUES
  ('a9c97993-830e-4d4e-8f58-df368a3ed800','6f63cf74-ad8b-42f4-a8de-850f42219c06',
   'Medication - Mom','["1e0b9eef-981f-4ecc-a1ab-d33518b2bed2"]'::jsonb);

-- ── Three active events referencing profiles that no longer exist ───────────
INSERT INTO public.events (id, user_id, title, date, linked_profiles) VALUES
  ('925d615a-2344-4831-875d-5aefbca68d63','05df1674-ed60-4aad-80c6-e63eb7225a45',
   'Phone Bill - Payment Due','2026-07-01','["767cdb7d-0650-4bf3-9eef-1f33bbb42882"]'::jsonb),
  ('e9287700-6c93-46e9-8446-daf4c4b9a81e','05df1674-ed60-4aad-80c6-e63eb7225a45',
   'QAMULTI389053_oblig_self_gym - Renewal','2026-07-02','["583ed368-8708-4d8d-a17d-7e504f27e5bc"]'::jsonb),
  ('4586c507-d8fa-4a32-8428-fa6b8df29f4f','05df1674-ed60-4aad-80c6-e63eb7225a45',
   'QAMULTI389053_oblig_bob_phone - Renewal','2026-07-03','["aca3b9a8-f7f3-4bf1-b71f-ad272290db59"]'::jsonb);

-- ── Dangling refs on a SOFT-DELETED habit row (must still be cleaned, or a
--    later restore/update trips the trigger) ─────────────────────────────────
INSERT INTO public.habits (id, user_id, name, linked_profiles, deleted_at) VALUES
  ('a2222222-0000-0000-0000-00000000000a','d2064ce8-527e-493c-a846-159769e81eac',
   'Retired habit','["99999999-9999-9999-9999-999999999996"]'::jsonb, now());

-- ── text[] table with a dangling ref alongside a valid one ──────────────────
INSERT INTO public.incomes (id, user_id, description, amount, linked_profiles) VALUES
  ('e1111111-0000-0000-0000-00000000000e','d2064ce8-527e-493c-a846-159769e81eac','Salary',5000,
   ARRAY['99999999-9999-9999-9999-999999999997','4cd33a94-a612-45d6-af94-3948e181db7c']);

-- ── Legitimate same-user associations that MUST survive untouched ───────────
INSERT INTO public.tasks (id, user_id, title, linked_profiles) VALUES
  ('d1111111-0000-0000-0000-00000000000d','d2064ce8-527e-493c-a846-159769e81eac','Call Mom',
   '["1e0b9eef-981f-4ecc-a1ab-d33518b2bed2","4cd33a94-a612-45d6-af94-3948e181db7c"]'::jsonb);
INSERT INTO public.expenses (id, user_id, amount, description, linked_profiles) VALUES
  ('d2222222-0000-0000-0000-00000000000d','6f63cf74-ad8b-42f4-a8de-850f42219c06',42.50,'Vet visit',
   '["e0654d9a-ab20-4e97-8357-1975dd142b53"]'::jsonb);
INSERT INTO public.journal_entries (id, user_id, date, mood, content, linked_profiles) VALUES
  ('d3333333-0000-0000-0000-00000000000d','6f63cf74-ad8b-42f4-a8de-850f42219c06','2026-07-04','good',
   'Rex had a good day', ARRAY['e0654d9a-ab20-4e97-8357-1975dd142b53']);

-- ── Three active tracker entries on a SOFT-DELETED tracker ──────────────────
INSERT INTO public.trackers (id, user_id, name, linked_profiles, deleted_at) VALUES
  ('b2222222-0000-0000-0000-00000000000b','6f63cf74-ad8b-42f4-a8de-850f42219c06',
   'Retired tracker','[]'::jsonb, '2026-07-01T00:00:00Z');
INSERT INTO public.tracker_entries (id, user_id, tracker_id, entry_values) VALUES
  ('f1111111-0000-0000-0000-00000000000f','6f63cf74-ad8b-42f4-a8de-850f42219c06',
   'b2222222-0000-0000-0000-00000000000b','{"ounces":24}'::jsonb),
  ('f2222222-0000-0000-0000-00000000000f','6f63cf74-ad8b-42f4-a8de-850f42219c06',
   'b2222222-0000-0000-0000-00000000000b','{"ounces":16}'::jsonb),
  ('f3333333-0000-0000-0000-00000000000f','6f63cf74-ad8b-42f4-a8de-850f42219c06',
   'b2222222-0000-0000-0000-00000000000b','{"ounces":8}'::jsonb);
-- A live tracker whose entry must NOT be touched.
INSERT INTO public.trackers (id, user_id, name, linked_profiles) VALUES
  ('b3333333-0000-0000-0000-00000000000b','6f63cf74-ad8b-42f4-a8de-850f42219c06',
   'Hydration','["dcd036ee-4050-4e4e-a1d4-c507c0e4efbe"]'::jsonb);
INSERT INTO public.tracker_entries (id, user_id, tracker_id, entry_values) VALUES
  ('f4444444-0000-0000-0000-00000000000f','6f63cf74-ad8b-42f4-a8de-850f42219c06',
   'b3333333-0000-0000-0000-00000000000b','{"ounces":32}'::jsonb);
