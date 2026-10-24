-- ============================================================================
-- Exercise deletion cleanup
-- ============================================================================
-- templates.exercise_ids is a plain uuid[] (no FK possible), so deleting an
-- exercise used by a template left dangling ids behind. Besides being dirty
-- data, those ids make templates report as non-empty even when they contain
-- no resolvable exercise (assignment guards, copy_routine, template pickers).
-- Keep the shared-library semantics ("delete from library removes it from all
-- templates") by pruning every reference on delete. SECURITY DEFINER so
-- references from routines/templates belonging to other users are cleaned too
-- (e.g. imported/copied data), while the delete itself is still governed by
-- the exercises RLS policy.

begin;

create or replace function public.exercises_cleanup_template_refs()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  update public.templates
  set exercise_ids = array_remove(exercise_ids, old.id)
  where old.id = any(exercise_ids);
  return old;
end;
$function$;

revoke all on function public.exercises_cleanup_template_refs() from public, anon, authenticated;

drop trigger if exists exercises_cleanup_template_refs_trg on public.exercises;

create trigger exercises_cleanup_template_refs_trg
after delete on public.exercises
for each row execute function public.exercises_cleanup_template_refs();

notify pgrst, 'reload schema';

commit;
