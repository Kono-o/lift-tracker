-- Exercises become a per-user library; templates link via template_exercises (many-to-many).

create table if not exists public.template_exercises (
  template_id uuid not null references public.templates (id) on delete cascade,
  exercise_id uuid not null references public.exercises (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  display_order integer not null default 0,
  primary key (template_id, exercise_id),
  constraint template_exercises_display_order_nonneg check (display_order >= 0)
);

-- Migrate existing per-template exercise rows into junction links.
insert into public.template_exercises (template_id, exercise_id, user_id, display_order)
select e.template_id, e.id, e.user_id, e.display_order
from public.exercises e
where e.template_id is not null
on conflict (template_id, exercise_id) do nothing;

alter table public.exercises drop constraint if exists exercises_template_id_fkey;
drop index if exists public.exercises_template_id_idx;
alter table public.exercises drop column if exists template_id;
alter table public.exercises drop column if exists display_order;

create index if not exists template_exercises_template_id_idx
  on public.template_exercises (template_id);
create index if not exists template_exercises_exercise_id_idx
  on public.template_exercises (exercise_id);
create index if not exists template_exercises_user_id_idx
  on public.template_exercises (user_id);

alter table public.template_exercises enable row level security;

drop policy if exists exercises_insert_own on public.exercises;
drop policy if exists exercises_update_own on public.exercises;

create policy exercises_insert_own on public.exercises
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy exercises_update_own on public.exercises
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists template_exercises_select_own on public.template_exercises;
drop policy if exists template_exercises_insert_own on public.template_exercises;
drop policy if exists template_exercises_update_own on public.template_exercises;
drop policy if exists template_exercises_delete_own on public.template_exercises;

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

grant select, insert, update, delete on public.template_exercises to authenticated;
grant select on public.template_exercises to anon;