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