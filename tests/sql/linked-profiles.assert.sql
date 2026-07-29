\set ON_ERROR_STOP on
\pset pager off

-- ═══ POST-CLEANUP STATE ═══
\echo '--- 1. cross-user + dangling links pruned, legitimate links preserved ---'
DO $$
DECLARE
  failures text[] := '{}';
  chk record;
BEGIN
  FOR chk IN
    SELECT 'habits(cross-user cleared)' AS name,
           (SELECT linked_profiles::text FROM habits WHERE id='a1111111-0000-0000-0000-00000000000a') = '[]' AS pass
    UNION ALL SELECT 'trackers(cross-user cleared)',
           (SELECT linked_profiles::text FROM trackers WHERE id='b1111111-0000-0000-0000-00000000000b') = '[]'
    UNION ALL SELECT 'events(dangling cleared)',
           (SELECT linked_profiles::text FROM events WHERE id='c1111111-0000-0000-0000-00000000000c') = '[]'
    UNION ALL SELECT 'events(partial prune keeps valid)',
           (SELECT linked_profiles FROM events WHERE id='c2222222-0000-0000-0000-00000000000c')
             = '["11111111-1111-1111-1111-111111111111"]'::jsonb
    UNION ALL SELECT 'tasks(legit 2-link untouched)',
           (SELECT linked_profiles FROM tasks WHERE id='d1111111-0000-0000-0000-00000000000d')
             = '["22222222-2222-2222-2222-222222222222","11111111-1111-1111-1111-111111111111"]'::jsonb
    UNION ALL SELECT 'incomes(text[] partial prune)',
           (SELECT linked_profiles FROM incomes WHERE id='e1111111-0000-0000-0000-00000000000e')
             = ARRAY['11111111-1111-1111-1111-111111111111']
    UNION ALL SELECT 'incomes(text[] valid untouched)',
           (SELECT linked_profiles FROM incomes WHERE id='e2222222-0000-0000-0000-00000000000e')
             = ARRAY['33333333-3333-3333-3333-333333333333']
    UNION ALL SELECT 'habits(soft-deleted row also cleaned)',
           (SELECT linked_profiles::text FROM habits WHERE id='a2222222-0000-0000-0000-00000000000a') = '[]'
  LOOP
    IF chk.pass IS DISTINCT FROM true THEN
      failures := failures || chk.name;
    ELSE
      RAISE NOTICE 'PASS: %', chk.name;
    END IF;
  END LOOP;

  IF array_length(failures, 1) > 0 THEN
    RAISE EXCEPTION 'FAIL: %', array_to_string(failures, ', ');
  END IF;
END $$;

-- ═══ REQUIRED TEST: cross-account INSERT must fail ═══
\echo ''
\echo '--- 2. cross-account INSERT rejected ---'
DO $$
BEGIN
  INSERT INTO public.habits (id, user_id, name, linked_profiles)
  VALUES ('f0000000-0000-0000-0000-00000000000f','aaaaaaaa-0000-0000-0000-000000000001','Sneaky',
          '["44444444-4444-4444-4444-444444444444"]'::jsonb);
  RAISE EXCEPTION 'FAIL: cross-account INSERT was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: cross-account INSERT rejected (%)', SQLERRM;
END $$;

-- ═══ REQUIRED TEST: cross-account UPDATE must fail ═══
\echo '--- 3. cross-account UPDATE rejected ---'
DO $$
BEGIN
  UPDATE public.tasks SET linked_profiles = '["44444444-4444-4444-4444-444444444444"]'::jsonb
  WHERE id='d1111111-0000-0000-0000-00000000000d';
  RAISE EXCEPTION 'FAIL: cross-account UPDATE was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: cross-account UPDATE rejected (%)', SQLERRM;
END $$;

