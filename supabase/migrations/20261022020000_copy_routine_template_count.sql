-- copy_routine reported only the templates assigned to a weekday as
-- template_count, while every list/count in the app counts all templates in the
-- routine. Copying a routine with an unassigned template therefore showed a
-- stale lower count until the list was reloaded. Return the number of cloned
-- templates instead.

begin;

create or replace function public.copy_routine(p_source_routine_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
  src record;
  owner_name text;
  clean_name text;
  next_order int;
  new_routine public.routines;
  ex record;
  new_ex_id uuid;
  ex_map jsonb := '{}'::jsonb;
  tpl record;
  new_tpl_id uuid;
  tpl_map jsonb := '{}'::jsonb;
  mapped_ids uuid[];
  v_eid uuid;
  d smallint;
  old_tid uuid;
  new_tid uuid;
  created_count int := 0;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  select id, user_id, name into src
  from public.routines
  where id = p_source_routine_id;

  if not found then
    raise exception 'Routine not found';
  end if;

  select username into owner_name
  from public.usernames
  where user_id = src.user_id;

  select coalesce(max(display_order), -1) + 1 into next_order
  from public.routines
  where user_id = uid;

  clean_name := upper(btrim(
    case
      when src.user_id = uid then src.name
      else src.name || ' - ' || coalesce(owner_name, 'unknown')
    end
  ));
  if clean_name = '' then
    clean_name := 'ROUTINE';
  end if;
  clean_name := left(clean_name, 18);

  insert into public.routines (user_id, name, display_order)
  values (uid, clean_name, next_order)
  returning * into new_routine;

  -- Clone every referenced exercise once (preserve programming, reset progress).
  for ex in
    select distinct e.*
    from public.templates t
    cross join lateral unnest(t.exercise_ids) as eid(exercise_id)
    join public.exercises e on e.id = eid.exercise_id
    where t.routine_id = src.id
  loop
    new_ex_id := gen_random_uuid();
    insert into public.exercises (
      id, user_id, name, exercise_type, target_sets, target_reps,
      target_minutes, target_seconds, rest_minutes, rest_seconds,
      increment, current_weight
    ) values (
      new_ex_id, uid, ex.name, ex.exercise_type, ex.target_sets, ex.target_reps,
      ex.target_minutes, ex.target_seconds, ex.rest_minutes, ex.rest_seconds,
      ex.increment, null
    );
    ex_map := ex_map || jsonb_build_object(ex.id::text, new_ex_id::text);
  end loop;

  for tpl in
    select *
    from public.templates
    where routine_id = src.id
    order by display_order, created_at
  loop
    new_tpl_id := gen_random_uuid();
    mapped_ids := array[]::uuid[];
    foreach v_eid in array coalesce(tpl.exercise_ids, array[]::uuid[]) loop
      if ex_map ? v_eid::text then
        mapped_ids := array_append(mapped_ids, (ex_map->>v_eid::text)::uuid);
      end if;
    end loop;

    insert into public.templates (
      id, routine_id, name, color, icon, display_order, exercise_ids
    ) values (
      new_tpl_id, new_routine.id, tpl.name, tpl.color, tpl.icon,
      created_count, mapped_ids
    );
    tpl_map := tpl_map || jsonb_build_object(tpl.id::text, new_tpl_id::text);
    created_count := created_count + 1;
  end loop;

  for d in 0..6 loop
    old_tid := null;
    select template_id into old_tid
    from public.routine_schedules
    where routine_id = src.id and day_of_week = d;

    new_tid := null;
    if old_tid is not null and tpl_map ? old_tid::text then
      new_tid := (tpl_map->>old_tid::text)::uuid;
    end if;

    insert into public.routine_schedules (routine_id, day_of_week, template_id)
    values (new_routine.id, d, new_tid);
  end loop;

  return jsonb_build_object(
    'id', new_routine.id,
    'user_id', new_routine.user_id,
    'name', new_routine.name,
    'created_at', new_routine.created_at,
    'display_order', new_routine.display_order,
    'template_count', created_count,
    'source_name', src.name,
    'source_username', coalesce(owner_name, 'unknown')
  );
end;
$function$;

revoke all on function public.copy_routine(uuid) from public, anon;
grant execute on function public.copy_routine(uuid) to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
