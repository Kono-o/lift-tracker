-- =============================================================================
-- Lift Tracker — Seed Data (Development / Demo)
-- =============================================================================
-- Run AFTER the schema is in place (supabase/migrations or setup.sql).
-- Safe to re-run: only rows named "SEED:%" created by this script are replaced.
--
-- HOW TO USE:
--   - Run the script as-is and it uses the most recently created user.
--   - Or set v_user_id to a specific auth.users.id below.
-- =============================================================================

do $$
declare
  v_user_id uuid := '00000000-0000-0000-0000-000000000000';

  v_routine        uuid;
  v_template_push  uuid;
  v_template_pull  uuid;
  v_template_full  uuid;

  v_ex_bench       uuid;
  v_ex_ohp         uuid;
  v_ex_row         uuid;
  v_ex_squat       uuid;
  v_ex_plank       uuid;
  v_ex_facepull    uuid;
begin
  if v_user_id = '00000000-0000-0000-0000-000000000000' then
    select id into v_user_id
    from auth.users
    order by created_at desc
    limit 1;

    if v_user_id is null then
      raise exception 'No users found in auth.users. Sign up through the app first.';
    end if;

    raise notice 'Using most recently created user: %', v_user_id;
  end if;

  -- ---------------------------------------------------------------------------
  -- 1. Remove previous seed rows for this user
  -- ---------------------------------------------------------------------------
  delete from public.workout_history
  where user_id = v_user_id
    and (template_name_snapshot like 'SEED:%' or workout_snapshot ? 'seed');

  delete from public.schedule
  where user_id = v_user_id
    and template_id in (
      select t.id
      from public.templates t
      join public.routines r on r.id = t.routine_id
      where r.user_id = v_user_id and r.name like 'SEED:%'
    );

  -- Routine deletion cascades to templates + routine_schedules.
  delete from public.routines
  where user_id = v_user_id and name like 'SEED:%';

  delete from public.exercises
  where user_id = v_user_id and name like 'SEED:%';

  -- ---------------------------------------------------------------------------
  -- 2. Seed exercises (routine-owned templates point at these via exercise_ids)
  -- ---------------------------------------------------------------------------
  insert into public.exercises (
    user_id, name, exercise_type,
    target_sets, target_reps, target_minutes, target_seconds,
    rest_minutes, rest_seconds, increment, current_weight
  ) values
    (v_user_id, 'SEED: Bench Press',    'reps', 4, 8,  null, null, 1, 30, 2.5, 82.5),
    (v_user_id, 'SEED: Overhead Press', 'reps', 4, 6,  null, null, 1, 30, 2.5, 55.0),
    (v_user_id, 'SEED: Bent Over Row',  'reps', 4, 8,  null, null, 1, 30, 2.5, 70.0),
    (v_user_id, 'SEED: Back Squat',     'reps', 5, 5,  null, null, 1, 30, 5.0, 100.0),
    (v_user_id, 'SEED: Face Pulls',     'reps', 3, 15, null, null, 1, 30, 1.25, 12.5),
    (v_user_id, 'SEED: Plank',          'time', 3, null, 1, 0, 0, 30, 5, null);

  select id into v_ex_bench    from public.exercises where user_id = v_user_id and name = 'SEED: Bench Press';
  select id into v_ex_ohp      from public.exercises where user_id = v_user_id and name = 'SEED: Overhead Press';
  select id into v_ex_row      from public.exercises where user_id = v_user_id and name = 'SEED: Bent Over Row';
  select id into v_ex_squat    from public.exercises where user_id = v_user_id and name = 'SEED: Back Squat';
  select id into v_ex_facepull from public.exercises where user_id = v_user_id and name = 'SEED: Face Pulls';
  select id into v_ex_plank    from public.exercises where user_id = v_user_id and name = 'SEED: Plank';

  -- ---------------------------------------------------------------------------
  -- 3. Seed routine + routine-owned templates
  -- ---------------------------------------------------------------------------
  insert into public.routines (user_id, name, display_order)
  values (
    v_user_id,
    'SEED: Push Pull Full',
    coalesce((select max(display_order) + 1 from public.routines where user_id = v_user_id), 0)
  )
  returning id into v_routine;

  insert into public.templates (routine_id, name, color, icon, display_order, exercise_ids)
  values (v_routine, 'SEED: Push', 242, 1, 0, array[v_ex_bench, v_ex_ohp, v_ex_facepull])
  returning id into v_template_push;

  insert into public.templates (routine_id, name, color, icon, display_order, exercise_ids)
  values (v_routine, 'SEED: Pull', 200, 2, 1, array[v_ex_row, v_ex_facepull])
  returning id into v_template_pull;

  insert into public.templates (routine_id, name, color, icon, display_order, exercise_ids)
  values (v_routine, 'SEED: Full Body', 160, 3, 2, array[v_ex_bench, v_ex_squat, v_ex_plank])
  returning id into v_template_full;

  -- Wednesday, Friday, Sunday are rest days.
  insert into public.routine_schedules (routine_id, day_of_week, template_id)
  values
    (v_routine, 0, null),
    (v_routine, 1, v_template_push),
    (v_routine, 2, v_template_pull),
    (v_routine, 3, null),
    (v_routine, 4, v_template_full),
    (v_routine, 5, null),
    (v_routine, 6, v_template_push)
  on conflict (routine_id, day_of_week) do update set template_id = excluded.template_id;

  -- Make the seeded routine active and materialize its week.
  update public.usernames
  set active_routine_id = v_routine
  where user_id = v_user_id;

  insert into public.schedule (user_id, day_of_week, template_id, updated_at)
  values
    (v_user_id, 0, null,            now()),
    (v_user_id, 1, v_template_push, now()),
    (v_user_id, 2, v_template_pull, now()),
    (v_user_id, 3, null,            now()),
    (v_user_id, 4, v_template_full, now()),
    (v_user_id, 5, null,            now()),
    (v_user_id, 6, v_template_push, now())
  on conflict (user_id, day_of_week) do update set
    template_id = excluded.template_id,
    updated_at = now();

  -- ---------------------------------------------------------------------------
  -- 4. Sample history (yesterday: Push, three days ago: Full Body)
  -- ---------------------------------------------------------------------------
  insert into public.exercise_personal_bests (exercise_id, user_id, best_weight, achieved_on)
  values (v_ex_bench, v_user_id, 82.5, current_date - 1)
  on conflict (exercise_id) do update set
    best_weight = greatest(public.exercise_personal_bests.best_weight, excluded.best_weight),
    achieved_on = excluded.achieved_on,
    updated_at = now();

  insert into public.workout_history (
    user_id, workout_date, template_id, template_name_snapshot,
    workout_status, is_skipped, duration_seconds, is_perfect_day,
    performance_snapshot, workout_snapshot
  ) values
    (
      v_user_id, current_date - 1, v_template_push, 'SEED: Push',
      0, false, 42 * 60, true,
      jsonb_build_object('total_volume_kg', 1240, 'total_sets', 12, 'pr_count', 1),
      jsonb_build_object(
        'seed', true,
        'exercises', jsonb_build_array(
          jsonb_build_object(
            'exercise_id', v_ex_bench,
            'name', 'SEED: Bench Press',
            'exercise_type', 'reps',
            'target_sets', 4,
            'target_reps', 8,
            'rest_minutes', 1,
            'rest_seconds', 30,
            'weight_before', 80.0,
            'weight_after', 82.5,
            'exercise_is_pr', true,
            'sets', jsonb_build_array(
              jsonb_build_object('set_number', 1, 'reps_completed', 8, 'weight', 82.5, 'is_pr', true),
              jsonb_build_object('set_number', 2, 'reps_completed', 8, 'weight', 82.5),
              jsonb_build_object('set_number', 3, 'reps_completed', 7, 'weight', 82.5),
              jsonb_build_object('set_number', 4, 'reps_completed', 8, 'weight', 82.5)
            )
          )
        )
      )
    ),
    (
      v_user_id, current_date - 3, v_template_full, 'SEED: Full Body',
      0, false, 38 * 60, false,
      jsonb_build_object('total_volume_kg', 980, 'total_sets', 9, 'pr_count', 0),
      jsonb_build_object(
        'seed', true,
        'exercises', jsonb_build_array(
          jsonb_build_object(
            'exercise_id', v_ex_bench,
            'name', 'SEED: Bench Press',
            'exercise_type', 'reps',
            'target_sets', 3,
            'target_reps', 8,
            'rest_minutes', 1,
            'rest_seconds', 30,
            'weight_before', 82.5,
            'weight_after', 82.5,
            'sets', jsonb_build_array(
              jsonb_build_object('set_number', 1, 'reps_completed', 8, 'weight', 82.5),
              jsonb_build_object('set_number', 2, 'reps_completed', 7, 'weight', 82.5),
              jsonb_build_object('set_number', 3)
            )
          )
        )
      )
    )
  on conflict (user_id, workout_date) do update set
    template_id = excluded.template_id,
    template_name_snapshot = excluded.template_name_snapshot,
    workout_status = excluded.workout_status,
    is_skipped = excluded.is_skipped,
    duration_seconds = excluded.duration_seconds,
    is_perfect_day = excluded.is_perfect_day,
    performance_snapshot = excluded.performance_snapshot,
    workout_snapshot = excluded.workout_snapshot;

  raise notice 'Seed data inserted for user %', v_user_id;
end $$;

-- Seed complete: one routine, three templates, six exercises, weekly plan,
-- and two historical workouts.
