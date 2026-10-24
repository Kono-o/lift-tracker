-- =============================================================================
-- Cycle integrity fixes
-- =============================================================================
--   * Null out cycle_slots entries when a template is deleted (cycle_slots is
--     JSON, so the FK on schedule/routine_schedules does not cover it).
--   * Saving a weekly plan flips the routine back to weekly mode automatically.
-- =============================================================================

begin;

create or replace function public.templates_cleanup_cycle_slots()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.routines r
  set cycle_slots = coalesce(
    (select jsonb_agg(
       case when slot.value = to_jsonb(old.id) then 'null'::jsonb else slot.value end
       order by slot.ord
     )
     from jsonb_array_elements(r.cycle_slots) with ordinality as slot(value, ord)),
    '[]'::jsonb
  )
  where r.cycle_slots @> jsonb_build_array(to_jsonb(old.id));
  return old;
end;
$function$;

drop trigger if exists templates_cleanup_cycle_slots_trg on public.templates;
create trigger templates_cleanup_cycle_slots_trg
  after delete on public.templates
  for each row execute function public.templates_cleanup_cycle_slots();

create or replace function public.routine_schedules_mark_weekly()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.routines
  set schedule_mode = 'weekly', cycle_length = 7, cycle_slots = '[]'::jsonb
  where id = new.routine_id
    and schedule_mode <> 'weekly';
  return new;
end;
$function$;

drop trigger if exists routine_schedules_mark_weekly_trg on public.routine_schedules;
create trigger routine_schedules_mark_weekly_trg
  before insert or update on public.routine_schedules
  for each row execute function public.routine_schedules_mark_weekly();

revoke all on function public.templates_cleanup_cycle_slots() from public, anon, authenticated;
revoke all on function public.routine_schedules_mark_weekly() from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
