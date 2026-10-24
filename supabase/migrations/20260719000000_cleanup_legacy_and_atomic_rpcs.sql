-- Cleanup of dead pre-routines schema + atomic routine operations.
--
-- Context: the app moved from editable shared week schedules to routines with
-- routine-owned templates (exercise_ids[]). The legacy week-schedule/bodyweight
-- tables and RPCs remained deployed, and two of those RPCs reference columns or
-- tables that no longer exist. This migration removes that dead surface and
-- replaces the multi-request client write paths with transactional RPCs:
--   * assign_schedule_days now dual-writes the active owned routine plan
--   * save_routine_schedule replaces delete-all + insert from the client
--   * copy_routine clones a routine in a single transaction (all templates)

begin;

-- -----------------------------------------------------------------------------
-- 1. Remove unused legacy tables and their RPCs
-- -----------------------------------------------------------------------------
drop function if exists public.assign_days_to_week_schedule(uuid, jsonb) cascade;
drop function if exists public.create_week_schedule(text) cascade;
drop function if exists public.delete_week_schedule(uuid) cascade;
drop function if exists public.get_all_public_week_schedules() cascade;
drop function if exists public.get_my_week_schedules() cascade;
drop function if exists public.get_public_week_schedules_for_username(text) cascade;
drop function if exists public.get_week_schedule_details(uuid) cascade;
drop function if exists public.get_week_schedule_for_adopt(uuid) cascade;
drop function if exists public.rename_week_schedule(uuid, text) cascade;
drop function if exists public.set_active_week_schedules(uuid, uuid) cascade;
drop function if exists public.tag_week_schedule(uuid, text) cascade;
drop function if exists public.untag_week_schedule(uuid) cascade;

drop table if exists public.user_active_schedules cascade;
drop table if exists public.user_schedule_tags cascade;
drop table if exists public.week_schedule_days cascade;
drop table if exists public.week_schedules cascade;
drop table if exists public.bodyweight_logs cascade;

-- Redundant because *_select_all already exposes these rows to authenticated users.
drop policy if exists exercises_select_own on public.exercises;
drop policy if exists templates_select_own on public.templates;

-- Direct schedule writes are only for the caller's own materialized plan; the
-- security-definer RPCs bypass RLS when following a bookmarked routine.
drop policy if exists schedule_insert_own on public.schedule;
create policy schedule_insert_own on public.schedule
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and (
      template_id is null
      or exists (
        select 1
        from public.templates t
        join public.routines r on r.id = t.routine_id
        where t.id = template_id and r.user_id = auth.uid()
      )
    )
  );

drop policy if exists schedule_update_own on public.schedule;
create policy schedule_update_own on public.schedule
  for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and (
      template_id is null
      or exists (
        select 1
        from public.templates t
        join public.routines r on r.id = t.routine_id
        where t.id = template_id and r.user_id = auth.uid()
      )
    )
  );

