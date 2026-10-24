-- =============================================================================
-- Training overhaul + wger exercise catalog
-- =============================================================================
-- Adds:
--   * routine cycle mode (non-weekly repeating day sequences)
--   * template-level per-day exercise overrides and superset links
--   * catalog provenance + notes on user exercises
--   * per-user preferences JSON
--   * read-only wger exercise catalog (categories/equipment/muscles/exercises)
-- Works alongside weekly routines; existing rows keep schedule_mode = 'weekly'.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Training model extensions
-- -----------------------------------------------------------------------------

alter table public.routines
  add column if not exists schedule_mode text not null default 'weekly',
  add column if not exists cycle_length smallint not null default 7,
  add column if not exists cycle_anchor_date date not null default current_date,
  add column if not exists cycle_slots jsonb not null default '[]'::jsonb;

alter table public.routines
  drop constraint if exists routines_schedule_mode_check,
  add constraint routines_schedule_mode_check check (schedule_mode in ('weekly', 'cycle')),
  drop constraint if exists routines_cycle_length_check,
  add constraint routines_cycle_length_check check (cycle_length between 1 and 28),
  drop constraint if exists routines_cycle_slots_check,
  add constraint routines_cycle_slots_check check (jsonb_typeof(cycle_slots) = 'array');

alter table public.templates
  add column if not exists exercise_overrides jsonb not null default '{}'::jsonb,
  add column if not exists superset_with_next uuid[] not null default '{}'::uuid[];

alter table public.templates
  drop constraint if exists templates_exercise_overrides_check,
  add constraint templates_exercise_overrides_check check (jsonb_typeof(exercise_overrides) = 'object');

alter table public.exercises
  add column if not exists catalog_exercise_id integer,
  add column if not exists catalog_muscle_ids integer[] not null default '{}'::integer[],
  add column if not exists notes text;

alter table public.usernames
  add column if not exists preferences jsonb not null default '{}'::jsonb;

alter table public.usernames
  drop constraint if exists usernames_preferences_check,
  add constraint usernames_preferences_check check (jsonb_typeof(preferences) = 'object');

-- Capture where a day's targets differ from the exercise baseline.
-- Shape: { "<exercise uuid>": { "target_sets": 3, "target_reps": 12,
--          "target_minutes": 0, "target_seconds": 0, "rest_minutes": 1,
--          "rest_seconds": 30, "increment": 2.5, "current_weight": 15 } }
-- Only present keys override the base exercise values.
create index if not exists templates_superset_with_next_idx
  on public.templates using gin (superset_with_next);

-- -----------------------------------------------------------------------------
-- 2. wger catalog (reference data; read-only for clients)
-- -----------------------------------------------------------------------------

create table if not exists public.wger_categories (
  id integer primary key,
  name text not null
);

create table if not exists public.wger_equipment (
  id integer primary key,
  name text not null
);

create table if not exists public.wger_muscles (
  id integer primary key,
  name text not null,
  name_en text,
  is_front boolean not null default true,
  image_url_main text,
  image_url_secondary text
);

