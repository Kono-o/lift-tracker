-- save_routine_cycle declared a PL/pgSQL variable named `i` and also aliased the
-- generate_series column as `i`, so Postgres raised "column reference i is
-- ambiguous" on every cycle save. Alias the series column distinctly.
create or replace function public.save_routine_cycle(
  p_routine_id uuid,
  p_length integer,
  p_anchor_date date,
  p_slots jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
  v_len int;
  v_slots jsonb;
  v_item text;
  i int;
  v_mode text;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;
  if p_routine_id is null then
    raise exception 'Routine required';
  end if;
  if not exists (
    select 1 from public.routines where id = p_routine_id and user_id = uid
  ) then
    raise exception 'Bookmarked routines are read-only. Copy the routine to edit it.';
  end if;

  v_len := least(28, greatest(1, coalesce(p_length, 7)));
  v_slots := case when jsonb_typeof(p_slots) = 'array' then p_slots else '[]'::jsonb end;

  -- Normalize to exactly v_len entries (null = rest).
  select coalesce(jsonb_agg(
    case
      when g.idx < jsonb_array_length(v_slots) and nullif(btrim(v_slots->>g.idx), '') is not null
        then to_jsonb((v_slots->>g.idx)::uuid)
      else 'null'::jsonb
    end
    order by g.idx
  ), '[]'::jsonb)
  into v_slots
  from generate_series(0, v_len - 1) as g(idx);

  for i in 0..(v_len - 1) loop
    v_item := v_slots->>i;
    if v_item is not null and v_item <> 'null' then
      if not exists (
        select 1 from public.templates t
        where t.id = (v_item)::uuid and t.routine_id = p_routine_id
      ) then
        raise exception 'Template does not belong to this routine';
      end if;
    end if;
  end loop;

  select schedule_mode into v_mode from public.routines where id = p_routine_id;

  update public.routines set
    schedule_mode = 'cycle',
    cycle_length = v_len,
    cycle_anchor_date = coalesce(p_anchor_date, current_date),
    cycle_slots = v_slots
  where id = p_routine_id and user_id = uid;

  if exists (
    select 1 from public.usernames
    where user_id = uid and active_routine_id = p_routine_id
  ) then
    perform public.materialize_active_routine_week(uid, p_routine_id, current_date);
  end if;

  return jsonb_build_object(
    'schedule_mode', 'cycle',
    'cycle_length', v_len,
    'cycle_anchor_date', coalesce(p_anchor_date, current_date),
    'cycle_slots', v_slots
  );
end;
$function$;

revoke all on function public.save_routine_cycle(uuid, integer, date, jsonb) from public, anon, authenticated;
grant execute on function public.save_routine_cycle(uuid, integer, date, jsonb) to authenticated, service_role;
