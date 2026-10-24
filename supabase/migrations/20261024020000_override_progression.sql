-- -----------------------------------------------------------------------------
-- Per-day override progression
-- -----------------------------------------------------------------------------
-- `use_override` marks exercises whose targets/weights come from a template-day
-- override. Their base exercise row must not advance; the client persists the
-- returned next weight back onto templates.exercise_overrides.

CREATE OR REPLACE FUNCTION public.complete_workout_session(p_workout_date date, p_template_id uuid, p_template_name text, p_duration_seconds integer, p_reps jsonb, p_times jsonb, p_exercises jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  is_owned boolean;
  use_override boolean;
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
    use_override := coalesce((ex->>'use_override')::boolean, false);

    -- Validate before any write: accept the caller's own exercises, plus
    -- exercises referenced by the submitted template when that template's
    -- routine is owned or bookmarked by the caller.
    if ex_type not in ('reps', 'time') then
      raise exception 'Invalid exercise type';
    end if;
    select exists (
      select 1 from public.exercises e
      where e.id = ex_id and e.user_id = uid
    ) into is_owned;
    if not is_owned and not exists (
      select 1
      from public.templates t
      join public.routines r on r.id = t.routine_id
      where t.id = p_template_id
        and ex_id = any(t.exercise_ids)
        and (
          r.user_id = uid
          or exists (
            select 1 from public.routine_bookmarks b
            where b.user_id = uid and b.routine_id = r.id
          )
        )
    ) then
      raise exception 'Exercise not found';
    end if;

    target_sets := least(12, greatest(0, coalesce((ex->>'target_sets')::int, 0)));
    ex_sets := '[]'::jsonb;

    if ex_type = 'reps' then
      reps_ex_count := reps_ex_count + 1;
      target_reps := least(999, greatest(0, coalesce((ex->>'target_reps')::int, 0)));
      current_weight := coalesce((ex->>'current_weight')::real, 0);
      increment_val := coalesce((ex->>'increment')::real, 0);

      select coalesce(epb.best_weight, 0)
      into all_time_best
      from public.exercise_personal_bests epb
      where epb.exercise_id = ex_id
        and epb.user_id = uid;
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

      -- Never advance a publisher's stored weight while following their routine.
      -- Day-specific overrides progress independently: the client persists the
      -- next weight onto the template override, so the shared base stays intact.
      if is_owned and not use_override then
        update public.exercises
        set current_weight = next_weight
        where id = ex_id
          and user_id = uid;
      elsif not is_owned then
        next_weight := current_weight;
      end if;

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
        on conflict (exercise_id, user_id) do update set
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
$function$;

revoke all on function public.complete_workout_session(date,uuid,text,integer,jsonb,jsonb,jsonb) from public, anon, authenticated;

grant execute on function public.complete_workout_session(date,uuid,text,integer,jsonb,jsonb,jsonb) to authenticated, service_role;
