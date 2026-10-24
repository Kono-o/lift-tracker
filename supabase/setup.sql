-- =============================================================================
-- Lift Tracker — Database Setup (Full Initialization)
-- =============================================================================
-- Run in Supabase Dashboard → SQL Editor → New query → paste entire file → Run
--   or: ./scripts/setup-db.fish --yes          (full reset)
--   or: ./scripts/setup-db.fish --users-only   (wipe users + data, keep schema)
--
-- SAFE TO RE-RUN: drops app objects first, then recreates everything.
--
-- WARNING: Permanently deletes all rows in app tables AND all auth.users.
--
-- Generated from the live schema on 2026-10-24. Schema notes:
--   - routines own templates (templates.routine_id, templates.exercise_ids)
--   - routines run in 'weekly' mode (routine_schedules + materialized schedule)
--     or 'cycle' mode, an arbitrary 1-28 day loop anchored on cycle_anchor_date
--     stored as cycle_slots (JSON array of template ids / null rest days)
--   - templates may override exercise targets per day via exercise_overrides and
--     mark supersets with superset_with_next (each id chains to the next)
--   - exercises is a shared, per-user library referenced by UUID arrays
--   - wger_* tables are a public read-only exercise catalog imported from wger.de
--   - workout_history: composite PK (user_id, workout_date) — one row/day
--   - exercise_personal_bests: per-user PR lookup (exercise_id, user_id)
--   - all SECURITY DEFINER RPCs require auth.uid(); delete_all_accounts is
--     restricted to service_role/postgres
-- =============================================================================

begin;


-- -----------------------------------------------------------------------------
-- 1. Drop triggers and all app objects (safe dependency order)
-- -----------------------------------------------------------------------------

drop trigger if exists on_auth_user_created on auth.users;
drop trigger if exists on_auth_user_username on auth.users;


drop function if exists public.assign_schedule_days(jsonb) cascade;
drop function if exists public.bookmark_routine(uuid) cascade;
drop function if exists public.complete_workout_session(date,uuid,text,integer,jsonb,jsonb,jsonb) cascade;
drop function if exists public.copy_routine(uuid) cascade;
drop function if exists public.create_template(uuid,text) cascade;
drop function if exists public.delete_all_accounts() cascade;
drop function if exists public.delete_own_account() cascade;
drop function if exists public.delete_own_routine(uuid) cascade;
drop function if exists public.delete_workout_log(date) cascade;
drop function if exists public.ensure_username_row(uuid,text) cascade;
drop function if exists public.exercise_personal_bests_validate() cascade;
drop function if exists public.exercises_cleanup_template_refs() cascade;
drop function if exists public.templates_cleanup_cycle_slots() cascade;
drop function if exists public.routine_schedules_mark_weekly() cascade;
drop function if exists public.get_avatar_seed() cascade;
drop function if exists public.materialize_active_routine_week(uuid, uuid, date) cascade;
drop function if exists public.reset_routine_to_weekly(uuid) cascade;
drop function if exists public.routine_slot_template(uuid, date) cascade;
drop function if exists public.save_routine_cycle(uuid, integer, date, jsonb) cascade;
drop function if exists public.save_user_preferences(jsonb) cascade;
drop function if exists public.get_own_data_usage() cascade;
drop function if exists public.handle_auth_user_username() cascade;
drop function if exists public.handle_new_user_schedule() cascade;
drop function if exists public.is_username_available(text) cascade;
drop function if exists public.register_username(text) cascade;
drop function if exists public.rename_username(text) cascade;
drop function if exists public.resync_active_bookmarked_routine() cascade;
drop function if exists public.routine_bookmarks_validate() cascade;
drop function if exists public.save_avatar_seed(text) cascade;
drop function if exists public.save_routine_schedule(uuid,jsonb) cascade;
drop function if exists public.save_stat_log(uuid,date,real) cascade;
drop function if exists public.save_template_exercises(uuid,jsonb) cascade;
drop function if exists public.save_tracked_stats(jsonb) cascade;
drop function if exists public.save_workout_progress(date,uuid,text,jsonb) cascade;
drop function if exists public.set_active_routine(uuid) cascade;
drop function if exists public.skip_workout_log(date,uuid,text) cascade;
drop function if exists public.unbookmark_routine(uuid) cascade;
drop function if exists public.update_template_display_orders(jsonb) cascade;
drop function if exists public.create_template(text) cascade;
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

drop table if exists public.exercise_personal_bests cascade;
drop table if exists public.exercises cascade;
drop table if exists public.wger_exercise_muscles cascade;
drop table if exists public.wger_exercise_equipment cascade;
drop table if exists public.wger_exercises cascade;
drop table if exists public.wger_muscles cascade;
drop table if exists public.wger_equipment cascade;
drop table if exists public.wger_categories cascade;
drop table if exists public.routine_bookmarks cascade;
drop table if exists public.routine_schedules cascade;
drop table if exists public.routines cascade;
drop table if exists public.schedule cascade;
drop table if exists public.stat_logs cascade;
drop table if exists public.templates cascade;
drop table if exists public.tracked_stats cascade;
drop table if exists public.usernames cascade;
drop table if exists public.workout_history cascade;
drop table if exists public.template_exercises cascade;
drop table if exists public.week_schedule_days cascade;
drop table if exists public.week_schedules cascade;
drop table if exists public.user_active_schedules cascade;
drop table if exists public.user_schedule_tags cascade;
drop table if exists public.bodyweight_logs cascade;


-- Full reset: remove accounts after the app tables are gone.
delete from auth.users;


-- -----------------------------------------------------------------------------
-- 2. Core tables
-- -----------------------------------------------------------------------------

create table public.exercise_personal_bests (
  exercise_id uuid not null,
  user_id uuid not null,
  best_weight real default 0 not null,
  achieved_on date,
  updated_at timestamp with time zone default now() not null
);

