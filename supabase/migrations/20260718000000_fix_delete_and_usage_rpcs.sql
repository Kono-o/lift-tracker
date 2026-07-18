-- Fix delete_own_account: templates no longer has user_id (routine-owned).
-- Clean up in dependency order; routines cascade to templates + routine_schedules.
create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  delete from public.exercise_personal_bests where user_id = uid;
  delete from public.exercises where user_id = uid;
  delete from public.workout_history where user_id = uid;
  delete from public.stat_logs where user_id = uid;
  delete from public.tracked_stats where user_id = uid;
  delete from public.routine_bookmarks where user_id = uid;
  delete from public.routines where user_id = uid;
  delete from public.schedule where user_id = uid;
  delete from public.usernames where user_id = uid;

  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.delete_own_account() from public;
grant execute on function public.delete_own_account() to authenticated;

-- Fix get_own_data_usage: count templates via routines (routine-owned, no user_id).
create or replace function public.get_own_data_usage()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'templates',
      coalesce((select count(*)::int from public.templates t join public.routines r on r.id = t.routine_id where r.user_id = auth.uid()), 0),
    'exercises',
      coalesce((select count(*)::int from public.exercises where user_id = auth.uid()), 0),
    'schedule',
      coalesce((select count(*)::int from public.schedule where user_id = auth.uid()), 0),
    'workout_history',
      coalesce((select count(*)::int from public.workout_history where user_id = auth.uid()), 0),
    'tracked_stats',
      coalesce((select count(*)::int from public.tracked_stats where user_id = auth.uid()), 0),
    'stat_logs',
      coalesce((select count(*)::int from public.stat_logs where user_id = auth.uid()), 0),
    'routines',
      coalesce((select count(*)::int from public.routines where user_id = auth.uid()), 0),
    'estimated_bytes',
      (
        coalesce(
          (select sum(octet_length(row_to_json(t)::text))::bigint from public.templates t join public.routines r on r.id = t.routine_id where r.user_id = auth.uid()),
          0
        )
        + coalesce(
          (select sum(octet_length(row_to_json(e)::text))::bigint from public.exercises e where e.user_id = auth.uid()),
          0
        )
        + coalesce(
          (select sum(octet_length(row_to_json(s)::text))::bigint from public.schedule s where s.user_id = auth.uid()),
          0
        )
        + coalesce(
          (select sum(octet_length(row_to_json(w)::text))::bigint from public.workout_history w where w.user_id = auth.uid()),
          0
        )
        + coalesce(
          (select sum(octet_length(row_to_json(ts)::text))::bigint from public.tracked_stats ts where ts.user_id = auth.uid()),
          0
        )
        + coalesce(
          (select sum(octet_length(row_to_json(sl)::text))::bigint from public.stat_logs sl where sl.user_id = auth.uid()),
          0
        )
        + coalesce(
          (select sum(octet_length(row_to_json(p)::text))::bigint from public.exercise_personal_bests p where p.user_id = auth.uid()),
          0
        )
      )
  )
  where auth.uid() is not null;
$$;

revoke all on function public.get_own_data_usage() from public;
grant execute on function public.get_own_data_usage() to authenticated;

-- 3. Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
