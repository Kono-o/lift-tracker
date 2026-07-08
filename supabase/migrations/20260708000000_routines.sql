-- =============================================================================
-- Lift Tracker — Multiple Week Routines + Routine Discovery/Bookmarking
-- =============================================================================
-- Additive migration: creates new tables/columns, does NOT modify existing ones.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Routines table (one per user, many rows per user)
-- -----------------------------------------------------------------------------
create table if not exists public.routines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  constraint routines_name_not_empty check (char_length(trim(name)) > 0)
);

-- -----------------------------------------------------------------------------
-- 2. Routine schedules (weekly plan per routine)
-- -----------------------------------------------------------------------------
create table if not exists public.routine_schedules (
  routine_id uuid not null references public.routines (id) on delete cascade,
  day_of_week smallint not null,
  template_id uuid references public.templates (id) on delete set null,
  primary key (routine_id, day_of_week),
  constraint routine_schedules_day_of_week_check check (day_of_week between 0 and 6)
);

-- -----------------------------------------------------------------------------
-- 3. Routine bookmarks
-- -----------------------------------------------------------------------------
create table if not exists public.routine_bookmarks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  routine_id uuid not null references public.routines (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, routine_id)
);

-- -----------------------------------------------------------------------------
-- 4. Add active_routine_id to usernames
-- -----------------------------------------------------------------------------
do $$ begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'usernames' and column_name = 'active_routine_id'
  ) then
    alter table public.usernames add column active_routine_id uuid references public.routines (id) on delete set null;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 5. Indexes
-- -----------------------------------------------------------------------------
create index if not exists routines_user_id_idx on public.routines (user_id);
create index if not exists routine_schedules_routine_id_idx on public.routine_schedules (routine_id);
create index if not exists routine_schedules_template_id_idx on public.routine_schedules (template_id)
  where template_id is not null;
create index if not exists routine_bookmarks_user_id_idx on public.routine_bookmarks (user_id);
create index if not exists routine_bookmarks_routine_id_idx on public.routine_bookmarks (routine_id);

-- -----------------------------------------------------------------------------
-- 6. Row Level Security
-- -----------------------------------------------------------------------------
alter table public.routines enable row level security;
alter table public.routine_schedules enable row level security;
alter table public.routine_bookmarks enable row level security;

-- Own rows: full CRUD
create policy routines_own_all on public.routines
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- All authenticated can SELECT all routines (for discovery/browsing)
create policy routines_select_all on public.routines
  for select to authenticated
  using (true);

-- Routine schedules: own routines get full control
create policy routine_schedules_own_all on public.routine_schedules
  for all to authenticated
  using (
    exists (
      select 1 from public.routines r
      where r.id = routine_id and r.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.routines r
      where r.id = routine_id and r.user_id = (select auth.uid())
    )
  );

-- All authenticated can SELECT all routine_schedules (for browsing)
create policy routine_schedules_select_all on public.routine_schedules
  for select to authenticated
  using (true);

-- Bookmarks: own bookmarks only
create policy routine_bookmarks_own_all on public.routine_bookmarks
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Allow SELECT on usernames for all authenticated users (for browsing users)
do $$ begin
  if not exists (
    select 1 from pg_policies where tablename = 'usernames' and policyname = 'usernames_select_all'
  ) then
    create policy usernames_select_all on public.usernames
      for select to authenticated
      using (true);
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 7. Grants
-- -----------------------------------------------------------------------------
grant select, insert, update, delete on public.routines to authenticated;
grant select, insert, update, delete on public.routine_schedules to authenticated;
grant select, insert, update, delete on public.routine_bookmarks to authenticated;
grant select on public.routines to anon;
grant select on public.routine_schedules to anon;
grant select on public.routine_bookmarks to anon;

-- Also allow SELECT on usernames for authenticated users (needed for browsing)
grant select on public.usernames to authenticated;
