-- Allow SELECT on all templates and template_exercises for authenticated users
-- Needed for copyRoutine to read other users' templates

create policy templates_select_all on public.templates
  for select to authenticated
  using (true);

create policy template_exercises_select_all on public.template_exercises
  for select to authenticated
  using (true);

grant select on public.templates to authenticated;
grant select on public.template_exercises to authenticated;
