-- Fix RLS for copyRoutine: need SELECT on all exercises (not just own)
-- because copyRoutine reads source user's exercises to clone them.

drop policy if exists exercises_select_all on public.exercises;
create policy exercises_select_all on public.exercises
  for select to authenticated
  using (true);

-- template_exercises_insert_own already checks user_id = auth.uid()
-- for the insert row itself, but the subquery checks also need to
-- allow selecting the newly inserted template/exercise (which now
-- has user_id = auth.uid()). The existing policy is fine for INSERT
-- because the template and exercise are created with user_id = auth.uid()
-- *before* template_exercises is inserted.
-- The SELECT policies on templates and template_exercises were already
-- fixed in migration 20260708000003.
