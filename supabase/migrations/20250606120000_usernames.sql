-- Unique usernames for Showdown-style login (maps to internal auth email in the app).

create table if not exists public.usernames (
  username text primary key,
  user_id uuid not null unique references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint usernames_format check (username ~ '^[a-z0-9_-]{3,20}$')
);

alter table public.usernames enable row level security;

revoke all on table public.usernames from anon, authenticated;

create or replace function public.is_username_available(p_username text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  u text := lower(trim(p_username));
begin
  if u is null or u = '' or u !~ '^[a-z0-9_-]{3,20}$' then
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
  if u is null or u = '' or u !~ '^[a-z0-9_-]{3,20}$' then
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
  if u = '' or u !~ '^[a-z0-9_-]{3,20}$' then
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

drop trigger if exists on_auth_user_username on auth.users;
create trigger on_auth_user_username
  after insert on auth.users
  for each row execute function public.handle_auth_user_username();

-- Keep delete_own_account in sync (also updates 20250605120000 behavior when re-run).
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
  delete from public.templates where user_id = uid;
  delete from public.schedule where user_id = uid;
  delete from public.usernames where user_id = uid;

  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.delete_own_account() from public;
grant execute on function public.delete_own_account() to authenticated;