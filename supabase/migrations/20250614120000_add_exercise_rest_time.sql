-- Add rest time (minutes + seconds) to exercises. Applies to both reps and time type exercises.
-- Defaults to 0 (no rest specified / user can set per exercise).
-- This migration also updates the supporting RPCs so that rest times are properly saved
-- per-exercise and included in workout snapshots.

ALTER TABLE public.exercises
  ADD COLUMN IF NOT EXISTS rest_minutes smallint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rest_seconds smallint DEFAULT 0;

-- The existing type-specific constraints on target_* fields are unaffected.
-- Rest columns are always populated (0 allowed for both exercise types).

-- Update the save function to handle rest_minutes/rest_seconds from the JSON payload
-- and persist them on insert/update.
create or replace function public.save_template_exercises(
  p_template_id uuid,
  p_exercises jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  ex jsonb;
  v_ex_id uuid;
  v_ex_type text;
  v_ex_name text;
  v_target_sets smallint;
  v_target_reps smallint;
  v_target_minutes smallint;
  v_target_seconds smallint;
  v_rest_minutes smallint;
  v_rest_seconds smallint;
  v_increment real;
  v_current_weight real;
  saved_ids uuid[] := '{}';
  ord smallint := 0;
  result jsonb := '[]'::jsonb;
  row public.exercises;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  if not exists (
    select 1 from public.templates t
    where t.id = p_template_id and t.user_id = uid
  ) then
    raise exception 'Template not found';
  end if;

  if coalesce(jsonb_array_length(p_exercises), 0) = 0 then
    delete from public.template_exercises
    where template_id = p_template_id and user_id = uid;
    return '[]'::jsonb;
  end if;

  for ex in select * from jsonb_array_elements(p_exercises)
  loop
    v_ex_type := coalesce(ex->>'exercise_type', 'reps');
    if v_ex_type not in ('reps', 'time') then
      raise exception 'Invalid exercise type';
    end if;

    v_ex_name := upper(trim(coalesce(ex->>'name', 'EXERCISE')));
    if char_length(v_ex_name) = 0 then
      raise exception 'Exercise name required';
    end if;
    if char_length(v_ex_name) > 24 then
      v_ex_name := left(v_ex_name, 24);
    end if;

    v_target_sets := least(12, greatest(0, coalesce((ex->>'target_sets')::int, 0)));

    if v_ex_type = 'reps' then
      v_target_reps := least(999, greatest(1, coalesce((ex->>'target_reps')::int, 1)));
      v_target_minutes := null;
      v_target_seconds := null;
      v_increment := least(500::real, greatest(0::real, coalesce((ex->>'increment')::real, 0)));
      v_current_weight := case
        when ex->>'current_weight' is null or btrim(ex->>'current_weight') = '' then null
        else least(500::real, greatest(0::real, (ex->>'current_weight')::real))
      end;
    else
      v_target_reps := null;
      v_target_minutes := least(99, greatest(0, coalesce((ex->>'target_minutes')::int, 0)));
      v_target_seconds := least(59, greatest(0, coalesce((ex->>'target_seconds')::int, 0)));
      v_increment := least(1000::real, greatest(1::real, coalesce((ex->>'increment')::real, 5)));
      v_current_weight := null;
    end if;

    v_rest_minutes := least(99, greatest(0, coalesce((ex->>'rest_minutes')::int, 0)));
    v_rest_seconds := least(59, greatest(0, coalesce((ex->>'rest_seconds')::int, 0)));

    v_ex_id := null;
    begin
      if ex->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         and not (ex->>'id') like 'temp-%' then
        v_ex_id := (ex->>'id')::uuid;
      end if;
    exception when others then
      v_ex_id := null;
    end;

    if v_ex_id is not null and exists (
      select 1 from public.exercises e
      where e.id = v_ex_id and e.user_id = uid
    ) then
      update public.exercises set
        name = v_ex_name,
        exercise_type = v_ex_type,
        target_sets = v_target_sets,
        target_reps = v_target_reps,
        target_minutes = v_target_minutes,
        target_seconds = v_target_seconds,
        rest_minutes = v_rest_minutes,
        rest_seconds = v_rest_seconds,
        increment = v_increment,
        current_weight = v_current_weight
      where id = v_ex_id and user_id = uid
      returning * into row;
    else
      insert into public.exercises (
        user_id, name, exercise_type, target_sets, target_reps,
        target_minutes, target_seconds, rest_minutes, rest_seconds, increment, current_weight
      ) values (
        uid, v_ex_name, v_ex_type, v_target_sets, v_target_reps,
        v_target_minutes, v_target_seconds, v_rest_minutes, v_rest_seconds, v_increment, v_current_weight
      )
      returning * into row;
      v_ex_id := row.id;
    end if;

    saved_ids := array_append(saved_ids, v_ex_id);

    insert into public.template_exercises (template_id, exercise_id, user_id, display_order)
    values (p_template_id, v_ex_id, uid, ord)
    on conflict (template_id, exercise_id) do update set
      display_order = excluded.display_order;

    result := result || jsonb_build_array(
      to_jsonb(row) || jsonb_build_object('display_order', ord)
    );
    ord := ord + 1;
  end loop;

  delete from public.template_exercises te
  where te.template_id = p_template_id
    and te.user_id = uid
    and not (te.exercise_id = any(saved_ids));

  return result;
end;
$$;

-- Update the complete workout function to include per-exercise rest times
-- in the stored workout_snapshot (for historical display and future use).
create or replace function public.complete_workout_session(
  p_workout_date date,
  p_template_id uuid,
  p_template_name text,
  p_duration_seconds integer,
  p_reps jsonb,
  p_times jsonb,
  p_exercises jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  ex jsonb;
  ex_id uuid;
  ex_type text;
  target_sets int;
  target_reps int;
  target_secs int;
  current_weight real;
  increment_val real;
  all_time_best real;
  s int;
  key text;
  raw_rep text;
  rep_val int;
  raw_time text;
  time_secs int;
  hit_target boolean;
  set_is_pr boolean;
  success boolean;
  ex_sets jsonb;
  set_el jsonb;
  snap_exercises jsonb := '[]'::jsonb;
  total_volume numeric := 0;
  total_sets int := 0;
  pr_count int := 0;
  reps_ex_count int := 0;
  exercise_is_pr boolean;
  next_weight real;
  is_perfect boolean;
  workout_row public.workout_history;
  updated_exercises jsonb := '[]'::jsonb;
  session_best real;
  any_set_pr boolean;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;
  if p_duration_seconds is null or p_duration_seconds < 1 then
    raise exception 'Invalid duration';
  end if;

  for ex in select value from jsonb_array_elements(coalesce(p_exercises, '[]'::jsonb))
  loop
    ex_id := (ex->>'id')::uuid;
    ex_type := ex->>'exercise_type';
    target_sets := coalesce((ex->>'target_sets')::int, 0);
    ex_sets := '[]'::jsonb;

    if ex_type = 'reps' then
      reps_ex_count := reps_ex_count + 1;
      target_reps := coalesce((ex->>'target_reps')::int, 0);
      current_weight := coalesce((ex->>'current_weight')::real, 0);
      increment_val := coalesce((ex->>'increment')::real, 0);

      select coalesce(epb.best_weight, 0)
      into all_time_best
      from public.exercise_personal_bests epb
      where epb.exercise_id = ex_id;
      if not found then
        all_time_best := 0;
      end if;

      success := target_sets > 0;
      exercise_is_pr := false;
      any_set_pr := false;

      for s in 0..(target_sets - 1) loop
        key := ex_id::text || '-' || s::text;
        raw_rep := p_reps->>key;
        rep_val := null;
        if raw_rep is not null and raw_rep ~ '^-?\d+$' then
          rep_val := raw_rep::int;
          if rep_val <= 0 then
            rep_val := null;
          end if;
        end if;

        hit_target := rep_val is not null and rep_val >= target_reps;
        set_is_pr := hit_target and current_weight > all_time_best;
        if set_is_pr then
          any_set_pr := true;
        end if;
        if rep_val is null or rep_val < target_reps then
          success := false;
        end if;

        if rep_val is not null then
          total_volume := total_volume + (rep_val * current_weight);
          total_sets := total_sets + 1;
        end if;

        set_el := jsonb_build_object('set_number', s + 1);
        if rep_val is not null then
          set_el := set_el || jsonb_build_object(
            'reps_completed', rep_val,
            'weight', current_weight
          );
        end if;
        if set_is_pr then
          set_el := set_el || jsonb_build_object('is_pr', true);
        end if;
        ex_sets := ex_sets || jsonb_build_array(set_el);
      end loop;

      if target_sets = 0 then
        success := false;
      end if;

      exercise_is_pr := success and any_set_pr;
      if exercise_is_pr then
        pr_count := pr_count + 1;
      end if;

      if success then
        next_weight := round((current_weight + increment_val)::numeric, 1);
      else
        next_weight := current_weight;
      end if;

      update public.exercises
      set current_weight = next_weight
      where id = ex_id
        and user_id = uid;

      updated_exercises := updated_exercises || jsonb_build_array(
        jsonb_build_object('id', ex_id, 'current_weight', next_weight)
      );

      session_best := 0;
      for set_el in select value from jsonb_array_elements(ex_sets)
      loop
        if (set_el->>'reps_completed') is not null
           and (set_el->>'reps_completed')::int >= target_reps then
          session_best := greatest(session_best, current_weight);
        end if;
      end loop;

      if session_best > all_time_best then
        insert into public.exercise_personal_bests (
          exercise_id,
          user_id,
          best_weight,
          achieved_on,
          updated_at
        ) values (
          ex_id,
          uid,
          session_best,
          p_workout_date,
          now()
        )
        on conflict (exercise_id) do update set
          best_weight = excluded.best_weight,
          achieved_on = excluded.achieved_on,
          updated_at = now();
      end if;

      set_el := jsonb_build_object(
        'exercise_id', ex_id,
        'name', ex->>'name',
        'exercise_type', 'reps',
        'target_sets', target_sets,
        'target_reps', target_reps,
        'rest_minutes', coalesce((ex->>'rest_minutes')::int, 0),
        'rest_seconds', coalesce((ex->>'rest_seconds')::int, 0),
        'sets', ex_sets,
        'weight_before', ex->'current_weight',
        'weight_after', next_weight
      );
      if increment_val <> 0 then
        set_el := set_el || jsonb_build_object('increment', increment_val);
      end if;
      if exercise_is_pr then
        set_el := set_el || jsonb_build_object('exercise_is_pr', true);
      end if;
      snap_exercises := snap_exercises || jsonb_build_array(set_el);

    elsif ex_type = 'time' then
      target_secs :=
        coalesce((ex->>'target_minutes')::int, 0) * 60
        + coalesce((ex->>'target_seconds')::int, 0);

      for s in 0..(target_sets - 1) loop
        key := ex_id::text || '-' || s::text;
        raw_time := p_times->>key;
        time_secs := null;
        if raw_time is not null and raw_time ~ '^-?\d+$' then
          time_secs := raw_time::int;
        end if;
        total_sets := total_sets + 1;

        set_el := jsonb_build_object('set_number', s + 1);
        if time_secs is not null then
          set_el := set_el || jsonb_build_object('seconds_completed', time_secs);
        end if;
        ex_sets := ex_sets || jsonb_build_array(set_el);
      end loop;

      snap_exercises := snap_exercises || jsonb_build_array(
        jsonb_build_object(
          'exercise_id', ex_id,
          'name', ex->>'name',
          'exercise_type', 'time',
          'target_sets', target_sets,
          'target_minutes', coalesce((ex->>'target_minutes')::int, 0),
          'target_seconds', coalesce((ex->>'target_seconds')::int, 0),
          'rest_minutes', coalesce((ex->>'rest_minutes')::int, 0),
          'rest_seconds', coalesce((ex->>'rest_seconds')::int, 0),
          'sets', ex_sets
        )
      );
    end if;
  end loop;

  is_perfect := pr_count > 0 and pr_count = reps_ex_count;

  insert into public.workout_history (
    user_id,
    workout_date,
    template_id,
    template_name_snapshot,
    workout_status,
    is_skipped,
    duration_seconds,
    is_perfect_day,
    performance_snapshot,
    workout_snapshot
  ) values (
    uid,
    p_workout_date,
    p_template_id,
    p_template_name,
    0,
    false,
    p_duration_seconds,
    is_perfect,
    jsonb_build_object(
      'total_volume_kg', round(total_volume)::int,
      'total_sets', total_sets,
      'pr_count', pr_count
    ),
    jsonb_build_object('exercises', snap_exercises)
  )
  on conflict (user_id, workout_date) do update set
    template_id = excluded.template_id,
    template_name_snapshot = excluded.template_name_snapshot,
    workout_status = 0,
    is_skipped = false,
    duration_seconds = excluded.duration_seconds,
    is_perfect_day = excluded.is_perfect_day,
    performance_snapshot = excluded.performance_snapshot,
    workout_snapshot = excluded.workout_snapshot
  returning * into workout_row;

  return jsonb_build_object(
    'workout', to_jsonb(workout_row),
    'updated_exercises', updated_exercises
  );
end;
$$;

revoke all on function public.complete_workout_session(date, uuid, text, integer, jsonb, jsonb, jsonb) from public;
grant execute on function public.complete_workout_session(date, uuid, text, integer, jsonb, jsonb, jsonb) to authenticated;