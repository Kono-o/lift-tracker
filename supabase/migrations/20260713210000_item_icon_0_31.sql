-- Expand shared icon range from 0–15 to 0–31 (see src/lib/itemIcons.ts).

alter table public.templates drop constraint if exists templates_icon_range;
alter table public.templates
  add constraint templates_icon_range check (icon >= 0 and icon <= 31);

alter table public.tracked_stats drop constraint if exists tracked_stats_icon_range;
alter table public.tracked_stats
  add constraint tracked_stats_icon_range check (icon >= 0 and icon <= 31);

-- Clamp in save_tracked_stats
create or replace function public.save_tracked_stats(p_stats jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  st jsonb;
  v_stat_id uuid;
  v_name text;
  v_unit text;
  v_start_value real;
  v_has_target boolean;
  v_target_value real;
  v_target_prefers_lower boolean;
  v_icon smallint;
  v_color smallint;
  saved_ids uuid[] := '{}';
  ord integer := 0;
  result jsonb := '[]'::jsonb;
  row public.tracked_stats;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  if coalesce(jsonb_array_length(p_stats), 0) = 0 then
    delete from public.tracked_stats where user_id = uid;
    return '[]'::jsonb;
  end if;

  if jsonb_array_length(p_stats) > 20 then
    raise exception 'Too many stats (max 20)';
  end if;

  for st in select * from jsonb_array_elements(p_stats)
  loop
    v_name := upper(trim(coalesce(st->>'name', 'STAT')));
    if char_length(v_name) = 0 then
      raise exception 'Stat name required';
    end if;
    if char_length(v_name) > 24 then
      v_name := left(v_name, 24);
    end if;

    v_unit := upper(trim(coalesce(st->>'unit', '')));
    if char_length(v_unit) > 6 then
      v_unit := left(v_unit, 6);
    end if;

    v_start_value := greatest(0, coalesce((st->>'start_value')::real, 0));
    v_has_target := coalesce((st->>'has_target')::boolean, false);
    if v_has_target then
      v_target_value := (st->>'target_value')::real;
      if v_target_value is null or v_target_value <= 0 then
        raise exception 'Target value must be greater than 0 when target is enabled';
      end if;
    else
      v_target_value := null;
    end if;

    v_target_prefers_lower := coalesce((st->>'target_prefers_lower')::boolean, true);
    v_icon := greatest(0, least(31, coalesce((st->>'icon')::smallint, 0::smallint)));
    v_color := greatest(0, least(255, coalesce((st->>'color')::smallint, 242::smallint)));

    v_stat_id := null;
    begin
      if st->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         and not (st->>'id') like 'temp-%' then
        v_stat_id := (st->>'id')::uuid;
      end if;
    exception when others then
      v_stat_id := null;
    end;

    if v_stat_id is not null and exists (
      select 1 from public.tracked_stats s
      where s.id = v_stat_id and s.user_id = uid
    ) then
      update public.tracked_stats set
        name = v_name,
        unit = v_unit,
        display_order = ord,
        start_value = v_start_value,
        has_target = v_has_target,
        target_value = v_target_value,
        target_prefers_lower = v_target_prefers_lower,
        icon = v_icon,
        color = v_color
      where id = v_stat_id and user_id = uid
      returning * into row;
    else
      insert into public.tracked_stats (
        user_id, name, unit, display_order, start_value, has_target,
        target_value, target_prefers_lower, icon, color
      )
      values (
        uid, v_name, v_unit, ord, v_start_value, v_has_target,
        v_target_value, v_target_prefers_lower, v_icon, v_color
      )
      returning * into row;
      v_stat_id := row.id;
    end if;

    saved_ids := array_append(saved_ids, v_stat_id);
    result := result || jsonb_build_array(
      to_jsonb(row) || jsonb_build_object('display_order', ord)
    );
    ord := ord + 1;
  end loop;

  delete from public.tracked_stats
  where user_id = uid
    and not (id = any(saved_ids));

  return result;
end;
$$;

revoke all on function public.save_tracked_stats(jsonb) from public;
grant execute on function public.save_tracked_stats(jsonb) to authenticated;