create table public.exercises (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  name text default 'Exercise'::text not null,
  exercise_type text default 'reps'::text not null,
  target_sets smallint default 0 not null,
  target_reps smallint,
  target_minutes smallint,
  target_seconds smallint,
  increment real default 0 not null,
  current_weight real,
  created_at timestamp with time zone default now() not null,
  rest_minutes smallint default 0,
  rest_seconds smallint default 0,
  catalog_exercise_id integer,
  catalog_muscle_ids integer[] default '{}'::integer[] not null,
  notes text
);

create table public.routine_bookmarks (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  routine_id uuid not null,
  created_at timestamp with time zone default now() not null,
  display_order integer default 0 not null
);

create table public.routine_schedules (
  routine_id uuid not null,
  day_of_week smallint not null,
  template_id uuid
);

create table public.routines (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  name text not null,
  created_at timestamp with time zone default now() not null,
  display_order integer default 0 not null,
  schedule_mode text default 'weekly'::text not null,
  cycle_length smallint default 7 not null,
  cycle_anchor_date date default current_date not null,
  cycle_slots jsonb default '[]'::jsonb not null
);

create table public.schedule (
  user_id uuid not null,
  day_of_week smallint not null,
  template_id uuid,
  updated_at timestamp with time zone default now() not null
);