-- -----------------------------------------------------------------------------
-- 2. assign_schedule_days: validate once, write personal + owned routine plan
-- -----------------------------------------------------------------------------
create or replace function public.assign_schedule_days(p_assignments jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
  item jsonb;
  v_day_of_week smallint;
  v_template_id uuid;
  v_active_routine uuid;
  row public.schedule;
  rows jsonb := '[]'::jsonb;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  if coalesce(jsonb_array_length(p_assignments), 0) = 0 then
    return '[]'::jsonb;
  end if;

  -- Validate every assignment before making any change.
  for item in select * from jsonb_array_elements(p_assignments)
  loop
    v_day_of_week := (item->>'day_of_week')::smallint;
    if v_day_of_week < 0 or v_day_of_week > 6 then
      raise exception 'Invalid day_of_week';
    end if;

    if item->>'template_id' is not null and btrim(item->>'template_id') <> '' then
      v_template_id := (item->>'template_id')::uuid;
      if not exists (
        select 1
        from public.templates t
        join public.routines r on r.id = t.routine_id
        where t.id = v_template_id and r.user_id = uid
      ) then
        raise exception 'Template not found';
      end if;
    end if;
  end loop;

  select active_routine_id into v_active_routine
  from public.usernames
  where user_id = uid;

  if v_active_routine is not null and not exists (
    select 1 from public.routines where id = v_active_routine and user_id = uid
  ) then
    v_active_routine := null;
  end if;

  for item in select * from jsonb_array_elements(p_assignments)
  loop
    v_day_of_week := (item->>'day_of_week')::smallint;
    v_template_id := null;
    if item->>'template_id' is not null and btrim(item->>'template_id') <> '' then
      v_template_id := (item->>'template_id')::uuid;
    end if;

    insert into public.schedule (user_id, day_of_week, template_id, updated_at)
    values (uid, v_day_of_week, v_template_id, now())
    on conflict (user_id, day_of_week) do update set
      template_id = excluded.template_id,
      updated_at = now()
    returning * into row;

    -- The routine builder relies on day edits being persisted immediately.
    if v_active_routine is not null then
      insert into public.routine_schedules (routine_id, day_of_week, template_id)
      values (v_active_routine, v_day_of_week, v_template_id)
      on conflict (routine_id, day_of_week) do update set
        template_id = excluded.template_id;
    end if;

    rows := rows || jsonb_build_array(to_jsonb(row));
  end loop;

  return rows;
end;
$function$;

revoke all on function public.assign_schedule_days(jsonb) from public;
grant execute on function public.assign_schedule_days(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- 3. save_routine_schedule: replace the client-side delete-all + insert
-- -----------------------------------------------------------------------------
create or replace function public.save_routine_schedule(p_routine_id uuid, p_schedule jsonb)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
  item jsonb;
  v_day smallint;
  v_template uuid;
  v_tid uuid;
  d smallint;
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

  if p_schedule is null
     or jsonb_typeof(p_schedule) <> 'array'
     or jsonb_array_length(p_schedule) <> 7 then
    raise exception 'Schedule must contain all seven days';
  end if;

  if (
    select count(distinct (value->>'day_of_week')::int)
    from jsonb_array_elements(p_schedule)
  ) <> 7 then
    raise exception 'Schedule must contain each day exactly once';
  end if;

  -- Validate before deleting anything so a bad payload leaves the plan intact.
  for item in select * from jsonb_array_elements(p_schedule)
  loop
    v_day := (item->>'day_of_week')::smallint;
    if v_day < 0 or v_day > 6 then
      raise exception 'Invalid day_of_week';
    end if;

    if item->>'template_id' is not null and btrim(item->>'template_id') <> '' then
      v_template := (item->>'template_id')::uuid;
      if not exists (
        select 1
        from public.templates t
        where t.id = v_template and t.routine_id = p_routine_id
      ) then
        raise exception 'Template does not belong to this routine';
      end if;
    end if;
  end loop;

  delete from public.routine_schedules where routine_id = p_routine_id;

  for item in select * from jsonb_array_elements(p_schedule)
  loop
    v_day := (item->>'day_of_week')::smallint;
    v_template := null;
    if item->>'template_id' is not null and btrim(item->>'template_id') <> '' then
      v_template := (item->>'template_id')::uuid;
    end if;
    insert into public.routine_schedules (routine_id, day_of_week, template_id)
    values (p_routine_id, v_day, v_template);
  end loop;

  -- Keep the materialized personal schedule in sync when this plan is active.
  if exists (
    select 1
    from public.usernames
    where user_id = uid and active_routine_id = p_routine_id
  ) then
    for d in 0..6 loop
      v_tid := null;
      select template_id into v_tid
      from public.routine_schedules
      where routine_id = p_routine_id and day_of_week = d;

      insert into public.schedule (user_id, day_of_week, template_id, updated_at)
      values (uid, d, v_tid, now())
      on conflict (user_id, day_of_week) do update set
        template_id = excluded.template_id,
        updated_at = now();
    end loop;
  end if;
end;
$function$;

revoke all on function public.save_routine_schedule(uuid, jsonb) from public;
grant execute on function public.save_routine_schedule(uuid, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- 4. copy_routine: atomic deep copy of every template in the routine
-- -----------------------------------------------------------------------------
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
  template_count int := 0;
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

  -- Higher display_order wins even if another routine is mid-create.
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
      template_count := template_count + 1;
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
    'template_count', template_count,
    'source_name', src.name,
    'source_username', coalesce(owner_name, 'unknown')
  );
end;
$function$;

revoke all on function public.copy_routine(uuid) from public;
grant execute on function public.copy_routine(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 5. delete_all_accounts (setup-db.fish --users-only) for the current schema
-- -----------------------------------------------------------------------------
create or replace function public.delete_all_accounts()
returns void
language plpgsql
security definer
set search_path = public, auth
as $function$
begin
  delete from public.exercise_personal_bests;
  delete from public.exercises;
  delete from public.workout_history;
  delete from public.stat_logs;
  delete from public.tracked_stats;
  delete from public.routine_bookmarks;
  delete from public.routines; -- cascades templates + routine_schedules
  delete from public.schedule;
  delete from public.usernames;
  delete from auth.users;
end;
$function$;

revoke all on function public.delete_all_accounts() from public;
grant execute on function public.delete_all_accounts() to service_role;
grant execute on function public.delete_all_accounts() to postgres;

notify pgrst, 'reload schema';

commit;
