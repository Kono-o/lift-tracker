-- Keep profile and body-reading writes behind their validating SECURITY DEFINER
-- RPCs. The live project had drifted from the original migration and allowed
-- authenticated clients to bypass those RPCs with direct PostgREST writes.

drop policy if exists profiles_insert_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;
drop policy if exists body_readings_insert_own on public.body_readings;
drop policy if exists body_readings_update_own on public.body_readings;

revoke all on table public.profiles from anon, authenticated;
revoke all on table public.body_readings from anon, authenticated;

grant select, delete on table public.profiles to authenticated;
grant select, delete on table public.body_readings to authenticated;
