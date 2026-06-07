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
-- Storage-oriented design notes:
--   - workout_history: composite PK (user_id, workout_date) — one row/day, no surrogate id
--   - tracked_stats + stat_logs: user-defined metrics and daily values
--   - exercises: real weights, type-specific nullable target columns (no zero-padding)
--   - exercise_personal_bests: O(1) PR lookup instead of scanning JSON history
--   - workout_status smallint: filter calendar rows without parsing JSONB
--   - performance_snapshot: in-progress + aggregate stats only
--   - workout_snapshot: immutable completed/skipped/rest display record
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Drop all app objects (safe dependency order)
-- -----------------------------------------------------------------------------
drop trigger if exists on_auth_user_username on auth.users;

drop function if exists public.create_template(text) cascade;
drop function if exists public.save_template_exercises(uuid, jsonb) cascade;
drop function if exists public.save_tracked_stats(jsonb) cascade;
drop function if exists public.save_stat_log(uuid, date, real) cascade;
drop function if exists public.assign_schedule_days(jsonb) cascade;
drop function if exists public.update_template_display_orders(jsonb) cascade;
drop function if exists public.complete_workout_session(date, uuid, text, integer, jsonb, jsonb, jsonb) cascade;
drop function if exists public.save_workout_progress(date, uuid, text, jsonb) cascade;
drop function if exists public.skip_workout_log(date, uuid, text) cascade;
drop function if exists public.delete_workout_log(date) cascade;
drop function if exists public.get_own_data_usage() cascade;
drop function if exists public.delete_own_account() cascade;
drop function if exists public.delete_all_accounts() cascade;
drop function if exists public.register_username(text) cascade;
drop function if exists public.rename_username(text) cascade;
drop function if exists public.is_username_available(text) cascade;
drop function if exists public.handle_auth_user_username() cascade;

drop table if exists public.exercise_personal_bests cascade;
drop table if exists public.template_exercises cascade;
drop table if exists public.exercises cascade;
drop table if exists public.workout_history cascade;
drop table if exists public.stat_logs cascade;
drop table if exists public.tracked_stats cascade;
drop table if exists public.schedule cascade;
drop table if exists public.templates cascade;
drop table if exists public.usernames cascade;

delete from auth.users;

-- -----------------------------------------------------------------------------
-- 2. Core tables
-- -----------------------------------------------------------------------------

create table public.templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  color smallint not null default 0,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint templates_name_not_empty check (char_length(trim(name)) > 0),
  constraint templates_color_range check (color >= 0 and color <= 4),
  constraint templates_display_order_nonneg check (display_order >= 0)
);

-- Shared per-user exercise library. Type-specific columns are NULL when unused.
create table public.exercises (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null default 'Exercise',
  exercise_type text not null default 'reps',
  target_sets smallint not null default 0,
  target_reps smallint,
  target_minutes smallint,
  target_seconds smallint,
  increment real not null default 0,
  current_weight real,
  created_at timestamptz not null default now(),
  constraint exercises_type_check check (exercise_type in ('reps', 'time')),
  constraint exercises_target_sets_range check (target_sets >= 0 and target_sets <= 12),
  constraint exercises_reps_fields check (
    exercise_type <> 'reps'
    or (target_reps is not null and target_minutes is null and target_seconds is null)
  ),
  constraint exercises_time_fields check (
    exercise_type <> 'time'
    or (target_reps is null and target_minutes is not null and target_seconds is not null)
  ),
  constraint exercises_time_no_weight check (
    exercise_type <> 'time' or current_weight is null
  )
);

