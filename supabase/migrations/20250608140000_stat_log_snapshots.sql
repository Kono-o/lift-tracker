-- Stat logs keep name/unit snapshots when a tracked stat definition is deleted.

alter table public.stat_logs
  add column if not exists stat_name_snapshot text;

alter table public.stat_logs
  add column if not exists stat_unit_snapshot text not null default '';

update public.stat_logs sl
set
  stat_name_snapshot = upper(trim(ts.name)),
  stat_unit_snapshot = upper(trim(coalesce(ts.unit, '')))
from public.tracked_stats ts
where sl.stat_id = ts.id
  and sl.user_id = ts.user_id
  and sl.stat_name_snapshot is null;

update public.stat_logs
set stat_name_snapshot = 'STAT'
where stat_name_snapshot is null;

alter table public.stat_logs
  alter column stat_name_snapshot set not null;

alter table public.stat_logs
  drop constraint if exists stat_logs_stat_id_fkey;

alter table public.stat_logs
  drop constraint if exists stat_logs_name_not_empty;

alter table public.stat_logs
  add constraint stat_logs_name_not_empty check (char_length(trim(stat_name_snapshot)) > 0);

create or replace function public.save_stat_log(
  p_stat_id uuid,
  p_log_date date,
  p_value real
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  v_name text;
  v_unit text;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  if p_value is null or p_value <= 0 then
    raise exception 'Value must be greater than 0';
  end if;

  select upper(trim(name)), upper(trim(coalesce(unit, '')))
    into v_name, v_unit
  from public.tracked_stats
  where id = p_stat_id and user_id = uid;

  if not found then
    select stat_name_snapshot, stat_unit_snapshot
      into v_name, v_unit
    from public.stat_logs
    where user_id = uid and stat_id = p_stat_id and log_date = p_log_date;

    if not found then
      raise exception 'Stat not found';
    end if;
  else
    if char_length(v_name) > 24 then
      v_name := left(v_name, 24);
    end if;
    if char_length(v_unit) > 6 then
      v_unit := left(v_unit, 6);
    end if;
  end if;

  insert into public.stat_logs (
    user_id,
    stat_id,
    log_date,
    value,
    stat_name_snapshot,
    stat_unit_snapshot,
    updated_at
  )
  values (uid, p_stat_id, p_log_date, p_value, v_name, v_unit, now())
  on conflict (user_id, stat_id, log_date) do update set
    value = excluded.value,
    stat_name_snapshot = excluded.stat_name_snapshot,
    stat_unit_snapshot = excluded.stat_unit_snapshot,
    updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.save_stat_log(uuid, date, real) from public;
grant execute on function public.save_stat_log(uuid, date, real) to authenticated;