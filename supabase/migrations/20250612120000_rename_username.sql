-- Allow username accounts to rename (updates usernames table + auth email/metadata).

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
  v_seed text;
  new_email text;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;
  if u is null or u = '' or u !~ '^[a-z0-9_-]{3,24}$' then
    raise exception 'Invalid username';
  end if;

  select username, avatar_seed into old_u, v_seed
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

  insert into public.usernames (username, user_id, avatar_seed) values (u, uid, v_seed);

  update auth.users set
    email = new_email,
    raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('username', u)
  where id = uid;
end;
$$;

revoke all on function public.rename_username(text) from public;
grant execute on function public.rename_username(text) to authenticated;

create or replace function public.get_avatar_seed()
returns text
language plpgsql
security definer
set search_path = public
as $$
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
$$;

revoke all on function public.get_avatar_seed() from public;
grant execute on function public.get_avatar_seed() to authenticated;

create or replace function public.save_avatar_seed(p_seed text)
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
  update public.usernames
  set avatar_seed = p_seed
  where user_id = uid;
end;
$$;

revoke all on function public.save_avatar_seed(text) from public;
grant execute on function public.save_avatar_seed(text) to authenticated;