create table public.template_exercises (
  template_id uuid not null references public.templates (id) on delete cascade,
  exercise_id uuid not null references public.exercises (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  display_order smallint not null default 0,
  primary key (template_id, exercise_id),
  constraint template_exercises_display_order_nonneg check (display_order >= 0)
);

-- Maintained by the app on workout submit; avoids scanning workout_history JSON for PRs.
create table public.exercise_personal_bests (
  exercise_id uuid primary key references public.exercises (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  best_weight real not null default 0,
  achieved_on date,
  updated_at timestamptz not null default now(),
  constraint exercise_personal_bests_weight_nonneg check (best_weight >= 0)
);

create table public.schedule (
  user_id uuid not null references auth.users (id) on delete cascade,
  day_of_week smallint not null,
  template_id uuid references public.templates (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (user_id, day_of_week),
  constraint schedule_day_of_week_check check (day_of_week between 0 and 6)
);

-- workout_status: 0=completed  1=skipped  2=rest  3=in_progress
create table public.workout_history (
  user_id uuid not null references auth.users (id) on delete cascade,
  workout_date date not null,
  template_id uuid references public.templates (id) on delete set null,
  template_name_snapshot text,
  workout_status smallint not null default 0,
  is_skipped boolean not null default false,
  duration_seconds integer,
  is_perfect_day boolean not null default false,
  performance_snapshot jsonb not null default '{}'::jsonb,
  workout_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, workout_date),
  constraint workout_history_status_check check (workout_status between 0 and 3),
  constraint workout_history_duration_seconds_check check (
    duration_seconds is null or duration_seconds >= 1
  ),
  constraint workout_history_skip_consistency check (
    (workout_status = 1 and is_skipped = true)
    or (workout_status <> 1 and is_skipped = false)
  )
);

create table public.tracked_stats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  unit text not null default '',
  display_order integer not null default 0,
  start_value real not null default 0,
  has_target boolean not null default false,
  target_value real,
  created_at timestamptz not null default now(),
  constraint tracked_stats_name_not_empty check (char_length(trim(name)) > 0),
  constraint tracked_stats_display_order_nonneg check (display_order >= 0),
  constraint tracked_stats_start_value_nonneg check (start_value >= 0),
  constraint tracked_stats_target_valid check (
    (has_target = false and target_value is null)
    or (has_target = true and target_value is not null and target_value > 0)
  )
);

create table public.stat_logs (
  user_id uuid not null references auth.users (id) on delete cascade,
  stat_id uuid not null,
  log_date date not null,
  value real not null,
  stat_name_snapshot text not null,
  stat_unit_snapshot text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, stat_id, log_date),
  constraint stat_logs_value_positive check (value > 0),
  constraint stat_logs_name_not_empty check (char_length(trim(stat_name_snapshot)) > 0)
);

create table public.usernames (
  username text primary key,
  user_id uuid not null unique references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint usernames_format check (username ~ '^[a-z0-9_-]{3,24}$')
);

-- -----------------------------------------------------------------------------
-- 3. Indexes
-- -----------------------------------------------------------------------------
create index exercises_user_id_idx on public.exercises (user_id);
create index template_exercises_template_id_idx on public.template_exercises (template_id);
create index template_exercises_exercise_id_idx on public.template_exercises (exercise_id);
create index template_exercises_user_id_idx on public.template_exercises (user_id);
create index templates_user_id_idx on public.templates (user_id);
create index exercise_personal_bests_user_id_idx on public.exercise_personal_bests (user_id);
create index schedule_template_id_idx on public.schedule (template_id)
  where template_id is not null;
create index workout_history_user_date_idx on public.workout_history (user_id, workout_date desc);
create index workout_history_status_idx on public.workout_history (user_id, workout_status);
create index workout_history_perfect_day_idx on public.workout_history (user_id, is_perfect_day)
  where is_perfect_day = true;
create index tracked_stats_user_order_idx on public.tracked_stats (user_id, display_order);
create index stat_logs_user_stat_date_idx on public.stat_logs (user_id, stat_id, log_date desc);

-- -----------------------------------------------------------------------------
-- 4. Row Level Security
-- -----------------------------------------------------------------------------
alter table public.templates enable row level security;
alter table public.exercises enable row level security;
alter table public.template_exercises enable row level security;
alter table public.exercise_personal_bests enable row level security;
alter table public.schedule enable row level security;
alter table public.workout_history enable row level security;
alter table public.tracked_stats enable row level security;
alter table public.stat_logs enable row level security;
alter table public.usernames enable row level security;

create policy templates_select_own on public.templates
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy templates_insert_own on public.templates
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy templates_update_own on public.templates
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy templates_delete_own on public.templates
  for delete to authenticated
  using (user_id = (select auth.uid()));

create policy exercises_select_own on public.exercises
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy exercises_insert_own on public.exercises
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy exercises_update_own on public.exercises
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy exercises_delete_own on public.exercises
  for delete to authenticated
  using (user_id = (select auth.uid()));

create policy template_exercises_select_own on public.template_exercises
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy template_exercises_insert_own on public.template_exercises
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.templates t
      where t.id = template_id and t.user_id = (select auth.uid())
    )
    and exists (
      select 1 from public.exercises e
      where e.id = exercise_id and e.user_id = (select auth.uid())
    )
  );

create policy template_exercises_update_own on public.template_exercises
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy template_exercises_delete_own on public.template_exercises
  for delete to authenticated
  using (user_id = (select auth.uid()));

