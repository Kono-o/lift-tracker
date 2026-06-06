-- =============================================================================
-- Lift Tracker — Seed Data (Development / Demo)
-- =============================================================================
-- Run this AFTER supabase/setup.sql
--
-- This script is SAFE TO RE-RUN.
-- It cleans up previous seed data for the given user, then re-inserts fresh data.
--
-- HOW TO USE:
--   - Just run the script.
--   - If you have at least one user in auth.users, it will automatically
--     use the most recently created one.
--   - If you want a specific user, replace the UUID below.
--
-- The "SEED:" prefix is used so the script can safely delete only its own data
-- when re-run.
-- =============================================================================

do $$
declare
  -- Optional: replace with a specific auth.users.id if you have multiple users
  v_user_id uuid := '00000000-0000-0000-0000-000000000000';

  v_template_push  uuid;
  v_template_pull  uuid;
  v_template_full  uuid;

  v_ex_bench     uuid;
  v_ex_ohp       uuid;
  v_ex_row       uuid;
  v_ex_squat     uuid;
  v_ex_plank     uuid;
  v_ex_facepull  uuid;
begin

  -- If placeholder is still present, auto-pick the most recent user
  if v_user_id = '00000000-0000-0000-0000-000000000000' then
    select id into v_user_id 
    from auth.users 
    order by created_at desc 
    limit 1;

    if v_user_id is null then
      raise exception 'No users found in auth.users. Please sign up through the app first.';
    end if;

    raise notice 'No user ID provided — automatically using most recently created user: %', v_user_id;
  end if;

  -- ---------------------------------------------------------------------------
  -- 1. Clean up previous seed data for this user (idempotent re-run)
  -- ---------------------------------------------------------------------------
  delete from public.workout_history
  where user_id = v_user_id
    and (template_name_snapshot like 'SEED:%' or workout_snapshot ? 'seed');

  delete from public.schedule
  where user_id = v_user_id;

  delete from public.template_exercises
  where user_id = v_user_id
    and template_id in (
      select id from public.templates 
      where user_id = v_user_id and name like 'SEED:%'
    );

  delete from public.templates
  where user_id = v_user_id and name like 'SEED:%';

  delete from public.exercises
  where user_id = v_user_id and name like 'SEED:%';

  -- ---------------------------------------------------------------------------
  -- 2. Create seed exercises (mix of strength + one time-based)
  -- ---------------------------------------------------------------------------
  insert into public.exercises (
    id, user_id, name, exercise_type,
    target_sets, target_reps, target_minutes, target_seconds,
    increment, current_weight
  ) values
    (gen_random_uuid(), v_user_id, 'SEED: Bench Press',     'reps', 4, 8, 0, 0, 2.5, 82.5),
    (gen_random_uuid(), v_user_id, 'SEED: Overhead Press',  'reps', 4, 6, 0, 0, 2.5, 55.0),
    (gen_random_uuid(), v_user_id, 'SEED: Bent Over Row',   'reps', 4, 8, 0, 0, 2.5, 70.0),
    (gen_random_uuid(), v_user_id, 'SEED: Back Squat',      'reps', 5, 5, 0, 0, 5.0, 100.0),
    (gen_random_uuid(), v_user_id, 'SEED: Face Pulls',      'reps', 3, 15, 0, 0, 1.25, 12.5),
    (gen_random_uuid(), v_user_id, 'SEED: Plank',           'time', 3, 0, 1, 0, 5, null)
  returning id into v_ex_bench;   -- we only need one for later reference, but we'll fetch others

  -- Fetch the ids we just created so we can link them cleanly
  select id into v_ex_bench     from public.exercises where user_id = v_user_id and name = 'SEED: Bench Press';
  select id into v_ex_ohp       from public.exercises where user_id = v_user_id and name = 'SEED: Overhead Press';
  select id into v_ex_row       from public.exercises where user_id = v_user_id and name = 'SEED: Bent Over Row';
  select id into v_ex_squat     from public.exercises where user_id = v_user_id and name = 'SEED: Back Squat';
  select id into v_ex_plank     from public.exercises where user_id = v_user_id and name = 'SEED: Plank';
  select id into v_ex_facepull  from public.exercises where user_id = v_user_id and name = 'SEED: Face Pulls';

  -- ---------------------------------------------------------------------------
  -- 3. Create seed templates (demonstrates exercise sharing across templates)
  -- ---------------------------------------------------------------------------
  insert into public.templates (id, user_id, name) values
    (gen_random_uuid(), v_user_id, 'SEED: Push')       returning id into v_template_push;
  insert into public.templates (id, user_id, name) values
    (gen_random_uuid(), v_user_id, 'SEED: Pull')       returning id into v_template_pull;
  insert into public.templates (id, user_id, name) values
    (gen_random_uuid(), v_user_id, 'SEED: Full Body')  returning id into v_template_full;

  -- Push template
  insert into public.template_exercises (template_id, exercise_id, user_id, display_order) values
    (v_template_push, v_ex_bench,    v_user_id, 0),
    (v_template_push, v_ex_ohp,      v_user_id, 1),
    (v_template_push, v_ex_facepull, v_user_id, 2);

  -- Pull template
  insert into public.template_exercises (template_id, exercise_id, user_id, display_order) values
    (v_template_pull, v_ex_row,      v_user_id, 0),
    (v_template_pull, v_ex_facepull, v_user_id, 1);

  -- Full Body template — reuses Bench Press to demonstrate shared exercise + progressive overload
  insert into public.template_exercises (template_id, exercise_id, user_id, display_order) values
    (v_template_full, v_ex_bench,  v_user_id, 0),
    (v_template_full, v_ex_squat,  v_user_id, 1),
    (v_template_full, v_ex_plank,  v_user_id, 2);

  -- ---------------------------------------------------------------------------
  -- 4. Weekly schedule (example)
  -- ---------------------------------------------------------------------------
  insert into public.schedule (user_id, day_of_week, template_id, updated_at) values
    (v_user_id, 1, v_template_push,  now()),   -- Monday
    (v_user_id, 2, v_template_pull,  now()),   -- Tuesday
    (v_user_id, 3, null,             now()),   -- Wednesday (rest)
    (v_user_id, 4, v_template_full,  now()),   -- Thursday
    (v_user_id, 5, null,             now()),   -- Friday (rest)
    (v_user_id, 6, v_template_push,  now()),   -- Saturday
    (v_user_id, 0, null,             now());   -- Sunday (rest)

  -- ---------------------------------------------------------------------------
  -- 5. Some sample workout history (last few days)
  --    Uses realistic looking snapshots so the UI has something to display.
  -- ---------------------------------------------------------------------------
  insert into public.workout_history (
    user_id,
    workout_date,
    template_id,
    template_name_snapshot,
    is_skipped,
    duration_seconds,
    is_perfect_day,
    performance_snapshot,
    workout_snapshot
  ) values
    -- Yesterday - Push (perfect day)
    (
      v_user_id,
      current_date - 1,
      v_template_push,
      'SEED: Push',
      false,
      42 * 60,
      true,
      jsonb_build_object(
        'total_volume_kg', 1240,
        'total_sets', 12,
        'pr_count', 1,
        'reps', jsonb_build_object(
          v_ex_bench || '-0', 8, v_ex_bench || '-1', 8, v_ex_bench || '-2', 7, v_ex_bench || '-3', 8,
          v_ex_ohp  || '-0', 6, v_ex_ohp  || '-1', 6, v_ex_ohp  || '-2', 5, v_ex_ohp  || '-3', 6,
          v_ex_facepull || '-0', 15, v_ex_facepull || '-1', 15, v_ex_facepull || '-2', 15
        )
      ),
      jsonb_build_object(
        'seed', true,
        'template_name', 'SEED: Push',
        'duration_seconds', 42 * 60,
        'is_perfect_day', true,
        'exercises', jsonb_build_array(
          jsonb_build_object(
            'exercise_id', v_ex_bench,
            'name', 'SEED: Bench Press',
            'exercise_type', 'reps',
            'target_sets', 4,
            'target_reps', 8,
            'weight_before', 80.0,
            'weight_after', 82.5,
            'sets', jsonb_build_array(
              jsonb_build_object('set_number',1,'reps_completed',8,'weight',82.5,'is_pr',false),
              jsonb_build_object('set_number',2,'reps_completed',8,'weight',82.5,'is_pr',false),
              jsonb_build_object('set_number',3,'reps_completed',7,'weight',82.5,'is_pr',false),
              jsonb_build_object('set_number',4,'reps_completed',8,'weight',82.5,'is_pr',false)
            )
          )
          -- (abbreviated for seed — the UI will still render the rest reasonably)
        )
      )
    ),

    -- 3 days ago - Full Body (partial)
    (
      v_user_id,
      current_date - 3,
      v_template_full,
      'SEED: Full Body',
      false,
      38 * 60,
      false,
      jsonb_build_object(
        'total_volume_kg', 980,
        'total_sets', 9,
        'pr_count', 0,
        'reps', jsonb_build_object(
          v_ex_bench || '-0', 8, v_ex_bench || '-1', 7,
          v_ex_squat || '-0', 5, v_ex_squat || '-1', 5, v_ex_squat || '-2', 4,
          v_ex_plank || '-0', null, v_ex_plank || '-1', null
        )
      ),
      jsonb_build_object(
        'seed', true,
        'template_name', 'SEED: Full Body',
        'duration_seconds', 38 * 60,
        'is_perfect_day', false,
        'exercises', jsonb_build_array(
          jsonb_build_object(
            'exercise_id', v_ex_bench,
            'name', 'SEED: Bench Press',
            'exercise_type', 'reps',
            'target_sets', 3,
            'target_reps', 8,
            'weight_before', 82.5,
            'weight_after', 82.5,
            'sets', jsonb_build_array(
              jsonb_build_object('set_number',1,'reps_completed',8,'weight',82.5,'is_pr',false),
              jsonb_build_object('set_number',2,'reps_completed',7,'weight',82.5,'is_pr',false),
              jsonb_build_object('set_number',3,'reps_completed',null,'weight',null,'is_pr',false)
            )
          )
        )
      )
    );

  raise notice 'Seed data inserted for user %', v_user_id;

end $$;

-- =============================================================================
-- Seed complete.
-- You should now see:
--   - 3 templates (Push, Pull, Full Body) with some shared exercises
--   - A weekly schedule
--   - A couple of historical workouts
-- =============================================================================
