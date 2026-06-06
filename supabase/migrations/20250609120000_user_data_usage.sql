-- Per-user row counts + approximate stored payload size (authenticated caller only).

create or replace function public.get_own_data_usage()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'templates',
      coalesce((select count(*)::int from public.templates where user_id = auth.uid()), 0),
    'exercises',
      coalesce((select count(*)::int from public.exercises where user_id = auth.uid()), 0),
    'schedule',
      coalesce((select count(*)::int from public.schedule where user_id = auth.uid()), 0),
    'workout_history',
      coalesce((select count(*)::int from public.workout_history where user_id = auth.uid()), 0),
    'estimated_bytes',
      (
        coalesce(
          (select sum(octet_length(row_to_json(t)::text))::bigint from public.templates t where t.user_id = auth.uid()),
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
      )
  )
  where auth.uid() is not null;
$$;

revoke all on function public.get_own_data_usage() from public;
grant execute on function public.get_own_data_usage() to authenticated;