create table if not exists public.wger_exercises (
  id integer primary key,
  uuid uuid unique,
  name text not null,
  description text not null default '',
  category_id integer references public.wger_categories(id) on delete set null,
  license text,
  license_author text,
  license_url text,
  wger_updated_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.wger_exercise_equipment (
  exercise_id integer not null references public.wger_exercises(id) on delete cascade,
  equipment_id integer not null references public.wger_equipment(id) on delete cascade,
  primary key (exercise_id, equipment_id)
);

create table if not exists public.wger_exercise_muscles (
  exercise_id integer not null references public.wger_exercises(id) on delete cascade,
  muscle_id integer not null references public.wger_muscles(id) on delete cascade,
  is_primary boolean not null default true,
  primary key (exercise_id, muscle_id)
);

alter table public.exercises
  drop constraint if exists exercises_catalog_exercise_id_fkey,
  add constraint exercises_catalog_exercise_id_fkey
    foreign key (catalog_exercise_id) references public.wger_exercises(id) on delete set null;

create index if not exists wger_exercises_name_lower_idx on public.wger_exercises (lower(name));
create index if not exists wger_exercises_category_idx on public.wger_exercises (category_id);
create index if not exists wger_exercise_equipment_equipment_idx on public.wger_exercise_equipment (equipment_id);
create index if not exists wger_exercise_muscles_muscle_idx on public.wger_exercise_muscles (muscle_id);

alter table public.wger_categories enable row level security;
alter table public.wger_equipment enable row level security;
alter table public.wger_muscles enable row level security;
alter table public.wger_exercises enable row level security;
alter table public.wger_exercise_equipment enable row level security;
alter table public.wger_exercise_muscles enable row level security;

drop policy if exists "wger_categories_read" on public.wger_categories;
create policy "wger_categories_read" on public.wger_categories
  for select to anon, authenticated using (true);
drop policy if exists "wger_equipment_read" on public.wger_equipment;
create policy "wger_equipment_read" on public.wger_equipment
  for select to anon, authenticated using (true);
drop policy if exists "wger_muscles_read" on public.wger_muscles;
create policy "wger_muscles_read" on public.wger_muscles
  for select to anon, authenticated using (true);
drop policy if exists "wger_exercises_read" on public.wger_exercises;
create policy "wger_exercises_read" on public.wger_exercises
  for select to anon, authenticated using (true);
drop policy if exists "wger_exercise_equipment_read" on public.wger_exercise_equipment;
create policy "wger_exercise_equipment_read" on public.wger_exercise_equipment
  for select to anon, authenticated using (true);
drop policy if exists "wger_exercise_muscles_read" on public.wger_exercise_muscles;
create policy "wger_exercise_muscles_read" on public.wger_exercise_muscles
  for select to anon, authenticated using (true);

revoke all on table public.wger_categories from anon, authenticated;
revoke all on table public.wger_equipment from anon, authenticated;
revoke all on table public.wger_muscles from anon, authenticated;
revoke all on table public.wger_exercises from anon, authenticated;
revoke all on table public.wger_exercise_equipment from anon, authenticated;
revoke all on table public.wger_exercise_muscles from anon, authenticated;
grant select on table public.wger_categories to anon, authenticated;
grant select on table public.wger_equipment to anon, authenticated;
grant select on table public.wger_muscles to anon, authenticated;
grant select on table public.wger_exercises to anon, authenticated;
grant select on table public.wger_exercise_equipment to anon, authenticated;
grant select on table public.wger_exercise_muscles to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Cycle-aware helpers
-- -----------------------------------------------------------------------------

create or replace function public.routine_slot_template(p_routine_id uuid, p_date date)
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  r record;
  idx int;
  slots jsonb;
  raw text;
  v_tid uuid;
begin
  if p_routine_id is null or p_date is null then
    return null;
  end if;

  select schedule_mode, cycle_length, cycle_anchor_date, cycle_slots
  into r
  from public.routines
  where id = p_routine_id;

  if not found then
    return null;
  end if;

  if r.schedule_mode = 'cycle' then
    idx := mod((p_date - r.cycle_anchor_date), greatest(1, r.cycle_length));
    if idx < 0 then
      idx := idx + greatest(1, r.cycle_length);
    end if;
    slots := coalesce(r.cycle_slots, '[]'::jsonb);
    if idx < jsonb_array_length(slots) then
      raw := slots->>idx;
      if raw is not null and btrim(raw) <> '' then
        v_tid := raw::uuid;
      end if;
    end if;
    return v_tid;
  end if;

  select template_id into v_tid
  from public.routine_schedules
  where routine_id = p_routine_id
    and day_of_week = extract(dow from p_date)::int;

  return v_tid;
exception
  when others then
    return null;
end;
$function$;

create or replace function public.materialize_active_routine_week(p_uid uuid, p_routine_id uuid, p_anchor_date date default current_date)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  d int;
  v_date date;
  v_tid uuid;
begin
  if p_uid is null or p_routine_id is null then
    return;
  end if;

  -- The app week starts on Sunday (day_of_week 0).
  v_date := p_anchor_date - extract(dow from p_anchor_date)::int;

  for d in 0..6 loop
    v_tid := public.routine_slot_template(p_routine_id, v_date + d);
    insert into public.schedule (user_id, day_of_week, template_id, updated_at)
    values (p_uid, d, v_tid, now())
    on conflict (user_id, day_of_week) do update set
      template_id = excluded.template_id,
      updated_at = now();
  end loop;
end;
$function$;

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

create or replace function public.reset_routine_to_weekly(p_routine_id uuid)
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

  if not exists (
    select 1 from public.routines where id = p_routine_id and user_id = uid
  ) then
    raise exception 'Bookmarked routines are read-only. Copy the routine to edit it.';
  end if;

  update public.routines
  set schedule_mode = 'weekly', cycle_length = 7, cycle_slots = '[]'::jsonb
  where id = p_routine_id and user_id = uid;

  if exists (
    select 1 from public.usernames
    where user_id = uid and active_routine_id = p_routine_id
  ) then
    perform public.materialize_active_routine_week(uid, p_routine_id, current_date);
  end if;
end;
$function$;

-- Replace set_active_routine so cycle plans materialize for the current week.
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
    update public.usernames set active_routine_id = null where user_id = uid;
    return;
  end if;

  select id, user_id, schedule_mode into r from public.routines where id = p_routine_id;
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

  update public.usernames set active_routine_id = p_routine_id where user_id = uid;

  if r.user_id = uid and r.schedule_mode <> 'cycle' then
    for d in 0..6 loop
      insert into public.routine_schedules (routine_id, day_of_week, template_id)
      values (p_routine_id, d, null)
      on conflict (routine_id, day_of_week) do nothing;
    end loop;
  end if;

  perform public.materialize_active_routine_week(uid, p_routine_id, current_date);
end;
$function$;

-- -----------------------------------------------------------------------------
-- 4. Template cleanup on exercise removal
-- -----------------------------------------------------------------------------

create or replace function public.exercises_cleanup_template_refs()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.templates
  set
    exercise_ids = array_remove(exercise_ids, old.id),
    superset_with_next = array_remove(superset_with_next, old.id),
    exercise_overrides = coalesce(
      (select jsonb_object_agg(key, value)
       from jsonb_each(exercise_overrides)
       where key <> old.id::text),
      '{}'::jsonb
    )
  where old.id = any(exercise_ids)
     or old.id = any(superset_with_next)
     or exercise_overrides ? old.id::text;
  return old;
end;
$function$;

-- Keep overrides/supersets in sync when the editor saves an exercise list.
create or replace function public.save_template_exercises(p_template_id uuid, p_exercises jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
  ex jsonb;
  v_ex_id uuid;
  v_ex_type text;
  v_ex_name text;
  v_target_sets smallint;
  v_target_reps smallint;
  v_target_minutes smallint;
  v_target_seconds smallint;
  v_rest_minutes smallint;
  v_rest_seconds smallint;
  v_increment real;
  v_current_weight real;
  v_catalog_id int;
  v_muscle_ids int[];
  v_notes text;
  saved_ids uuid[] := '{}';
  result jsonb := '[]'::jsonb;
  row public.exercises;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  if not exists (
    select 1 from public.templates t
    join public.routines r on r.id = t.routine_id
    where t.id = p_template_id and r.user_id = uid
  ) then
    raise exception 'Template not found';
  end if;

  if coalesce(jsonb_array_length(p_exercises), 0) = 0 then
    update public.templates
    set exercise_ids = '{}', exercise_overrides = '{}', superset_with_next = '{}'
    where id = p_template_id;
    return '[]'::jsonb;
  end if;

  for ex in select * from jsonb_array_elements(p_exercises)
  loop
    v_ex_type := coalesce(ex->>'exercise_type', 'reps');
    if v_ex_type not in ('reps', 'time') then
      raise exception 'Invalid exercise type';
    end if;

    v_ex_name := upper(trim(coalesce(ex->>'name', 'EXERCISE')));
    if char_length(v_ex_name) = 0 then
      raise exception 'Exercise name required';
    end if;
    if char_length(v_ex_name) > 24 then
      v_ex_name := left(v_ex_name, 24);
    end if;

    v_target_sets := least(12, greatest(0, coalesce((ex->>'target_sets')::int, 0)));

    if v_ex_type = 'reps' then
      v_target_reps := least(999, greatest(1, coalesce((ex->>'target_reps')::int, 1)));
      v_target_minutes := null;
      v_target_seconds := null;
      v_increment := least(500::real, greatest(0::real, coalesce((ex->>'increment')::real, 0)));
      v_current_weight := case
        when ex->>'current_weight' is null or btrim(ex->>'current_weight') = '' then null
        else least(500::real, greatest(0::real, (ex->>'current_weight')::real))
      end;
    else
      v_target_reps := null;
      v_target_minutes := least(99, greatest(0, coalesce((ex->>'target_minutes')::int, 0)));
      v_target_seconds := least(59, greatest(0, coalesce((ex->>'target_seconds')::int, 0)));
      v_increment := least(1000::real, greatest(0::real, coalesce((ex->>'increment')::real, 0)));
      v_current_weight := null;
    end if;

    v_rest_minutes := least(99, greatest(0, coalesce((ex->>'rest_minutes')::int, 0)));
    v_rest_seconds := least(59, greatest(0, coalesce((ex->>'rest_seconds')::int, 0)));

    v_catalog_id := null;
    begin
      if ex->>'catalog_exercise_id' ~ '^\d+$' then
        v_catalog_id := (ex->>'catalog_exercise_id')::int;
      end if;
    exception when others then
      v_catalog_id := null;
    end;
    if v_catalog_id is not null and not exists (
      select 1 from public.wger_exercises where id = v_catalog_id
    ) then
      v_catalog_id := null;
    end if;

    v_muscle_ids := '{}'::int[];
    begin
      if jsonb_typeof(ex->'catalog_muscle_ids') = 'array' then
        select coalesce(array_agg(value::int), '{}'::int[])
        into v_muscle_ids
        from jsonb_array_elements_text(ex->'catalog_muscle_ids') as t(value)
        where value ~ '^\d+$';
      end if;
    exception when others then
      v_muscle_ids := '{}'::int[];
    end;

    v_notes := nullif(left(btrim(coalesce(ex->>'notes', '')), 2000), '');

    v_ex_id := null;
    begin
      if ex->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         and not (ex->>'id') like 'temp-%' then
        v_ex_id := (ex->>'id')::uuid;
      end if;
    exception when others then
      v_ex_id := null;
    end;

    if v_ex_id is not null and exists (
      select 1 from public.exercises e where e.id = v_ex_id and e.user_id = uid
    ) then
      update public.exercises set
        name = v_ex_name,
        exercise_type = v_ex_type,
        target_sets = v_target_sets,
        target_reps = v_target_reps,
        target_minutes = v_target_minutes,
        target_seconds = v_target_seconds,
        rest_minutes = v_rest_minutes,
        rest_seconds = v_rest_seconds,
        increment = v_increment,
        current_weight = v_current_weight,
        catalog_exercise_id = coalesce(v_catalog_id, catalog_exercise_id),
        catalog_muscle_ids = case when cardinality(v_muscle_ids) > 0 then v_muscle_ids else catalog_muscle_ids end,
        notes = v_notes
      where id = v_ex_id and user_id = uid
      returning * into row;
    else
      insert into public.exercises (
        user_id, name, exercise_type, target_sets, target_reps,
        target_minutes, target_seconds, rest_minutes, rest_seconds, increment,
        current_weight, catalog_exercise_id, catalog_muscle_ids, notes
      ) values (
        uid, v_ex_name, v_ex_type, v_target_sets, v_target_reps,
        v_target_minutes, v_target_seconds, v_rest_minutes, v_rest_seconds, v_increment,
        v_current_weight, v_catalog_id, v_muscle_ids, v_notes
      )
      returning * into row;
      v_ex_id := row.id;
    end if;

    saved_ids := array_append(saved_ids, v_ex_id);

    result := result || jsonb_build_array(
      to_jsonb(row) || jsonb_build_object('display_order', jsonb_array_length(result))
    );
  end loop;

  update public.templates
  set
    exercise_ids = saved_ids,
    superset_with_next = coalesce(
      (select array_agg(x) from unnest(superset_with_next) x where x = any(saved_ids)),
      '{}'::uuid[]
    ),
    exercise_overrides = coalesce(
      (select jsonb_object_agg(key, value)
       from jsonb_each(exercise_overrides)
       where key = any(array(select x::text from unnest(saved_ids) x))),
      '{}'::jsonb
    )
  where id = p_template_id;

  return result;
end;
$function$;

-- -----------------------------------------------------------------------------
-- 5. Preferences
-- -----------------------------------------------------------------------------

create or replace function public.save_user_preferences(p_preferences jsonb)
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
  if p_preferences is null or jsonb_typeof(p_preferences) <> 'object' then
    raise exception 'Invalid preferences';
  end if;
  if octet_length(p_preferences::text) > 16384 then
    raise exception 'Preferences too large';
  end if;

  perform public.ensure_username_row(uid);
  update public.usernames
  set preferences = p_preferences
  where user_id = uid;
end;
$function$;

-- -----------------------------------------------------------------------------
-- 6. Copy routine with cycle + overrides intact
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
  mapped_overrides jsonb;
  mapped_supersets uuid[];
  mapped_slots jsonb;
  v_eid uuid;
  v_over jsonb;
  v_raw text;
  d smallint;
  old_tid uuid;
  new_tid uuid;
  created_count int := 0;
  slot_count int;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  select id, user_id, name, schedule_mode, cycle_length, cycle_anchor_date, cycle_slots
  into src
  from public.routines
  where id = p_source_routine_id;

  if not found then
    raise exception 'Routine not found';
  end if;

  select username into owner_name from public.usernames where user_id = src.user_id;

  select coalesce(max(display_order), -1) + 1 into next_order
  from public.routines where user_id = uid;

  clean_name := upper(btrim(
    case
      when src.user_id = uid then src.name
      else src.name || ' - ' || coalesce(owner_name, 'unknown')
    end
  ));
  if clean_name = '' then clean_name := 'ROUTINE'; end if;
  clean_name := left(clean_name, 18);

  insert into public.routines (
    user_id, name, display_order, schedule_mode, cycle_length, cycle_anchor_date, cycle_slots
  ) values (
    uid, clean_name, next_order, 'weekly', 7, current_date, '[]'::jsonb
  )
  returning * into new_routine;

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
      increment, current_weight, catalog_exercise_id, catalog_muscle_ids, notes
    ) values (
      new_ex_id, uid, ex.name, ex.exercise_type, ex.target_sets, ex.target_reps,
      ex.target_minutes, ex.target_seconds, ex.rest_minutes, ex.rest_seconds,
      ex.increment, null, ex.catalog_exercise_id, ex.catalog_muscle_ids, ex.notes
    );
    ex_map := ex_map || jsonb_build_object(ex.id::text, new_ex_id::text);
  end loop;

  for tpl in
    select * from public.templates
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

    mapped_overrides := '{}'::jsonb;
    for v_raw, v_over in
      select key, value from jsonb_each(tpl.exercise_overrides)
    loop
      if ex_map ? v_raw then
        mapped_overrides := mapped_overrides || jsonb_build_object(
          ex_map->>v_raw,
          v_over
        );
      end if;
    end loop;

    mapped_supersets := array[]::uuid[];
    foreach v_eid in array coalesce(tpl.superset_with_next, array[]::uuid[]) loop
      if ex_map ? v_eid::text then
        mapped_supersets := array_append(mapped_supersets, (ex_map->>v_eid::text)::uuid);
      end if;
    end loop;

    insert into public.templates (
      id, routine_id, name, color, icon, display_order, exercise_ids,
      exercise_overrides, superset_with_next
    ) values (
      new_tpl_id, new_routine.id, tpl.name, tpl.color, tpl.icon,
      created_count, mapped_ids, mapped_overrides, mapped_supersets
    );
    tpl_map := tpl_map || jsonb_build_object(tpl.id::text, new_tpl_id::text);
    created_count := created_count + 1;
  end loop;

  if src.schedule_mode = 'cycle' then
    mapped_slots := '[]'::jsonb;
    slot_count := greatest(1, coalesce(src.cycle_length, 7));
    for d in 0..(slot_count - 1) loop
      v_raw := src.cycle_slots->>d;
      if v_raw is not null and v_raw <> 'null' and tpl_map ? v_raw then
        mapped_slots := mapped_slots || to_jsonb((tpl_map->>v_raw)::uuid);
      else
        mapped_slots := mapped_slots || 'null'::jsonb;
      end if;
    end loop;

    update public.routines set
      schedule_mode = 'cycle',
      cycle_length = slot_count,
      cycle_anchor_date = current_date,
      cycle_slots = mapped_slots
    where id = new_routine.id;
  else
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
  end if;

  return jsonb_build_object(
    'id', new_routine.id,
    'user_id', new_routine.user_id,
    'name', new_routine.name,
    'created_at', new_routine.created_at,
    'display_order', new_routine.display_order,
    'schedule_mode', src.schedule_mode,
    'cycle_length', src.cycle_length,
    'template_count', created_count,
    'source_name', src.name,
    'source_username', coalesce(owner_name, 'unknown')
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 7. Grants for new functions
-- -----------------------------------------------------------------------------

revoke all on function public.routine_slot_template(uuid, date) from public, anon, authenticated;
grant execute on function public.routine_slot_template(uuid, date) to authenticated, service_role;
revoke all on function public.materialize_active_routine_week(uuid, uuid, date) from public, anon, authenticated;
grant execute on function public.materialize_active_routine_week(uuid, uuid, date) to service_role;
revoke all on function public.save_routine_cycle(uuid, integer, date, jsonb) from public, anon, authenticated;
grant execute on function public.save_routine_cycle(uuid, integer, date, jsonb) to authenticated, service_role;
revoke all on function public.reset_routine_to_weekly(uuid) from public, anon, authenticated;
grant execute on function public.reset_routine_to_weekly(uuid) to authenticated, service_role;
revoke all on function public.save_user_preferences(jsonb) from public, anon, authenticated;
grant execute on function public.save_user_preferences(jsonb) to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
