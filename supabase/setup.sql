-- =============================================================================
-- Lift Tracker — Database Setup (Full Initialization)
-- =============================================================================
-- Run in Supabase Dashboard → SQL Editor → New query → paste entire file → Run
--
-- This script is SAFE TO RE-RUN at any time.
-- It deletes ALL application data and objects first, then recreates everything.
--
-- WARNING: This will permanently delete all rows in:
--   - templates
--   - exercises
--   - template_exercises
--   - schedule
--   - workout_history
--   - usernames
--
-- It does NOT delete auth.users accounts.
--
-- After running, you may want to run:
--   NOTIFY pgrst, 'reload schema';
-- (to clear PostgREST schema cache if you see "schema cache" errors)
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Drop all app objects (in safe dependency order)
-- -----------------------------------------------------------------------------
drop trigger if exists on_auth_user_username on auth.users;

drop function if exists public.get_own_data_usage() cascade;
drop function if exists public.delete_own_account() cascade;
drop function if exists public.register_username(text) cascade;
drop function if exists public.is_username_available(text) cascade;
drop function if exists public.handle_auth_user_username() cascade;

drop table if exists public.template_exercises cascade;
drop table if exists public.exercises cascade;
drop table if exists public.workout_history cascade;
drop table if exists public.bodyweight_logs cascade;
drop table if exists public.schedule cascade;
drop table if exists public.templates cascade;
drop table if exists public.usernames cascade;

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

create table public.exercises (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null default 'Exercise',
  exercise_type text not null default 'reps',
  target_sets integer not null default 0,
  target_reps integer not null default 0,
  target_minutes integer not null default 0,
  target_seconds integer not null default 0,
  increment numeric not null default 0,
  current_weight numeric,
  created_at timestamptz not null default now(),
  constraint exercises_type_check check (exercise_type in ('reps', 'time')),
  constraint exercises_target_sets_nonneg check (target_sets >= 0)
);

-- Junction table allowing the same exercise to be used on multiple templates.
-- This is the foundation for "pick from my exercises" + progressive overload
-- working across different templates.
create table public.template_exercises (
  template_id uuid not null references public.templates (id) on delete cascade,
  exercise_id uuid not null references public.exercises (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  display_order integer not null default 0,
  primary key (template_id, exercise_id),
  constraint template_exercises_display_order_nonneg check (display_order >= 0)
);

create table public.schedule (
  user_id uuid not null references auth.users (id) on delete cascade,
  day_of_week smallint not null,
  template_id uuid references public.templates (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (user_id, day_of_week),
  constraint schedule_day_of_week_check check (day_of_week between 0 and 6)
);

create table public.workout_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  workout_date date not null,
  template_id uuid references public.templates (id) on delete set null,
  template_name_snapshot text,
  is_skipped boolean not null default false,
  duration_seconds integer,
  is_perfect_day boolean not null default false,
  performance_snapshot jsonb not null default '{}'::jsonb,
  workout_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint workout_history_user_date_unique unique (user_id, workout_date),
  constraint workout_history_duration_seconds_check check (
    duration_seconds is null
    or duration_seconds >= 1
  )
);

create table public.bodyweight_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  log_date date not null,
  weight numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bodyweight_logs_user_date_unique unique (user_id, log_date),
  constraint bodyweight_logs_weight_positive check (weight > 0)
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
create index schedule_template_id_idx on public.schedule (template_id)
  where template_id is not null;
create index workout_history_user_date_idx on public.workout_history (user_id, workout_date desc);
create index workout_history_perfect_day_idx on public.workout_history (user_id, is_perfect_day)
  where is_perfect_day = true;
create index bodyweight_logs_user_date_idx on public.bodyweight_logs (user_id, log_date desc);

-- -----------------------------------------------------------------------------
-- 4. Row Level Security
-- -----------------------------------------------------------------------------
alter table public.templates enable row level security;
alter table public.exercises enable row level security;
alter table public.template_exercises enable row level security;
alter table public.schedule enable row level security;
alter table public.workout_history enable row level security;
alter table public.bodyweight_logs enable row level security;
alter table public.usernames enable row level security;

-- templates
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

-- exercises
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

-- template_exercises (many-to-many)
create policy template_exercises_select_own on public.template_exercises
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy template_exercises_insert_own on public.template_exercises
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.templates t
      where t.id = template_id
        and t.user_id = (select auth.uid())
    )
    and exists (
      select 1
      from public.exercises e
      where e.id = exercise_id
        and e.user_id = (select auth.uid())
    )
  );

create policy template_exercises_update_own on public.template_exercises
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy template_exercises_delete_own on public.template_exercises
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- schedule
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
        select 1
        from public.templates t
        where t.id = template_id
          and t.user_id = (select auth.uid())
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
        select 1
        from public.templates t
        where t.id = template_id
          and t.user_id = (select auth.uid())
      )
    )
  );

create policy schedule_delete_own on public.schedule
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- workout_history
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

-- bodyweight_logs
create policy bodyweight_logs_select_own on public.bodyweight_logs
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy bodyweight_logs_insert_own on public.bodyweight_logs
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy bodyweight_logs_update_own on public.bodyweight_logs
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy bodyweight_logs_delete_own on public.bodyweight_logs
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- usernames table is never directly accessible from client
revoke all on table public.usernames from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. Grants (RLS policies still apply on top of these)
-- -----------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;

grant select, insert, update, delete on public.templates to authenticated;
grant select, insert, update, delete on public.exercises to authenticated;
grant select, insert, update, delete on public.template_exercises to authenticated;
grant select, insert, update, delete on public.schedule to authenticated;
grant select, insert, update, delete on public.workout_history to authenticated;
grant select, insert, update, delete on public.bodyweight_logs to authenticated;

grant select on public.templates to anon;
grant select on public.exercises to anon;
grant select on public.template_exercises to anon;
grant select on public.schedule to anon;
grant select on public.workout_history to anon;
grant select on public.bodyweight_logs to anon;

-- -----------------------------------------------------------------------------
-- 6. Username system (availability check + registration + auto-creation on signup)
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
-- 7. Delete own account (called from app + /api/delete-account)
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

  delete from public.exercises where user_id = uid;
  delete from public.workout_history where user_id = uid;
  delete from public.bodyweight_logs where user_id = uid;
  delete from public.templates where user_id = uid;
  delete from public.schedule where user_id = uid;
  delete from public.usernames where user_id = uid;

  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.delete_own_account() from public;
grant execute on function public.delete_own_account() to authenticated;

-- -----------------------------------------------------------------------------
-- 8. Per-user data usage (used by the status / debug panel in the app)
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
    'bodyweight_logs',
      coalesce((select count(*)::int from public.bodyweight_logs where user_id = auth.uid()), 0),
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
          (select sum(octet_length(row_to_json(b)::text))::bigint from public.bodyweight_logs b where b.user_id = auth.uid()),
          0
        )
      )
  )
  where auth.uid() is not null;
$$;

revoke all on function public.get_own_data_usage() from public;
grant execute on function public.get_own_data_usage() to authenticated;

commit;

-- =============================================================================
-- Done.
-- Your database is now fully initialized with the current schema.
-- =============================================================================