create table public.stat_logs (
  user_id uuid not null,
  stat_id uuid not null,
  log_date date not null,
  value real not null,
  stat_name_snapshot text not null,
  stat_unit_snapshot text default ''::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table public.templates (
  id uuid default gen_random_uuid() not null,
  name text not null,
  color smallint default 242 not null,
  display_order integer default 0 not null,
  created_at timestamp with time zone default now() not null,
  icon smallint default 1 not null,
  routine_id uuid not null,
  exercise_ids uuid[] default '{}'::uuid[],
  exercise_overrides jsonb default '{}'::jsonb not null,
  superset_with_next uuid[] default '{}'::uuid[] not null
);

create table public.tracked_stats (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  name text not null,
  unit text default ''::text not null,
  display_order integer default 0 not null,
  start_value real default 0 not null,
  has_target boolean default false not null,
  target_value real,
  created_at timestamp with time zone default now() not null,
  icon smallint default 0 not null,
  target_prefers_lower boolean default true not null,
  color smallint default 242 not null
);

create table public.usernames (
  username text not null,
  user_id uuid not null,
  avatar_seed text,
  created_at timestamp with time zone default now() not null,
  active_routine_id uuid,
  preferences jsonb default '{}'::jsonb not null
);

create table public.workout_history (
  user_id uuid not null,
  workout_date date not null,
  template_id uuid,
  template_name_snapshot text,
  workout_status smallint default 0 not null,
  is_skipped boolean default false not null,
  duration_seconds integer,
  is_perfect_day boolean default false not null,
  performance_snapshot jsonb default '{}'::jsonb not null,
  workout_snapshot jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null
);

-- Public read-only exercise catalog imported from wger.de.
create table public.wger_categories (
  id integer primary key,
  name text not null
);

create table public.wger_equipment (
  id integer primary key,
  name text not null
);

create table public.wger_muscles (
  id integer primary key,
  name text not null,
  name_en text,
  is_front boolean default true not null,
  image_url_main text,
  image_url_secondary text
);

create table public.wger_exercises (
  id integer primary key,
  uuid uuid unique,
  name text not null,
  description text default ''::text not null,
  category_id integer references public.wger_categories(id) on delete set null,
  license text,
  license_author text,
  license_url text,
  wger_updated_at timestamp with time zone,
  created_at timestamp with time zone default now() not null
);

create table public.wger_exercise_equipment (
  exercise_id integer not null references public.wger_exercises(id) on delete cascade,
  equipment_id integer not null references public.wger_equipment(id) on delete cascade,
  primary key (exercise_id, equipment_id)
);

create table public.wger_exercise_muscles (
  exercise_id integer not null references public.wger_exercises(id) on delete cascade,
  muscle_id integer not null references public.wger_muscles(id) on delete cascade,
  is_primary boolean default true not null,
  primary key (exercise_id, muscle_id)
);

-- -----------------------------------------------------------------------------
-- 3. Constraints
-- -----------------------------------------------------------------------------
alter table public.exercise_personal_bests add constraint exercise_personal_bests_pkey PRIMARY KEY (exercise_id, user_id);
alter table public.exercises add constraint exercises_pkey PRIMARY KEY (id);
alter table public.routine_bookmarks add constraint routine_bookmarks_pkey PRIMARY KEY (id);
alter table public.routine_schedules add constraint routine_schedules_pkey PRIMARY KEY (routine_id, day_of_week);
alter table public.routines add constraint routines_pkey PRIMARY KEY (id);
alter table public.schedule add constraint schedule_pkey PRIMARY KEY (user_id, day_of_week);
alter table public.stat_logs add constraint stat_logs_pkey PRIMARY KEY (user_id, stat_id, log_date);
alter table public.templates add constraint templates_pkey PRIMARY KEY (id);
alter table public.tracked_stats add constraint tracked_stats_pkey PRIMARY KEY (id);
alter table public.usernames add constraint usernames_pkey PRIMARY KEY (username);
alter table public.workout_history add constraint workout_history_pkey PRIMARY KEY (user_id, workout_date);
alter table public.routine_bookmarks add constraint routine_bookmarks_user_id_routine_id_key UNIQUE (user_id, routine_id);
alter table public.usernames add constraint usernames_user_id_key UNIQUE (user_id);
alter table public.exercise_personal_bests add constraint exercise_personal_bests_weight_nonneg CHECK (best_weight >= 0::double precision);
alter table public.exercises add constraint exercises_reps_fields CHECK (exercise_type <> 'reps'::text OR target_reps IS NOT NULL AND target_minutes IS NULL AND target_seconds IS NULL);
alter table public.exercises add constraint exercises_target_sets_range CHECK (target_sets >= 0 AND target_sets <= 12);
alter table public.exercises add constraint exercises_time_fields CHECK (exercise_type <> 'time'::text OR target_reps IS NULL AND target_minutes IS NOT NULL AND target_seconds IS NOT NULL);
alter table public.exercises add constraint exercises_time_no_weight CHECK (exercise_type <> 'time'::text OR current_weight IS NULL);
alter table public.exercises add constraint exercises_type_check CHECK (exercise_type = ANY (ARRAY['reps'::text, 'time'::text]));
alter table public.routine_schedules add constraint routine_schedules_day_of_week_check CHECK (day_of_week >= 0 AND day_of_week <= 6);
alter table public.routines add constraint routines_name_not_empty CHECK (char_length(TRIM(BOTH FROM name)) > 0);
alter table public.routines add constraint routines_schedule_mode_check CHECK (schedule_mode = ANY (ARRAY['weekly'::text, 'cycle'::text]));
alter table public.routines add constraint routines_cycle_length_check CHECK (cycle_length >= 1 AND cycle_length <= 28);
alter table public.routines add constraint routines_cycle_slots_check CHECK (jsonb_typeof(cycle_slots) = 'array');
alter table public.schedule add constraint schedule_day_of_week_check CHECK (day_of_week >= 0 AND day_of_week <= 6);
alter table public.stat_logs add constraint stat_logs_name_not_empty CHECK (char_length(TRIM(BOTH FROM stat_name_snapshot)) > 0);
alter table public.stat_logs add constraint stat_logs_value_positive CHECK (value > 0::double precision);
alter table public.templates add constraint templates_color_range CHECK (color >= 0 AND color <= 255);
alter table public.templates add constraint templates_display_order_nonneg CHECK (display_order >= 0);
alter table public.templates add constraint templates_icon_range CHECK (icon >= 0 AND icon <= 31);
alter table public.templates add constraint templates_name_not_empty CHECK (char_length(TRIM(BOTH FROM name)) > 0);
alter table public.templates add constraint templates_exercise_overrides_check CHECK (jsonb_typeof(exercise_overrides) = 'object');
alter table public.tracked_stats add constraint tracked_stats_color_range CHECK (color >= 0 AND color <= 255);
alter table public.tracked_stats add constraint tracked_stats_display_order_nonneg CHECK (display_order >= 0);
alter table public.tracked_stats add constraint tracked_stats_icon_range CHECK (icon >= 0 AND icon <= 31);
alter table public.tracked_stats add constraint tracked_stats_name_not_empty CHECK (char_length(TRIM(BOTH FROM name)) > 0);
alter table public.tracked_stats add constraint tracked_stats_start_value_nonneg CHECK (start_value >= 0::double precision);
alter table public.tracked_stats add constraint tracked_stats_target_valid CHECK (has_target = false AND target_value IS NULL OR has_target = true AND target_value IS NOT NULL AND target_value > 0::double precision);
alter table public.usernames add constraint usernames_format CHECK (username ~ '^[a-z0-9_-]{3,24}$'::text);
alter table public.usernames add constraint usernames_preferences_check CHECK (jsonb_typeof(preferences) = 'object');
alter table public.workout_history add constraint workout_history_duration_seconds_check CHECK (duration_seconds IS NULL OR duration_seconds >= 1);
alter table public.workout_history add constraint workout_history_skip_consistency CHECK (workout_status = 1 AND is_skipped = true OR workout_status <> 1 AND is_skipped = false);
alter table public.workout_history add constraint workout_history_status_check CHECK (workout_status >= 0 AND workout_status <= 3);
alter table public.exercise_personal_bests add constraint exercise_personal_bests_exercise_id_fkey FOREIGN KEY (exercise_id) REFERENCES exercises(id) ON DELETE CASCADE;
alter table public.exercise_personal_bests add constraint exercise_personal_bests_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.exercises add constraint exercises_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.exercises add constraint exercises_catalog_exercise_id_fkey FOREIGN KEY (catalog_exercise_id) REFERENCES public.wger_exercises(id) ON DELETE SET NULL;
alter table public.routine_bookmarks add constraint routine_bookmarks_routine_id_fkey FOREIGN KEY (routine_id) REFERENCES routines(id) ON DELETE CASCADE;
alter table public.routine_bookmarks add constraint routine_bookmarks_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.routine_schedules add constraint routine_schedules_routine_id_fkey FOREIGN KEY (routine_id) REFERENCES routines(id) ON DELETE CASCADE;
alter table public.routine_schedules add constraint routine_schedules_template_id_fkey FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE SET NULL;
alter table public.routines add constraint routines_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.schedule add constraint schedule_template_id_fkey FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE SET NULL;
alter table public.schedule add constraint schedule_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.stat_logs add constraint stat_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.templates add constraint templates_routine_id_fkey FOREIGN KEY (routine_id) REFERENCES routines(id) ON DELETE CASCADE;
alter table public.tracked_stats add constraint tracked_stats_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.usernames add constraint usernames_active_routine_id_fkey FOREIGN KEY (active_routine_id) REFERENCES routines(id) ON DELETE SET NULL;
alter table public.usernames add constraint usernames_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.workout_history add constraint workout_history_template_id_fkey FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE SET NULL;
alter table public.workout_history add constraint workout_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- -----------------------------------------------------------------------------
-- 4. Indexes (those not owned by constraints)
-- -----------------------------------------------------------------------------

CREATE INDEX exercise_personal_bests_user_id_idx ON public.exercise_personal_bests USING btree (user_id);
CREATE INDEX exercises_user_id_idx ON public.exercises USING btree (user_id);
CREATE INDEX routine_bookmarks_display_order_idx ON public.routine_bookmarks USING btree (user_id, display_order);
CREATE INDEX routine_bookmarks_routine_id_idx ON public.routine_bookmarks USING btree (routine_id);
CREATE INDEX routine_bookmarks_user_id_idx ON public.routine_bookmarks USING btree (user_id);
CREATE INDEX routine_schedules_routine_id_idx ON public.routine_schedules USING btree (routine_id);
CREATE INDEX routine_schedules_template_id_idx ON public.routine_schedules USING btree (template_id) WHERE (template_id IS NOT NULL);
CREATE INDEX routines_display_order_idx ON public.routines USING btree (user_id, display_order);
CREATE INDEX routines_user_id_idx ON public.routines USING btree (user_id);
CREATE INDEX schedule_template_id_idx ON public.schedule USING btree (template_id) WHERE (template_id IS NOT NULL);
CREATE INDEX stat_logs_user_stat_date_idx ON public.stat_logs USING btree (user_id, stat_id, log_date DESC);
CREATE INDEX templates_routine_id_idx ON public.templates USING btree (routine_id);
CREATE INDEX templates_superset_with_next_idx ON public.templates USING gin (superset_with_next);
CREATE INDEX tracked_stats_user_order_idx ON public.tracked_stats USING btree (user_id, display_order);
CREATE INDEX wger_exercises_category_idx ON public.wger_exercises USING btree (category_id);
CREATE INDEX wger_exercises_name_lower_idx ON public.wger_exercises USING btree (lower(name));
CREATE INDEX wger_exercise_equipment_equipment_idx ON public.wger_exercise_equipment USING btree (equipment_id);
CREATE INDEX wger_exercise_muscles_muscle_idx ON public.wger_exercise_muscles USING btree (muscle_id);
CREATE INDEX workout_history_perfect_day_idx ON public.workout_history USING btree (user_id, is_perfect_day) WHERE (is_perfect_day = true);
CREATE INDEX workout_history_status_idx ON public.workout_history USING btree (user_id, workout_status);
CREATE INDEX workout_history_user_date_idx ON public.workout_history USING btree (user_id, workout_date DESC);

-- -----------------------------------------------------------------------------
-- 5. RPCs, triggers helpers, auth hook functions
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assign_schedule_days(p_assignments jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

CREATE OR REPLACE FUNCTION public.bookmark_routine(p_routine_id uuid)
 RETURNS routine_bookmarks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  next_order int;
  row public.routine_bookmarks;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  -- Validate access / not own / exists via trigger + explicit check
  if not exists (select 1 from public.routines r where r.id = p_routine_id) then
    raise exception 'Routine not found';
  end if;

  if exists (
    select 1 from public.routines r where r.id = p_routine_id and r.user_id = uid
  ) then
    raise exception 'Cannot bookmark your own routine';
  end if;

  select coalesce(max(display_order), -1) + 1 into next_order
  from public.routine_bookmarks
  where user_id = uid;

  insert into public.routine_bookmarks (user_id, routine_id, display_order)
  values (uid, p_routine_id, next_order)
  on conflict (user_id, routine_id) do update
    set display_order = public.routine_bookmarks.display_order
  returning * into row;

  return row;
end;
$function$;

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
  use_override boolean;
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
    use_override := coalesce((ex->>'use_override')::boolean, false);

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
      -- Day-specific overrides progress independently: the client persists the
      -- next weight onto the template override, so the shared base stays intact.
      if is_owned and not use_override then
        update public.exercises
        set current_weight = next_weight
        where id = ex_id
          and user_id = uid;
      elsif not is_owned then
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

CREATE OR REPLACE FUNCTION public.create_template(p_routine_id uuid, p_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  uid uuid := auth.uid();
  safe_name text;
  next_order integer;
  row public.templates;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  if not exists (
    select 1 from public.routines r
    where r.id = p_routine_id and r.user_id = uid
  ) then
    raise exception 'Routine not found';
  end if;

  safe_name := upper(trim(coalesce(p_name, '')));
  if char_length(safe_name) = 0 then
    safe_name := 'NEW TEMPLATE';
  end if;
  if char_length(safe_name) > 18 then
    safe_name := left(safe_name, 18);
  end if;

  select coalesce(max(t.display_order), -1) + 1
  into next_order
  from public.templates t
  where t.routine_id = p_routine_id;

  insert into public.templates (routine_id, name, color, icon, display_order, exercise_ids)
  values (p_routine_id, safe_name, 242, 1, next_order, '{}')
  returning * into row;

  return to_jsonb(row);
end;
$function$;

CREATE OR REPLACE FUNCTION public.delete_all_accounts()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
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

CREATE OR REPLACE FUNCTION public.delete_own_account()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.delete_own_routine(p_routine_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  owner uuid;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  select user_id into owner from public.routines where id = p_routine_id;
  if owner is null then
    raise exception 'Routine not found';
  end if;
  if owner <> uid then
    raise exception 'Only the owner can delete this routine';
  end if;

  -- Clear active pointer for this user first (bookmarks cascade with routine delete)
  update public.usernames
    set active_routine_id = null
    where user_id = uid and active_routine_id = p_routine_id;

  delete from public.routines where id = p_routine_id and user_id = uid;
end;
$function$;

CREATE OR REPLACE FUNCTION public.delete_workout_log(p_workout_date date)
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

  delete from public.workout_history
  where user_id = uid
    and workout_date = p_workout_date;
end;
$function$;

CREATE OR REPLACE FUNCTION public.exercise_personal_bests_validate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

CREATE OR REPLACE FUNCTION public.templates_cleanup_cycle_slots()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update public.routines r
  set cycle_slots = coalesce(
    (select jsonb_agg(
       case when slot.value = to_jsonb(old.id) then 'null'::jsonb else slot.value end
       order by slot.ord
     )
     from jsonb_array_elements(r.cycle_slots) with ordinality as slot(value, ord)),
    '[]'::jsonb
  )
  where r.cycle_slots @> jsonb_build_array(to_jsonb(old.id));
  return old;
end;
$function$;

CREATE OR REPLACE FUNCTION public.routine_schedules_mark_weekly()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update public.routines
  set schedule_mode = 'weekly', cycle_length = 7, cycle_slots = '[]'::jsonb
  where id = new.routine_id
    and schedule_mode <> 'weekly';
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_avatar_seed()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  seed text;
begin
  if uid is null then
    return null;
  end if;
  select avatar_seed into seed
  from public.usernames
  where user_id = uid
  limit 1;
  return seed;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_own_data_usage()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.ensure_username_row(p_user_id uuid, p_base text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

CREATE OR REPLACE FUNCTION public.handle_auth_user_username()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
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

CREATE OR REPLACE FUNCTION public.handle_new_user_schedule()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
    insert into public.schedule (user_id, day_of_week)
    values
        (new.id, 0),
        (new.id, 1),
        (new.id, 2),
        (new.id, 3),
        (new.id, 4),
        (new.id, 5),
        (new.id, 6)
    on conflict (user_id, day_of_week) do nothing;
    return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.is_username_available(p_username text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  u text := lower(trim(p_username));
begin
  if u is null or u = '' or u !~ '^[a-z0-9_-]{3,24}$' then
    return false;
  end if;
  return not exists (select 1 from public.usernames where username = u);
end;
$function$;

CREATE OR REPLACE FUNCTION public.register_username(p_username text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  u text := lower(trim(p_username));
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;
  if u is null or u = '' or u !~ '^[a-z0-9_-]{3,24}$' then
    raise exception 'Invalid username';
  end if;
  begin
    insert into public.usernames (username, user_id) values (u, uid);
  exception
    when unique_violation then
      if exists (
        select 1 from public.usernames where username = u and user_id = uid
      ) then
        return;
      end if;
      raise exception 'Username already taken' using errcode = '23505';
  end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.rename_username(p_new_username text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
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

CREATE OR REPLACE FUNCTION public.resync_active_bookmarked_routine()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  active_id uuid;
  owner uuid;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  select active_routine_id into active_id
  from public.usernames
  where user_id = uid;

  if active_id is null then
    return false;
  end if;

  select user_id into owner from public.routines where id = active_id;
  if owner is null then
    update public.usernames set active_routine_id = null where user_id = uid;
    return false;
  end if;

  -- Only resync when active is someone else's and still bookmarked
  if owner = uid then
    return false;
  end if;

  if not exists (
    select 1 from public.routine_bookmarks b
    where b.user_id = uid and b.routine_id = active_id
  ) then
    update public.usernames set active_routine_id = null where user_id = uid;
    return false;
  end if;

  perform public.set_active_routine(active_id);
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.routine_bookmarks_validate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  owner_id uuid;
begin
  if new.user_id is null or new.routine_id is null then
    raise exception 'Invalid bookmark';
  end if;

  select r.user_id into owner_id
  from public.routines r
  where r.id = new.routine_id;

  if owner_id is null then
    raise exception 'Routine not found';
  end if;

  if owner_id = new.user_id then
    raise exception 'Cannot bookmark your own routine';
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.save_avatar_seed(p_seed text)
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
  perform public.ensure_username_row(uid);
  update public.usernames
  set avatar_seed = p_seed
  where user_id = uid;
end;
$function$;

CREATE OR REPLACE FUNCTION public.save_routine_schedule(p_routine_id uuid, p_schedule jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

CREATE OR REPLACE FUNCTION public.save_stat_log(p_stat_id uuid, p_log_date date, p_value real)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

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

CREATE OR REPLACE FUNCTION public.save_tracked_stats(p_stats jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.save_workout_progress(p_workout_date date, p_template_id uuid, p_template_name text, p_performance_snapshot jsonb)
 RETURNS workout_history
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  row public.workout_history;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

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
    3,
    false,
    null,
    false,
    coalesce(p_performance_snapshot, '{}'::jsonb),
    '{"in_progress": true}'::jsonb
  )
  on conflict (user_id, workout_date) do update set
    template_id = excluded.template_id,
    template_name_snapshot = excluded.template_name_snapshot,
    workout_status = 3,
    is_skipped = false,
    duration_seconds = null,
    is_perfect_day = false,
    performance_snapshot = excluded.performance_snapshot,
    workout_snapshot = '{"in_progress": true}'::jsonb
  returning * into row;

  return row;
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

CREATE OR REPLACE FUNCTION public.skip_workout_log(p_workout_date date, p_template_id uuid, p_template_name text)
 RETURNS workout_history
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  row public.workout_history;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

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
    1,
    true,
    null,
    false,
    '{}'::jsonb,
    '{"skipped": true}'::jsonb
  )
  on conflict (user_id, workout_date) do update set
    template_id = excluded.template_id,
    template_name_snapshot = excluded.template_name_snapshot,
    workout_status = 1,
    is_skipped = true,
    duration_seconds = null,
    is_perfect_day = false,
    performance_snapshot = '{}'::jsonb,
    workout_snapshot = '{"skipped": true}'::jsonb
  returning * into row;

  return row;
end;
$function$;

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

CREATE OR REPLACE FUNCTION public.update_template_display_orders(p_orders jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  item jsonb;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  for item in select * from jsonb_array_elements(p_orders)
  loop
    update public.templates t
    set display_order = (item->>'display_order')::int
    where t.id = (item->>'id')::uuid
      and exists (
        select 1 from public.routines r
        where r.id = t.routine_id and r.user_id = uid
      );
  end loop;
end;
$function$;

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
-- 6. Triggers
-- -----------------------------------------------------------------------------

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_schedule();
CREATE TRIGGER on_auth_user_username AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_auth_user_username();
CREATE TRIGGER exercise_personal_bests_validate_trg BEFORE INSERT OR UPDATE OF exercise_id, user_id ON public.exercise_personal_bests FOR EACH ROW EXECUTE FUNCTION public.exercise_personal_bests_validate();
CREATE TRIGGER routine_bookmarks_validate_trg BEFORE INSERT OR UPDATE OF user_id, routine_id ON public.routine_bookmarks FOR EACH ROW EXECUTE FUNCTION public.routine_bookmarks_validate();
CREATE TRIGGER exercises_cleanup_template_refs_trg AFTER DELETE ON public.exercises FOR EACH ROW EXECUTE FUNCTION public.exercises_cleanup_template_refs();
CREATE TRIGGER templates_cleanup_cycle_slots_trg AFTER DELETE ON public.templates FOR EACH ROW EXECUTE FUNCTION public.templates_cleanup_cycle_slots();
CREATE TRIGGER routine_schedules_mark_weekly_trg BEFORE INSERT OR UPDATE ON public.routine_schedules FOR EACH ROW EXECUTE FUNCTION public.routine_schedules_mark_weekly();

-- -----------------------------------------------------------------------------
-- 7. Row level security
-- -----------------------------------------------------------------------------

alter table public.exercise_personal_bests enable row level security;
alter table public.exercises enable row level security;
alter table public.routine_bookmarks enable row level security;
alter table public.routine_schedules enable row level security;
alter table public.routines enable row level security;
alter table public.schedule enable row level security;
alter table public.stat_logs enable row level security;
alter table public.templates enable row level security;
alter table public.tracked_stats enable row level security;
alter table public.usernames enable row level security;
alter table public.workout_history enable row level security;
alter table public.wger_categories enable row level security;
alter table public.wger_equipment enable row level security;
alter table public.wger_muscles enable row level security;
alter table public.wger_exercises enable row level security;
alter table public.wger_exercise_equipment enable row level security;
alter table public.wger_exercise_muscles enable row level security;

create policy "wger_categories_read" on public.wger_categories as permissive for select to anon, authenticated using (true);
create policy "wger_equipment_read" on public.wger_equipment as permissive for select to anon, authenticated using (true);
create policy "wger_muscles_read" on public.wger_muscles as permissive for select to anon, authenticated using (true);
create policy "wger_exercises_read" on public.wger_exercises as permissive for select to anon, authenticated using (true);
create policy "wger_exercise_equipment_read" on public.wger_exercise_equipment as permissive for select to anon, authenticated using (true);
create policy "wger_exercise_muscles_read" on public.wger_exercise_muscles as permissive for select to anon, authenticated using (true);

create policy "exercise_personal_bests_delete_own" on public.exercise_personal_bests as permissive for delete to authenticated using (user_id = ( SELECT auth.uid() AS uid));
create policy "exercise_personal_bests_insert_own" on public.exercise_personal_bests as permissive for insert to authenticated with check (user_id = ( SELECT auth.uid() AS uid));
create policy "exercise_personal_bests_select_own" on public.exercise_personal_bests as permissive for select to authenticated using (user_id = ( SELECT auth.uid() AS uid));
create policy "exercise_personal_bests_update_own" on public.exercise_personal_bests as permissive for update to authenticated using (user_id = ( SELECT auth.uid() AS uid)) with check (user_id = ( SELECT auth.uid() AS uid));
create policy "exercises_delete_own" on public.exercises as permissive for delete to authenticated using (user_id = ( SELECT auth.uid() AS uid));
create policy "exercises_insert_own" on public.exercises as permissive for insert to authenticated with check (user_id = ( SELECT auth.uid() AS uid));
create policy "exercises_select_all" on public.exercises as permissive for select to authenticated using (true);
create policy "exercises_update_own" on public.exercises as permissive for update to authenticated using (user_id = ( SELECT auth.uid() AS uid)) with check (user_id = ( SELECT auth.uid() AS uid));
create policy "routine_bookmarks_own_all" on public.routine_bookmarks as permissive for all to authenticated using (user_id = ( SELECT auth.uid() AS uid)) with check (user_id = ( SELECT auth.uid() AS uid));
create policy "routine_schedules_own_all" on public.routine_schedules as permissive for all to authenticated using (EXISTS ( SELECT 1
   FROM routines r
  WHERE ((r.id = routine_schedules.routine_id) AND (r.user_id = ( SELECT auth.uid() AS uid))))) with check (EXISTS ( SELECT 1
   FROM routines r
  WHERE ((r.id = routine_schedules.routine_id) AND (r.user_id = ( SELECT auth.uid() AS uid)))));
create policy "routine_schedules_select_all" on public.routine_schedules as permissive for select to authenticated using (true);
create policy "routines_own_all" on public.routines as permissive for all to authenticated using (user_id = ( SELECT auth.uid() AS uid)) with check (user_id = ( SELECT auth.uid() AS uid));
create policy "routines_select_all" on public.routines as permissive for select to authenticated using (true);
create policy "schedule_delete_own" on public.schedule as permissive for delete to authenticated using (user_id = ( SELECT auth.uid() AS uid));
create policy "schedule_insert_own" on public.schedule as permissive for insert to authenticated with check ((user_id = auth.uid()) AND ((template_id IS NULL) OR (EXISTS ( SELECT 1
   FROM (templates t
     JOIN routines r ON ((r.id = t.routine_id)))
  WHERE ((t.id = schedule.template_id) AND (r.user_id = auth.uid()))))));
create policy "schedule_select_own" on public.schedule as permissive for select to authenticated using (user_id = ( SELECT auth.uid() AS uid));
create policy "schedule_update_own" on public.schedule as permissive for update to authenticated using (user_id = auth.uid()) with check ((user_id = auth.uid()) AND ((template_id IS NULL) OR (EXISTS ( SELECT 1
   FROM (templates t
     JOIN routines r ON ((r.id = t.routine_id)))
  WHERE ((t.id = schedule.template_id) AND (r.user_id = auth.uid()))))));
create policy "stat_logs_delete_own" on public.stat_logs as permissive for delete to authenticated using (user_id = ( SELECT auth.uid() AS uid));
create policy "stat_logs_insert_own" on public.stat_logs as permissive for insert to authenticated with check (user_id = ( SELECT auth.uid() AS uid));
create policy "stat_logs_select_own" on public.stat_logs as permissive for select to authenticated using (user_id = ( SELECT auth.uid() AS uid));
create policy "stat_logs_update_own" on public.stat_logs as permissive for update to authenticated using (user_id = ( SELECT auth.uid() AS uid)) with check (user_id = ( SELECT auth.uid() AS uid));
create policy "templates_delete_own" on public.templates as permissive for delete to authenticated using (EXISTS ( SELECT 1
   FROM routines r
  WHERE ((r.id = templates.routine_id) AND (r.user_id = auth.uid()))));
create policy "templates_insert_own" on public.templates as permissive for insert to authenticated with check (EXISTS ( SELECT 1
   FROM routines r
  WHERE ((r.id = templates.routine_id) AND (r.user_id = auth.uid()))));
create policy "templates_select_all" on public.templates as permissive for select to authenticated using (true);
create policy "templates_update_own" on public.templates as permissive for update to authenticated using (EXISTS ( SELECT 1
   FROM routines r
  WHERE ((r.id = templates.routine_id) AND (r.user_id = auth.uid())))) with check (EXISTS ( SELECT 1
   FROM routines r
  WHERE ((r.id = templates.routine_id) AND (r.user_id = auth.uid()))));
create policy "tracked_stats_delete_own" on public.tracked_stats as permissive for delete to authenticated using (user_id = ( SELECT auth.uid() AS uid));
create policy "tracked_stats_insert_own" on public.tracked_stats as permissive for insert to authenticated with check (user_id = ( SELECT auth.uid() AS uid));
create policy "tracked_stats_select_own" on public.tracked_stats as permissive for select to authenticated using (user_id = ( SELECT auth.uid() AS uid));
create policy "tracked_stats_update_own" on public.tracked_stats as permissive for update to authenticated using (user_id = ( SELECT auth.uid() AS uid)) with check (user_id = ( SELECT auth.uid() AS uid));
create policy "usernames_select_all" on public.usernames as permissive for select to authenticated using (true);
create policy "usernames_update_own" on public.usernames as permissive for update to authenticated using (user_id = ( SELECT auth.uid() AS uid)) with check (user_id = ( SELECT auth.uid() AS uid));
create policy "workout_history_delete_own" on public.workout_history as permissive for delete to authenticated using (user_id = ( SELECT auth.uid() AS uid));
create policy "workout_history_insert_own" on public.workout_history as permissive for insert to authenticated with check (user_id = ( SELECT auth.uid() AS uid));
create policy "workout_history_select_own" on public.workout_history as permissive for select to authenticated using (user_id = ( SELECT auth.uid() AS uid));
create policy "workout_history_update_own" on public.workout_history as permissive for update to authenticated using (user_id = ( SELECT auth.uid() AS uid)) with check (user_id = ( SELECT auth.uid() AS uid));

-- -----------------------------------------------------------------------------
-- 8. Grants
-- -----------------------------------------------------------------------------

grant usage on schema public to anon, authenticated, service_role;

grant all on table public.exercise_personal_bests to anon, authenticated, service_role;
grant all on table public.exercises to anon, authenticated, service_role;
grant all on table public.routine_bookmarks to anon, authenticated, service_role;
grant all on table public.routine_schedules to anon, authenticated, service_role;
grant all on table public.routines to anon, authenticated, service_role;
grant all on table public.schedule to anon, authenticated, service_role;
grant all on table public.stat_logs to anon, authenticated, service_role;
grant all on table public.templates to anon, authenticated, service_role;
grant all on table public.tracked_stats to anon, authenticated, service_role;
grant all on table public.usernames to anon, authenticated, service_role;
grant all on table public.workout_history to anon, authenticated, service_role;

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

revoke all on function public.assign_schedule_days(p_assignments jsonb) from public, anon, authenticated;
grant execute on function public.assign_schedule_days(p_assignments jsonb) to authenticated, service_role;
revoke all on function public.bookmark_routine(p_routine_id uuid) from public, anon, authenticated;
grant execute on function public.bookmark_routine(p_routine_id uuid) to authenticated, service_role;
revoke all on function public.complete_workout_session(p_workout_date date, p_template_id uuid, p_template_name text, p_duration_seconds integer, p_reps jsonb, p_times jsonb, p_exercises jsonb) from public, anon, authenticated;
grant execute on function public.complete_workout_session(p_workout_date date, p_template_id uuid, p_template_name text, p_duration_seconds integer, p_reps jsonb, p_times jsonb, p_exercises jsonb) to authenticated, service_role;
revoke all on function public.copy_routine(p_source_routine_id uuid) from public, anon, authenticated;
grant execute on function public.copy_routine(p_source_routine_id uuid) to authenticated, service_role;
revoke all on function public.create_template(p_routine_id uuid, p_name text) from public, anon, authenticated;
grant execute on function public.create_template(p_routine_id uuid, p_name text) to authenticated, service_role;
revoke all on function public.delete_all_accounts() from public, anon, authenticated;
grant execute on function public.delete_all_accounts() to service_role, postgres;
revoke all on function public.delete_own_account() from public, anon, authenticated;
grant execute on function public.delete_own_account() to authenticated, service_role;
revoke all on function public.delete_own_routine(p_routine_id uuid) from public, anon, authenticated;
grant execute on function public.delete_own_routine(p_routine_id uuid) to authenticated, service_role;
revoke all on function public.delete_workout_log(p_workout_date date) from public, anon, authenticated;
grant execute on function public.delete_workout_log(p_workout_date date) to authenticated, service_role;
revoke all on function public.ensure_username_row(p_user_id uuid, p_base text) from public, anon, authenticated;
grant execute on function public.ensure_username_row(p_user_id uuid, p_base text) to service_role;
revoke all on function public.exercise_personal_bests_validate() from public, anon, authenticated;
revoke all on function public.exercises_cleanup_template_refs() from public, anon, authenticated;
revoke all on function public.templates_cleanup_cycle_slots() from public, anon, authenticated;
revoke all on function public.routine_schedules_mark_weekly() from public, anon, authenticated;
revoke all on function public.get_avatar_seed() from public, anon, authenticated;
revoke all on function public.routine_slot_template(p_routine_id uuid, p_date date) from public, anon, authenticated;
grant execute on function public.routine_slot_template(p_routine_id uuid, p_date date) to authenticated, service_role;
revoke all on function public.materialize_active_routine_week(p_uid uuid, p_routine_id uuid, p_anchor_date date) from public, anon, authenticated;
grant execute on function public.materialize_active_routine_week(p_uid uuid, p_routine_id uuid, p_anchor_date date) to service_role;
revoke all on function public.save_routine_cycle(p_routine_id uuid, p_length integer, p_anchor_date date, p_slots jsonb) from public, anon, authenticated;
grant execute on function public.save_routine_cycle(p_routine_id uuid, p_length integer, p_anchor_date date, p_slots jsonb) to authenticated, service_role;
revoke all on function public.reset_routine_to_weekly(p_routine_id uuid) from public, anon, authenticated;
grant execute on function public.reset_routine_to_weekly(p_routine_id uuid) to authenticated, service_role;
revoke all on function public.save_user_preferences(p_preferences jsonb) from public, anon, authenticated;
grant execute on function public.save_user_preferences(p_preferences jsonb) to authenticated, service_role;
grant execute on function public.get_avatar_seed() to authenticated, service_role;
revoke all on function public.get_own_data_usage() from public, anon, authenticated;
grant execute on function public.get_own_data_usage() to authenticated, service_role;
revoke all on function public.handle_auth_user_username() from public, anon, authenticated;
revoke all on function public.handle_new_user_schedule() from public, anon, authenticated;
revoke all on function public.is_username_available(p_username text) from public, anon, authenticated;
grant execute on function public.is_username_available(p_username text) to anon, authenticated, service_role;
revoke all on function public.register_username(p_username text) from public, anon, authenticated;
grant execute on function public.register_username(p_username text) to authenticated, service_role;
revoke all on function public.rename_username(p_new_username text) from public, anon, authenticated;
grant execute on function public.rename_username(p_new_username text) to authenticated, service_role;
revoke all on function public.resync_active_bookmarked_routine() from public, anon, authenticated;
grant execute on function public.resync_active_bookmarked_routine() to authenticated, service_role;
revoke all on function public.routine_bookmarks_validate() from public, anon, authenticated;
revoke all on function public.save_avatar_seed(p_seed text) from public, anon, authenticated;
grant execute on function public.save_avatar_seed(p_seed text) to authenticated, service_role;
revoke all on function public.save_routine_schedule(p_routine_id uuid, p_schedule jsonb) from public, anon, authenticated;
grant execute on function public.save_routine_schedule(p_routine_id uuid, p_schedule jsonb) to authenticated, service_role;
revoke all on function public.save_stat_log(p_stat_id uuid, p_log_date date, p_value real) from public, anon, authenticated;
grant execute on function public.save_stat_log(p_stat_id uuid, p_log_date date, p_value real) to authenticated, service_role;
revoke all on function public.save_template_exercises(p_template_id uuid, p_exercises jsonb) from public, anon, authenticated;
grant execute on function public.save_template_exercises(p_template_id uuid, p_exercises jsonb) to authenticated, service_role;
revoke all on function public.save_tracked_stats(p_stats jsonb) from public, anon, authenticated;
grant execute on function public.save_tracked_stats(p_stats jsonb) to authenticated, service_role;
revoke all on function public.save_workout_progress(p_workout_date date, p_template_id uuid, p_template_name text, p_performance_snapshot jsonb) from public, anon, authenticated;
grant execute on function public.save_workout_progress(p_workout_date date, p_template_id uuid, p_template_name text, p_performance_snapshot jsonb) to authenticated, service_role;
revoke all on function public.set_active_routine(p_routine_id uuid) from public, anon, authenticated;
grant execute on function public.set_active_routine(p_routine_id uuid) to authenticated, service_role;
revoke all on function public.skip_workout_log(p_workout_date date, p_template_id uuid, p_template_name text) from public, anon, authenticated;
grant execute on function public.skip_workout_log(p_workout_date date, p_template_id uuid, p_template_name text) to authenticated, service_role;
revoke all on function public.unbookmark_routine(p_routine_id uuid) from public, anon, authenticated;
grant execute on function public.unbookmark_routine(p_routine_id uuid) to authenticated, service_role;
revoke all on function public.update_template_display_orders(p_orders jsonb) from public, anon, authenticated;
grant execute on function public.update_template_display_orders(p_orders jsonb) to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
