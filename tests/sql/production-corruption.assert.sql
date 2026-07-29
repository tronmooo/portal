\set ON_ERROR_STOP on
\pset pager off

-- Assertions against the REAL production schema + the REAL audited rows.
-- Every check raises on failure, so the script's exit code gates the runner.

\echo '--- A. the audited cross-account swap is gone ---'
DO $$
DECLARE fails text[] := '{}'; c record;
BEGIN
  FOR c IN
    SELECT 'habit 32394c86 no longer references B''s Rex' n,
           (SELECT linked_profiles FROM habits  WHERE id='32394c86-ec39-4a39-b879-ab97513e5cb4') = '[]'::jsonb p
    UNION ALL SELECT 'tracker a9c97993 no longer references A''s Mom',
           (SELECT linked_profiles FROM trackers WHERE id='a9c97993-830e-4d4e-8f58-df368a3ed800') = '[]'::jsonb
    UNION ALL SELECT 'event 925d615a dangling ref cleared',
           (SELECT linked_profiles FROM events WHERE id='925d615a-2344-4831-875d-5aefbca68d63') = '[]'::jsonb
    UNION ALL SELECT 'event e9287700 dangling ref cleared',
           (SELECT linked_profiles FROM events WHERE id='e9287700-6c93-46e9-8446-daf4c4b9a81e') = '[]'::jsonb
    UNION ALL SELECT 'event 4586c507 dangling ref cleared',
           (SELECT linked_profiles FROM events WHERE id='4586c507-d8fa-4a32-8428-fa6b8df29f4f') = '[]'::jsonb
    UNION ALL SELECT 'soft-deleted habit row also cleaned',
           (SELECT linked_profiles FROM habits WHERE id='a2222222-0000-0000-0000-00000000000a') = '[]'::jsonb
    UNION ALL SELECT 'incomes text[] pruned to just the valid id',
           (SELECT linked_profiles FROM incomes WHERE id='e1111111-0000-0000-0000-00000000000e')
             = ARRAY['4cd33a94-a612-45d6-af94-3948e181db7c']
  LOOP
    IF c.p IS DISTINCT FROM true THEN fails := fails || c.n; ELSE RAISE NOTICE 'PASS: %', c.n; END IF;
  END LOOP;
  IF array_length(fails,1) > 0 THEN RAISE EXCEPTION 'FAIL: %', array_to_string(fails, '; '); END IF;
END $$;

\echo ''
\echo '--- B. legitimate same-user data untouched (no collateral damage) ---'
DO $$
DECLARE fails text[] := '{}'; c record;
BEGIN
  FOR c IN
    SELECT 'task keeps BOTH same-user profile links' n,
           (SELECT linked_profiles FROM tasks WHERE id='d1111111-0000-0000-0000-00000000000d')
             = '["1e0b9eef-981f-4ecc-a1ab-d33518b2bed2","4cd33a94-a612-45d6-af94-3948e181db7c"]'::jsonb p
    UNION ALL SELECT 'expense keeps its owner''s pet link',
           (SELECT linked_profiles FROM expenses WHERE id='d2222222-0000-0000-0000-00000000000d')
             = '["e0654d9a-ab20-4e97-8357-1975dd142b53"]'::jsonb
    UNION ALL SELECT 'journal text[] link preserved',
           (SELECT linked_profiles FROM journal_entries WHERE id='d3333333-0000-0000-0000-00000000000d')
             = ARRAY['e0654d9a-ab20-4e97-8357-1975dd142b53']
    UNION ALL SELECT 'live tracker keeps its link',
           (SELECT linked_profiles FROM trackers WHERE id='b3333333-0000-0000-0000-00000000000b')
             = '["dcd036ee-4050-4e4e-a1d4-c507c0e4efbe"]'::jsonb
    UNION ALL SELECT 'no profile rows were deleted',
           (SELECT COUNT(*) FROM profiles) = 7
  LOOP
    IF c.p IS DISTINCT FROM true THEN fails := fails || c.n; ELSE RAISE NOTICE 'PASS: %', c.n; END IF;
  END LOOP;
  IF array_length(fails,1) > 0 THEN RAISE EXCEPTION 'FAIL: %', array_to_string(fails, '; '); END IF;
END $$;

\echo ''
\echo '--- C. the exact audited attack is now rejected ---'
DO $$
BEGIN
  -- Re-create the original defect: account A linking account B''s Rex.
  UPDATE public.habits
     SET linked_profiles = '["e0654d9a-ab20-4e97-8357-1975dd142b53"]'::jsonb
   WHERE id='32394c86-ec39-4a39-b879-ab97513e5cb4';
  RAISE EXCEPTION 'FAIL: the audited cross-account link was accepted again';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: re-creating the audited cross-account link is rejected';