-- ═══ REQUIRED TEST: legitimate same-user associations keep working ═══
\echo '--- 4. legitimate same-user INSERT/UPDATE still work ---'
DO $$
BEGIN
  INSERT INTO public.habits (id, user_id, name, linked_profiles)
  VALUES ('f1000000-0000-0000-0000-00000000000f','aaaaaaaa-0000-0000-0000-000000000001','Legit',
          '["22222222-2222-2222-2222-222222222222"]'::jsonb);
  UPDATE public.habits SET linked_profiles =
    '["22222222-2222-2222-2222-222222222222","11111111-1111-1111-1111-111111111111"]'::jsonb
  WHERE id='f1000000-0000-0000-0000-00000000000f';
  RAISE NOTICE 'PASS: same-user INSERT + UPDATE accepted';
END $$;

-- ═══ dangling reference rejected ═══
\echo '--- 5. INSERT referencing a nonexistent profile rejected ---'
DO $$
BEGIN
  INSERT INTO public.events (id, user_id, title, linked_profiles)
  VALUES ('f2000000-0000-0000-0000-00000000000f','aaaaaaaa-0000-0000-0000-000000000001','Ghost',
          '["99999999-9999-9999-9999-999999999999"]'::jsonb);
  RAISE EXCEPTION 'FAIL: dangling reference was allowed';
EXCEPTION WHEN foreign_key_violation THEN
  RAISE NOTICE 'PASS: dangling reference rejected (%)', SQLERRM;
END $$;

-- ═══ newly linking a SOFT-DELETED profile rejected ═══
\echo '--- 6. adding a link to a soft-deleted profile rejected ---'
DO $$
BEGIN
  INSERT INTO public.tasks (id, user_id, title, linked_profiles)
  VALUES ('f3000000-0000-0000-0000-00000000000f','aaaaaaaa-0000-0000-0000-000000000001','Dead link',
          '["66666666-6666-6666-6666-666666666666"]'::jsonb);
  RAISE EXCEPTION 'FAIL: link to soft-deleted profile was allowed';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS: link to soft-deleted profile rejected (%)', SQLERRM;
END $$;

-- ═══ GRANDFATHERING: soft-deleting a profile must not brick unrelated updates ═══
\echo '--- 7. unrelated UPDATE still works after a linked profile is soft-deleted ---'
DO $$
BEGIN
  -- task d111… legitimately links profile 2222…; now retire that profile.
  UPDATE public.profiles SET deleted_at = now()
   WHERE id='22222222-2222-2222-2222-222222222222';
  -- Renaming the task must still succeed even though a link is now inactive.
  UPDATE public.tasks SET title = 'Call Mom (renamed)'
   WHERE id='d1111111-0000-0000-0000-00000000000d';
  -- Even a same-set rewrite of linked_profiles must succeed (no new links).
  UPDATE public.tasks SET linked_profiles = linked_profiles
   WHERE id='d1111111-0000-0000-0000-00000000000d';
  RAISE NOTICE 'PASS: grandfathered links do not block unrelated updates';
  UPDATE public.profiles SET deleted_at = NULL
   WHERE id='22222222-2222-2222-2222-222222222222';
END $$;

-- ═══ text[] table enforced too ═══
\echo '--- 8. text[] table (incomes) enforces cross-user too ---'
DO $$
BEGIN
  INSERT INTO public.incomes (id, user_id, source, linked_profiles)
  VALUES ('f4000000-0000-0000-0000-00000000000f','aaaaaaaa-0000-0000-0000-000000000001','Bad',
          ARRAY['44444444-4444-4444-4444-444444444444']);
  RAISE EXCEPTION 'FAIL: cross-user text[] link was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS: cross-user text[] link rejected';
END $$;

-- ═══ empty / null arrays are fine ═══
\echo '--- 9. empty and null linked_profiles accepted ---'
DO $$
BEGIN
  INSERT INTO public.habits (id, user_id, name, linked_profiles)
  VALUES ('f5000000-0000-0000-0000-00000000000f','aaaaaaaa-0000-0000-0000-000000000001','Empty','[]'::jsonb);
  INSERT INTO public.habits (id, user_id, name, linked_profiles)
  VALUES ('f6000000-0000-0000-0000-00000000000f','aaaaaaaa-0000-0000-0000-000000000001','Null',NULL);
  RAISE NOTICE 'PASS: empty/null linked_profiles accepted';
END $$;

-- ═══ idempotency: re-running the migration is a no-op ═══
