-- Align duration_seconds check with app behavior:
-- skipped/rest: NULL; completed workouts: integer >= 1 (0 is not allowed).

alter table public.workout_history
  drop constraint if exists workout_history_duration_seconds_check;

alter table public.workout_history
  add constraint workout_history_duration_seconds_check check (
    duration_seconds is null
    or duration_seconds >= 1
  );