END $$;

DO $$
BEGIN
  INSERT INTO public.trackers (id, user_id, name, linked_profiles)
  VALUES (gen_random_uuid(),'6f63cf74-ad8b-42f4-a8de-850f42219c06','Medication - Mom',
          '["1e0b9eef-981f-4ecc-a1ab-d33518b2bed2"]'::jsonb);
  RAISE EXCEPTION 'FAIL: cross-account tracker INSERT was accepted';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: cross-account tracker INSERT rejected';
END $$;

\echo ''
\echo '--- D. legitimate writes still work after the guard is installed ---'
DO $$
BEGIN
  -- The correct association for that tracker: B''s OWN "Mom" profile.
  UPDATE public.trackers
     SET linked_profiles = '["fc3a2470-1a87-4703-8897-8c7ecf68d9bb"]'::jsonb
   WHERE id='a9c97993-830e-4d4e-8f58-df368a3ed800';
  INSERT INTO public.habits (id, user_id, name, linked_profiles)
  VALUES (gen_random_uuid(),'d2064ce8-527e-493c-a846-159769e81eac','Walk Max',
          '["5bca0896-3e9d-4075-8ca0-50926a4bbbe4"]'::jsonb);
  INSERT INTO public.incomes (id, user_id, description, amount, linked_profiles)
  VALUES (gen_random_uuid(),'d2064ce8-527e-493c-a846-159769e81eac','Bonus',1000,
          ARRAY['4cd33a94-a612-45d6-af94-3948e181db7c']);
  RAISE NOTICE 'PASS: same-user writes accepted across jsonb and text[] tables';
END $$;

\echo ''
\echo '--- E. tracker entries no longer orphaned on soft-deleted trackers ---'
DO $$
DECLARE fails text[] := '{}'; c record;
BEGIN
  FOR c IN
    SELECT 'all 3 entries on the retired tracker are retired' n,
           (SELECT COUNT(*) FROM tracker_entries
             WHERE tracker_id='b2222222-0000-0000-0000-00000000000b' AND deleted_at IS NOT NULL) = 3 p
    UNION ALL SELECT 'the live tracker''s entry is untouched',
           (SELECT deleted_at IS NULL FROM tracker_entries WHERE id='f4444444-0000-0000-0000-00000000000f')
    UNION ALL SELECT 'no live entry references a soft-deleted tracker',
           (SELECT COUNT(*) FROM tracker_entries te JOIN trackers t ON t.id=te.tracker_id
             WHERE te.deleted_at IS NULL AND t.deleted_at IS NOT NULL) = 0
  LOOP
    IF c.p IS DISTINCT FROM true THEN fails := fails || c.n; ELSE RAISE NOTICE 'PASS: %', c.n; END IF;
  END LOOP;
  IF array_length(fails,1) > 0 THEN RAISE EXCEPTION 'FAIL: %', array_to_string(fails, '; '); END IF;
END $$;

\echo ''
\echo '--- F. soft-deleting a tracker now cascades to its entries ---'
DO $$
BEGIN
  UPDATE public.trackers SET deleted_at = now() WHERE id='b3333333-0000-0000-0000-00000000000b';
  IF (SELECT deleted_at IS NULL FROM tracker_entries WHERE id='f4444444-0000-0000-0000-00000000000f') THEN
    RAISE EXCEPTION 'FAIL: entry was not retired with its tracker';
  END IF;
  RAISE NOTICE 'PASS: retiring a tracker retires its entries';
  UPDATE public.trackers SET deleted_at = NULL WHERE id='b3333333-0000-0000-0000-00000000000b';
  IF (SELECT deleted_at IS NOT NULL FROM tracker_entries WHERE id='f4444444-0000-0000-0000-00000000000f') THEN
    RAISE EXCEPTION 'FAIL: entry was not restored with its tracker';
  END IF;
  RAISE NOTICE 'PASS: restoring a tracker restores its entries';
END $$;

\echo ''
\echo '--- G. the self-profile unique index still holds (the audited race) ---'
DO $$
BEGIN
  INSERT INTO public.profiles (id, user_id, type, name)
  VALUES (gen_random_uuid(),'d2064ce8-527e-493c-a846-159769e81eac','self','Me again');
  RAISE EXCEPTION 'FAIL: a second self profile was allowed';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'PASS: second self profile rejected with SQLSTATE 23505 (%)', SQLSTATE;
END $$;
