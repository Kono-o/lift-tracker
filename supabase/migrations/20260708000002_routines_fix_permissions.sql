-- =============================================================================
-- Fix routines activation: create RPC for setting active_routine_id
-- (usernames table uses revoke all + RPC-only access)
-- =============================================================================

-- Grant UPDATE on usernames for the active_routine_id column
grant update (active_routine_id) on public.usernames to authenticated;

-- RLS policy for UPDATE on usernames (own row only)
do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'usernames' and policyname = 'usernames_update_own'
  ) then
    create policy usernames_update_own on public.usernames
      for update to authenticated
      using (user_id = (select auth.uid()))
      with check (user_id = (select auth.uid()));
  end if;
end $$;
