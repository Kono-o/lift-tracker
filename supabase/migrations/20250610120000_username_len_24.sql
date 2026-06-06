-- Extend username max length from 20 to 24.

alter table public.usernames drop constraint if exists usernames_format;
alter table public.usernames
  add constraint usernames_format check (username ~ '^[a-z0-9_-]{3,24}$');

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