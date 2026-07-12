-- =============================================================================
-- Routines hardening: bookmarks as list entries, safe activate (own + bookmarked),
-- schedule materialization for foreign templates, no self-bookmark, display order.
-- Additive / data-preserving. Does not drop user data.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Bookmarks: display_order + no self-bookmark + no bookmark own routine
-- -----------------------------------------------------------------------------
do $$ begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'routine_bookmarks' and column_name = 'display_order'
  ) then
    alter table public.routine_bookmarks
      add column display_order int not null default 0;
  end if;
end $$;

-- Backfill bookmark display_order per user by created_at
update public.routine_bookmarks b
set display_order = rn.seq
from (
  select id, row_number() over (partition by user_id order by created_at) - 1 as seq
  from public.routine_bookmarks
) rn
where b.id = rn.id
  and b.display_order = 0;

create index if not exists routine_bookmarks_display_order_idx
  on public.routine_bookmarks (user_id, display_order);

-- Prevent bookmarking your own routine (bookmark is for other users' routines)
create or replace function public.routine_bookmarks_validate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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
$$;

drop trigger if exists routine_bookmarks_validate_trg on public.routine_bookmarks;
create trigger routine_bookmarks_validate_trg
  before insert or update of user_id, routine_id on public.routine_bookmarks
  for each row execute function public.routine_bookmarks_validate();

-- -----------------------------------------------------------------------------
-- 2. Schedule policies: allow foreign template_ids on the user's own schedule rows.
--    Needed so activating a bookmarked routine can materialize its plan.
--    Editing still gated by assign_schedule_days (own templates only).
-- -----------------------------------------------------------------------------
drop policy if exists schedule_insert_own on public.schedule;
create policy schedule_insert_own on public.schedule
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (
      template_id is null
      or exists (select 1 from public.templates t where t.id = template_id)
    )
  );

drop policy if exists schedule_update_own on public.schedule;
create policy schedule_update_own on public.schedule
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and (
      template_id is null
      or exists (select 1 from public.templates t where t.id = template_id)
    )
  );

-- -----------------------------------------------------------------------------
-- 3. set_active_routine(p_routine_id): own OR bookmarked only.
--    SECURITY DEFINER materializes routine_schedules → schedule (7 days).
--    Live-follow for bookmarks: caller re-invokes to refresh from source.
-- -----------------------------------------------------------------------------
create or replace function public.set_active_routine(p_routine_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
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

  if p_routine_id is null then
    update public.usernames
      set active_routine_id = null
      where user_id = uid;
    return;
  end if;

  select id, user_id into r
  from public.routines
  where id = p_routine_id;

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

  update public.usernames
    set active_routine_id = p_routine_id
    where user_id = uid;

  -- Only the owner may seed missing day rows on the source routine
  if r.user_id = uid then
    for d in 0..6 loop
      insert into public.routine_schedules (routine_id, day_of_week, template_id)
      values (p_routine_id, d, null)
      on conflict (routine_id, day_of_week) do nothing;
    end loop;
  end if;

  -- Materialize into personal schedule (works for foreign templates)
  for d in 0..6 loop
    select rs.template_id into tid
    from public.routine_schedules rs
    where rs.routine_id = p_routine_id and rs.day_of_week = d;

    -- If no row for that day, treat as rest
    if not found then
      tid := null;
    end if;

    insert into public.schedule (user_id, day_of_week, template_id, updated_at)
    values (uid, d, tid, now())
    on conflict (user_id, day_of_week) do update set
      template_id = excluded.template_id,
      updated_at = now();
  end loop;
end;
$$;

revoke all on function public.set_active_routine(uuid) from public;
grant execute on function public.set_active_routine(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 4. delete_own_routine: only owner; clears active for anyone pointing at it
--    (FK already SET NULL on usernames; bookmarks cascade). Does not touch
--    templates/exercises (shared across user's routines).
-- -----------------------------------------------------------------------------
create or replace function public.delete_own_routine(p_routine_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
$$;

revoke all on function public.delete_own_routine(uuid) from public;
grant execute on function public.delete_own_routine(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 5. unbookmark_routine_by_id: remove from list only (never deletes the source)
-- -----------------------------------------------------------------------------
create or replace function public.unbookmark_routine(p_routine_id uuid)
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

  delete from public.routine_bookmarks
  where user_id = uid and routine_id = p_routine_id;

  -- If that was the active routine, clear it (user must re-assign)
  update public.usernames
    set active_routine_id = null
    where user_id = uid and active_routine_id = p_routine_id;
end;
$$;

revoke all on function public.unbookmark_routine(uuid) from public;
grant execute on function public.unbookmark_routine(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 6. bookmark_routine helper with display_order
-- -----------------------------------------------------------------------------
create or replace function public.bookmark_routine(p_routine_id uuid)
returns public.routine_bookmarks
language plpgsql
security definer
set search_path = public
as $$
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
$$;

revoke all on function public.bookmark_routine(uuid) from public;
grant execute on function public.bookmark_routine(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 7. Resync active bookmarked routine schedule from source (live update)
-- -----------------------------------------------------------------------------
create or replace function public.resync_active_bookmarked_routine()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
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
$$;

revoke all on function public.resync_active_bookmarked_routine() from public;
grant execute on function public.resync_active_bookmarked_routine() to authenticated;

-- -----------------------------------------------------------------------------
-- 8. Keep assign_schedule_days requiring OWN templates with exercises
--    (user editing their own plan — not for bookmark follow).
--    Also dual-write to active OWNED routine_schedules when applicable.
-- -----------------------------------------------------------------------------
create or replace function public.assign_schedule_days(p_assignments jsonb)
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
  active_id uuid;
  active_owner uuid;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  if coalesce(jsonb_array_length(p_assignments), 0) = 0 then
    return '[]'::jsonb;
  end if;

  select u.active_routine_id into active_id
  from public.usernames u
  where u.user_id = uid;

  if active_id is not null then
    select r.user_id into active_owner from public.routines r where r.id = active_id;
    -- Bookmarked (read-only) active routine: block edits to schedule
    if active_owner is not null and active_owner <> uid then
      raise exception 'Bookmarked routines are read-only. Copy the routine to edit it.';
    end if;
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

    -- Dual-write to owned active routine schedule
    if active_id is not null and active_owner = uid then
      insert into public.routine_schedules (routine_id, day_of_week, template_id)
      values (active_id, v_day_of_week, v_template_id)
      on conflict (routine_id, day_of_week) do update set
        template_id = excluded.template_id;
    end if;

    rows := rows || jsonb_build_array(to_jsonb(row));
  end loop;

  return rows;
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Ensure grants on usernames active_routine_id remain
-- -----------------------------------------------------------------------------
grant update (active_routine_id) on public.usernames to authenticated;
grant select, insert, update, delete on public.routine_bookmarks to authenticated;
grant select, insert, update, delete on public.routines to authenticated;
grant select, insert, update, delete on public.routine_schedules to authenticated;
