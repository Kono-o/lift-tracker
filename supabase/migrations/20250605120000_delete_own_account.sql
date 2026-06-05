-- Run in Supabase SQL Editor (or via CLI migrate) so users can fully delete their account.
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

  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.delete_own_account() from public;
grant execute on function public.delete_own_account() to authenticated;