create policy exercise_personal_bests_select_own on public.exercise_personal_bests
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy exercise_personal_bests_insert_own on public.exercise_personal_bests
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy exercise_personal_bests_update_own on public.exercise_personal_bests
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy exercise_personal_bests_delete_own on public.exercise_personal_bests
  for delete to authenticated
  using (user_id = (select auth.uid()));

create policy schedule_select_own on public.schedule
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy schedule_insert_own on public.schedule
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (
      template_id is null
      or exists (
        select 1 from public.templates t
        where t.id = template_id and t.user_id = (select auth.uid())
      )
    )
  );

create policy schedule_update_own on public.schedule
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and (
      template_id is null
      or exists (
        select 1 from public.templates t
        where t.id = template_id and t.user_id = (select auth.uid())
      )
    )
  );

create policy schedule_delete_own on public.schedule
  for delete to authenticated
  using (user_id = (select auth.uid()));

create policy workout_history_select_own on public.workout_history
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy workout_history_insert_own on public.workout_history
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy workout_history_update_own on public.workout_history
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy workout_history_delete_own on public.workout_history
  for delete to authenticated
  using (user_id = (select auth.uid()));

create policy tracked_stats_select_own on public.tracked_stats
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy tracked_stats_insert_own on public.tracked_stats
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy tracked_stats_update_own on public.tracked_stats
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy tracked_stats_delete_own on public.tracked_stats
  for delete to authenticated
  using (user_id = (select auth.uid()));

create policy stat_logs_select_own on public.stat_logs
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy stat_logs_insert_own on public.stat_logs
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy stat_logs_update_own on public.stat_logs
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy stat_logs_delete_own on public.stat_logs
  for delete to authenticated
  using (user_id = (select auth.uid()));

revoke all on table public.usernames from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. Grants
-- -----------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;

grant select, insert, update, delete on public.templates to authenticated;
grant select, insert, update, delete on public.exercises to authenticated;
grant select, insert, update, delete on public.template_exercises to authenticated;
grant select, insert, update, delete on public.exercise_personal_bests to authenticated;
grant select, insert, update, delete on public.schedule to authenticated;
grant select, insert, update, delete on public.workout_history to authenticated;
grant select, insert, update, delete on public.tracked_stats to authenticated;
grant select, insert, update, delete on public.stat_logs to authenticated;

grant select on public.templates to anon;
grant select on public.exercises to anon;
grant select on public.template_exercises to anon;
grant select on public.exercise_personal_bests to anon;
grant select on public.schedule to anon;
grant select on public.workout_history to anon;
grant select on public.tracked_stats to anon;
grant select on public.stat_logs to anon;

