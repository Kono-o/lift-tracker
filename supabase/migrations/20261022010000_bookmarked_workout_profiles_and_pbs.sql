-- Per-user personal bests, bookmarked-routine workout completion, and
-- guaranteed username profile rows (email/OAuth accounts included).

begin;

-- -----------------------------------------------------------------------------
-- 1. Personal bests are per user, not per exercise row.
-- -----------------------------------------------------------------------------
alter table public.exercise_personal_bests
  drop constraint exercise_personal_bests_pkey;
alter table public.exercise_personal_bests
  add constraint exercise_personal_bests_pkey primary key (exercise_id, user_id);

-- -----------------------------------------------------------------------------
-- 2. Every auth user gets a usernames row (generated when no handle supplied).
-- -----------------------------------------------------------------------------
create or replace function public.ensure_username_row(p_user_id uuid, p_base text default null)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  existing text;
  base text;
  candidate text;
begin
  if p_user_id is null then
    return null;
  end if;

  select username into existing
  from public.usernames
  where user_id = p_user_id
  limit 1;

  if existing is not null then
    return existing;
  end if;

  base := regexp_replace(lower(coalesce(p_base, '')), '[^a-z0-9_-]+', '', 'g');
  if length(base) < 3 then
    base := 'user';
  end if;
  base := left(base, 17);

  loop
    candidate := base || '_' || substr(md5(gen_random_uuid()::text), 1, 6);
    exit when not exists (
      select 1 from public.usernames where username = candidate
    );
  end loop;

  insert into public.usernames (username, user_id)
  values (candidate, p_user_id)
  on conflict (user_id) do nothing;

  select username into existing
  from public.usernames
  where user_id = p_user_id
  limit 1;

  return existing;
end;
$function$;

create or replace function public.handle_auth_user_username()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'auth'
as $function$
declare
  u text;
begin
  u := lower(trim(coalesce(new.raw_user_meta_data->>'username', '')));
  if u ~ '^[a-z0-9_-]{3,24}$' then
    begin
      insert into public.usernames (username, user_id) values (u, new.id);
    exception
      when unique_violation then
        raise exception 'Username already taken' using errcode = '23505';
    end;
  else
    perform public.ensure_username_row(new.id, split_part(coalesce(new.email, ''), '@', 1));
  end if;
  return new;
end;
$function$;

do $backfill$
declare
  u record;
begin
  for u in
    select au.id, au.email
    from auth.users au
    where not exists (
      select 1 from public.usernames n where n.user_id = au.id
    )
  loop
    perform public.ensure_username_row(u.id, split_part(coalesce(u.email, ''), '@', 1));
  end loop;
end;
$backfill$;

-- Make profile-writing RPCs self-healing for any future account without a row.
create or replace function public.save_avatar_seed(p_seed text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;
  perform public.ensure_username_row(uid);
  update public.usernames
  set avatar_seed = p_seed
  where user_id = uid;
end;
$function$;

create or replace function public.set_active_routine(p_routine_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
  r record;
  has_access boolean := false;
  d smallint;
  tid uuid;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  perform public.ensure_username_row(uid);

  if p_routine_id is null then
    update public.usernames
      set active_routine_id = null
      where user_id = uid;
    return;
  end if;

  select id, user_id into r
  from public.routines
  where id = p_routine_id;

  if not found then
    raise exception 'Routine not found';
  end if;

  if r.user_id = uid then
    has_access := true;
  elsif exists (
    select 1 from public.routine_bookmarks b
    where b.user_id = uid and b.routine_id = p_routine_id
  ) then
    has_access := true;
  end if;

  if not has_access then
    raise exception 'Routine not accessible';
  end if;

  update public.usernames
    set active_routine_id = p_routine_id
    where user_id = uid;

  -- Only the owner may seed missing day rows on the source routine
  if r.user_id = uid then
    for d in 0..6 loop
      insert into public.routine_schedules (routine_id, day_of_week, template_id)
      values (p_routine_id, d, null)
      on conflict (routine_id, day_of_week) do nothing;
    end loop;
  end if;

  -- Materialize into personal schedule (works for foreign templates)
  for d in 0..6 loop
    select rs.template_id into tid
    from public.routine_schedules rs
    where rs.routine_id = p_routine_id and rs.day_of_week = d;

    -- If no row for that day, treat as rest
    if not found then
      tid := null;
    end if;

    insert into public.schedule (user_id, day_of_week, template_id, updated_at)
    values (uid, d, tid, now())
    on conflict (user_id, day_of_week) do update set
      template_id = excluded.template_id,
      updated_at = now();
  end loop;
end;
$function$;

-- -----------------------------------------------------------------------------
-- 3. Personal-best validation: own exercises, or exercises in a bookmarked routine.
-- -----------------------------------------------------------------------------
create or replace function public.exercise_personal_bests_validate()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not exists (
    select 1 from public.exercises e
    where e.id = new.exercise_id and e.user_id = new.user_id
  ) and not exists (
    select 1
    from public.templates t
    join public.routine_bookmarks b on b.routine_id = t.routine_id
    where b.user_id = new.user_id
      and new.exercise_id = any(t.exercise_ids)
  ) then
    raise exception 'Exercise not found';
  end if;
  return new;
end;
$function$;

-- -----------------------------------------------------------------------------
-- 4. Workout completion accepts exercises from the caller's own or bookmarked
--    routine templates; only owned exercises advance their stored weight.
-- -----------------------------------------------------------------------------
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
      if is_owned then
        update public.exercises
        set current_weight = next_weight
        where id = ex_id
          and user_id = uid;
      else
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

revoke all on function public.ensure_username_row(uuid, text) from public, anon, authenticated;
grant execute on function public.ensure_username_row(uuid, text) to service_role;
revoke all on function public.exercise_personal_bests_validate() from public, anon, authenticated;
revoke all on function public.handle_auth_user_username() from public, anon, authenticated;
revoke all on function public.save_avatar_seed(p_seed text) from public, anon, authenticated;
grant execute on function public.save_avatar_seed(p_seed text) to authenticated, service_role;
revoke all on function public.set_active_routine(p_routine_id uuid) from public, anon, authenticated;
grant execute on function public.set_active_routine(p_routine_id uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
