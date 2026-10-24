-- ============================================================================
-- Security hardening: RPC privileges, exercise ownership, username rename
-- ============================================================================
-- Fixes found during the codebase audit:
--   1. delete_all_accounts() was executable by anon/authenticated and wipes
--      every account in the project. Restrict it to service_role/postgres.
--   2. New RPCs inherited Supabase's default EXECUTE grant for anon. Only
--      is_username_available is safe/required before sign-in.
--   3. complete_workout_session accepted another user's exercise ids. Reject
--      them and cap loop dimensions; a trigger enforces the same invariant on
--      exercise_personal_bests as defense in depth.
--   4. rename_username could rewrite the email of an OAuth/email account and
--      deleted + reinserted the profile row (losing active_routine_id).
--   5. unbookmark_routine left the removed routine's templates in the
--      materialized personal schedule, so the calendar kept showing them.

begin;

-- ---------------------------------------------------------------------------
-- 1. complete_workout_session: ownership + input bounds
-- ---------------------------------------------------------------------------
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

    -- Validate before any write: only the caller's own exercises are accepted.
    if ex_type not in ('reps', 'time') then
      raise exception 'Invalid exercise type';
    end if;
    if not exists (
      select 1 from public.exercises e
      where e.id = ex_id and e.user_id = uid
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
$function$;

-- Defense in depth: a personal best must reference an exercise owned by the
-- same user, regardless of which RPC or client wrote it.
create or replace function public.exercise_personal_bests_validate()
returns trigger
language plpgsql
security definer
set search_path TO 'public'
as $function$
begin
  if not exists (
    select 1 from public.exercises e
    where e.id = new.exercise_id and e.user_id = new.user_id
  ) then
    raise exception 'Exercise not found';
  end if;
  return new;
end;
$function$;

drop trigger if exists exercise_personal_bests_validate_trg on public.exercise_personal_bests;
create trigger exercise_personal_bests_validate_trg
  before insert or update of exercise_id, user_id on public.exercise_personal_bests
  for each row execute function public.exercise_personal_bests_validate();

-- ---------------------------------------------------------------------------
-- 2. rename_username: username-account guard + in-place rename
-- ---------------------------------------------------------------------------
create or replace function public.rename_username(p_new_username text)
returns void
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
declare
  uid uuid := auth.uid();
  u text := lower(trim(p_new_username));
  old_u text;
  old_email text;
  new_email text;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;
  if u is null or u = '' or u !~ '^[a-z0-9_-]{3,24}$' then
    raise exception 'Invalid username';
  end if;

  select username into old_u
  from public.usernames
  where user_id = uid
  order by username
  limit 1;

  if old_u is null then
    raise exception 'Only username accounts can be renamed here.';
  end if;

  -- Guard the auth.users email rewrite: external (OAuth/email) accounts have a
  -- real inbox and must never have it replaced by a synthetic username address.
  select email into old_email from auth.users where id = uid;
  if old_email is null or (
       old_email <> 'lt_' || old_u || '@example.com'
       and old_email <> old_u || '@users.lifttracker.app'
       and old_email <> old_u || '@user.lifttracker.app'
     ) then
    raise exception 'Only username accounts can be renamed here.';
  end if;

  if old_u = u then
    return;
  end if;

  if exists (
    select 1 from public.usernames where username = u and user_id <> uid
  ) then
    raise exception 'Username already taken' using errcode = '23505';
  end if;

  new_email := 'lt_' || u || '@example.com';

  -- In-place rename preserves avatar_seed, created_at and active_routine_id.
  update public.usernames
  set username = u
  where user_id = uid;

  update auth.users set
    email = new_email,
    raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('username', u)
  where id = uid;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. unbookmark_routine: clear materialized schedule rows for the routine
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.unbookmark_routine(p_routine_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  delete from public.routine_bookmarks
  where user_id = uid and routine_id = p_routine_id;

  -- Remove this routine's templates from the materialized personal schedule so
  -- a removed bookmark cannot keep driving the calendar. Templates are owned by
  -- the routine, so this never touches another routine's days.
  delete from public.schedule
  where user_id = uid
    and template_id in (
      select t.id from public.templates t where t.routine_id = p_routine_id
    );

  -- If that was the active routine, clear it (user must re-assign)
  update public.usernames
    set active_routine_id = null
    where user_id = uid and active_routine_id = p_routine_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Function grants
-- ---------------------------------------------------------------------------
revoke all on function public.delete_all_accounts() from public, anon, authenticated;
grant execute on function public.delete_all_accounts() to service_role;
grant execute on function public.delete_all_accounts() to postgres;

revoke all on function public.is_username_available(text) from public, anon, authenticated;
grant execute on function public.is_username_available(text) to anon, authenticated, service_role;

-- Trigger-only functions are not RPCs.
revoke all on function public.handle_new_user_schedule() from public, anon, authenticated;
revoke all on function public.handle_auth_user_username() from public, anon, authenticated;
revoke all on function public.routine_bookmarks_validate() from public, anon, authenticated;
revoke all on function public.exercise_personal_bests_validate() from public, anon, authenticated;

-- Every remaining app RPC requires a signed-in user. (Each function also
-- checks auth.uid(); this is the outer privilege boundary.)
do $do$
declare
  r record;
begin
  for r in
    select p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.proname not in (
        'delete_all_accounts',
        'is_username_available',
        'handle_new_user_schedule',
        'handle_auth_user_username',
        'routine_bookmarks_validate',
        'exercise_personal_bests_validate'
      )
  loop
    execute format(
      'revoke all on function public.%I(%s) from public, anon',
      r.proname, r.args
    );
    execute format(
      'grant execute on function public.%I(%s) to authenticated, service_role',
      r.proname, r.args
    );
  end loop;
end;
$do$;

notify pgrst, 'reload schema';

commit;