-- -----------------------------------------------------------------------------
-- 6. Username system
-- -----------------------------------------------------------------------------
create or replace function public.is_username_available(p_username text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  u text := lower(trim(p_username));
begin
  if u is null or u = '' or u !~ '^[a-z0-9_-]{3,24}$' then
    return false;
  end if;
  return not exists (select 1 from public.usernames where username = u);
end;
$$;

revoke all on function public.is_username_available(text) from public;
grant execute on function public.is_username_available(text) to anon, authenticated;

create or replace function public.register_username(p_username text)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
$$;

revoke all on function public.register_username(text) from public;
grant execute on function public.register_username(text) to authenticated;

create or replace function public.rename_username(p_new_username text)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  uid uuid := auth.uid();
  u text := lower(trim(p_new_username));
  old_u text;
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

  if old_u is not null and old_u = u then
    return;
  end if;

  if exists (
    select 1 from public.usernames where username = u and user_id <> uid
  ) then
    raise exception 'Username already taken' using errcode = '23505';
  end if;

  new_email := 'lt_' || u || '@example.com';

  delete from public.usernames where user_id = uid;

  insert into public.usernames (username, user_id) values (u, uid);

  update auth.users set
    email = new_email,
    raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('username', u)
  where id = uid;
end;
$$;

revoke all on function public.rename_username(text) from public;
grant execute on function public.rename_username(text) to authenticated;

create or replace function public.handle_auth_user_username()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  u text;
begin
  u := lower(trim(coalesce(new.raw_user_meta_data->>'username', '')));
  if u = '' or u !~ '^[a-z0-9_-]{3,24}$' then
    return new;
  end if;
  begin
    insert into public.usernames (username, user_id) values (u, new.id);
  exception
    when unique_violation then
      raise exception 'Username already taken' using errcode = '23505';
  end;
  return new;
end;
$$;

create trigger on_auth_user_username
  after insert on auth.users
  for each row execute function public.handle_auth_user_username();

-- -----------------------------------------------------------------------------
-- 7. Delete own account
-- -----------------------------------------------------------------------------
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
  delete from public.templates where user_id = uid;
  delete from public.schedule where user_id = uid;
  delete from public.usernames where user_id = uid;

  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.delete_own_account() from public;
grant execute on function public.delete_own_account() to authenticated;

-- -----------------------------------------------------------------------------
-- 8. Per-user data usage
-- -----------------------------------------------------------------------------
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
    'tracked_stats',
      coalesce((select count(*)::int from public.tracked_stats where user_id = auth.uid()), 0),
    'stat_logs',
      coalesce((select count(*)::int from public.stat_logs where user_id = auth.uid()), 0),
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

-- -----------------------------------------------------------------------------
-- 9. Workout RPCs (exactly one HTTP round-trip per user action)
-- -----------------------------------------------------------------------------

create or replace function public.save_workout_progress(
  p_workout_date date,
  p_template_id uuid,
  p_template_name text,
  p_performance_snapshot jsonb
)
returns public.workout_history
language plpgsql
security definer
set search_path = public
as $$
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
$$;

create or replace function public.skip_workout_log(
  p_workout_date date,
  p_template_id uuid,
  p_template_name text
)
returns public.workout_history
language plpgsql
security definer
set search_path = public
as $$
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
$$;

create or replace function public.delete_workout_log(p_workout_date date)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
$$;

create or replace function public.complete_workout_session(
  p_workout_date date,
  p_template_id uuid,
  p_template_name text,
  p_duration_seconds integer,
  p_reps jsonb,
  p_times jsonb,
  p_exercises jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
    target_sets := coalesce((ex->>'target_sets')::int, 0);
    ex_sets := '[]'::jsonb;

    if ex_type = 'reps' then
      reps_ex_count := reps_ex_count + 1;
      target_reps := coalesce((ex->>'target_reps')::int, 0);
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
$$;

revoke all on function public.save_workout_progress(date, uuid, text, jsonb) from public;
grant execute on function public.save_workout_progress(date, uuid, text, jsonb) to authenticated;

revoke all on function public.skip_workout_log(date, uuid, text) from public;
grant execute on function public.skip_workout_log(date, uuid, text) to authenticated;

revoke all on function public.delete_workout_log(date) from public;
grant execute on function public.delete_workout_log(date) to authenticated;

revoke all on function public.complete_workout_session(date, uuid, text, integer, jsonb, jsonb, jsonb) from public;
grant execute on function public.complete_workout_session(date, uuid, text, integer, jsonb, jsonb, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- 10. Routine / template RPCs (exactly one HTTP round-trip per user action)
-- -----------------------------------------------------------------------------

create or replace function public.create_template(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  safe_name text;
  next_order integer;
  row public.templates;
begin
  if uid is null then
    raise exception 'Not authenticated';
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
  where t.user_id = uid;

  insert into public.templates (user_id, name, color, display_order)
  values (uid, safe_name, 0, next_order)
  returning * into row;

  return to_jsonb(row);
end;
$$;

create or replace function public.save_template_exercises(
  p_template_id uuid,
  p_exercises jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
  v_increment real;
  v_current_weight real;
  saved_ids uuid[] := '{}';
  ord smallint := 0;
  result jsonb := '[]'::jsonb;
  row public.exercises;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  if not exists (
    select 1 from public.templates t
    where t.id = p_template_id and t.user_id = uid
  ) then
    raise exception 'Template not found';
  end if;

  if coalesce(jsonb_array_length(p_exercises), 0) = 0 then
    delete from public.template_exercises
    where template_id = p_template_id and user_id = uid;
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
      v_increment := least(1000::real, greatest(1::real, coalesce((ex->>'increment')::real, 5)));
      v_current_weight := null;
    end if;

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
      select 1 from public.exercises e
      where e.id = v_ex_id and e.user_id = uid
    ) then
      update public.exercises set
        name = v_ex_name,
        exercise_type = v_ex_type,
        target_sets = v_target_sets,
        target_reps = v_target_reps,
        target_minutes = v_target_minutes,
        target_seconds = v_target_seconds,
        increment = v_increment,
        current_weight = v_current_weight
      where id = v_ex_id and user_id = uid
      returning * into row;
    else
      insert into public.exercises (
        user_id, name, exercise_type, target_sets, target_reps,
        target_minutes, target_seconds, increment, current_weight
      ) values (
        uid, v_ex_name, v_ex_type, v_target_sets, v_target_reps,
        v_target_minutes, v_target_seconds, v_increment, v_current_weight
      )
      returning * into row;
      v_ex_id := row.id;
    end if;

    saved_ids := array_append(saved_ids, v_ex_id);

    insert into public.template_exercises (template_id, exercise_id, user_id, display_order)
    values (p_template_id, v_ex_id, uid, ord)
    on conflict (template_id, exercise_id) do update set
      display_order = excluded.display_order;

    result := result || jsonb_build_array(
      to_jsonb(row) || jsonb_build_object('display_order', ord)
    );
    ord := ord + 1;
  end loop;

  delete from public.template_exercises te
  where te.template_id = p_template_id
    and te.user_id = uid
    and not (te.exercise_id = any(saved_ids));

  return result;
end;
$$;

create or replace function public.assign_schedule_days(
  p_assignments jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  item jsonb;
  v_day_of_week smallint;
  v_template_id uuid;
  rows jsonb := '[]'::jsonb;
  row public.schedule;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  if coalesce(jsonb_array_length(p_assignments), 0) = 0 then
    return '[]'::jsonb;
  end if;

  for item in select * from jsonb_array_elements(p_assignments)
  loop
    v_day_of_week := (item->>'day_of_week')::smallint;
    if v_day_of_week < 0 or v_day_of_week > 6 then
      raise exception 'Invalid day_of_week';
    end if;

    v_template_id := null;
    if item->>'template_id' is not null and btrim(item->>'template_id') <> '' then
      v_template_id := (item->>'template_id')::uuid;
      if not exists (
        select 1 from public.templates t
        where t.id = v_template_id and t.user_id = uid
      ) then
        raise exception 'Template not found';
      end if;
      if not exists (
        select 1 from public.template_exercises te
        where te.template_id = v_template_id and te.user_id = uid
      ) then
        raise exception 'Add exercises before assigning this template.';
      end if;
    end if;

    insert into public.schedule (user_id, day_of_week, template_id, updated_at)
    values (uid, v_day_of_week, v_template_id, now())
    on conflict (user_id, day_of_week) do update set
      template_id = excluded.template_id,
      updated_at = now()
    returning * into row;

    rows := rows || jsonb_build_array(to_jsonb(row));
  end loop;

  return rows;
end;
$$;

create or replace function public.update_template_display_orders(
  p_orders jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  item jsonb;
  v_template_id uuid;
  v_display_ord integer;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  for item in select * from jsonb_array_elements(coalesce(p_orders, '[]'::jsonb))
  loop
    v_template_id := (item->>'id')::uuid;
    v_display_ord := coalesce((item->>'display_order')::int, 0);
    update public.templates
    set display_order = greatest(0, v_display_ord)
    where id = v_template_id and user_id = uid;
  end loop;
end;
$$;

revoke all on function public.create_template(text) from public;
grant execute on function public.create_template(text) to authenticated;

revoke all on function public.save_template_exercises(uuid, jsonb) from public;
grant execute on function public.save_template_exercises(uuid, jsonb) to authenticated;

revoke all on function public.assign_schedule_days(jsonb) from public;
grant execute on function public.assign_schedule_days(jsonb) to authenticated;

revoke all on function public.update_template_display_orders(jsonb) from public;
grant execute on function public.update_template_display_orders(jsonb) to authenticated;

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
        target_value = v_target_value
      where id = v_stat_id and user_id = uid
      returning * into row;
    else
      insert into public.tracked_stats (user_id, name, unit, display_order, start_value, has_target, target_value)
      values (uid, v_name, v_unit, ord, v_start_value, v_has_target, v_target_value)
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

-- -----------------------------------------------------------------------------
-- 11. Delete all accounts (setup-db.fish --users-only)
-- -----------------------------------------------------------------------------
create or replace function public.delete_all_accounts()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  delete from public.exercise_personal_bests;
  delete from public.template_exercises;
  delete from public.exercises;
  delete from public.workout_history;
  delete from public.stat_logs;
  delete from public.tracked_stats;
  delete from public.templates;
  delete from public.schedule;
  delete from public.usernames;
  delete from auth.users;
end;
$$;

revoke all on function public.delete_all_accounts() from public;
grant execute on function public.delete_all_accounts() to service_role;
grant execute on function public.delete_all_accounts() to postgres;

commit;

-- =============================================================================
-- Done. Run: NOTIFY pgrst, 'reload schema';  (setup-db.fish does this automatically)
-- =============================================================================