-- Restructure templates: routine-owned with inline exercise_ids, drop template_exercises junction.
--
-- Templates are no longer user-global. Each template belongs to exactly one routine.
-- Exercises remain user-global. Template→exercise ordering is stored as a uuid[] array
-- on the template row, replacing the template_exercises junction table.

-- 1. Add routine_id (nullable first) and exercise_ids to templates
ALTER TABLE public.templates ADD COLUMN routine_id uuid REFERENCES public.routines(id) ON DELETE CASCADE;
ALTER TABLE public.templates ADD COLUMN exercise_ids uuid[] DEFAULT '{}';

-- 2. Backfill routine_id from routine_schedules.
--    If a template is referenced by multiple routines, assign to the first one
--    and duplicate for subsequent routines.
DO $$
DECLARE
  rec record;
  dup_rec record;
  new_id uuid;
BEGIN
  -- Assign routine_id to templates that have exactly one routine referencing them
  FOR rec IN
    SELECT rs.template_id, rs.routine_id
    FROM public.routine_schedules rs
    WHERE rs.template_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.templates t WHERE t.id = rs.template_id AND t.routine_id IS NOT NULL
      )
      AND (
        SELECT count(*) FROM public.routine_schedules rs2
        WHERE rs2.template_id = rs.template_id AND rs2.template_id IS NOT NULL
      ) = 1
  LOOP
    UPDATE public.templates SET routine_id = rec.routine_id WHERE id = rec.template_id;
  END LOOP;

  -- Handle templates referenced by multiple routines: keep first, clone for rest
  FOR rec IN
    SELECT rs.template_id, array_agg(DISTINCT rs.routine_id ORDER BY rs.routine_id) AS routine_ids
    FROM public.routine_schedules rs
    WHERE rs.template_id IS NOT NULL
    GROUP BY rs.template_id
    HAVING count(DISTINCT rs.routine_id) > 1
  LOOP
    -- Assign the original to the first routine
    UPDATE public.templates SET routine_id = rec.routine_ids[1] WHERE id = rec.template_id AND routine_id IS NULL;

    -- Clone for each additional routine
    FOR i IN 2..array_length(rec.routine_ids, 1) LOOP
      IF EXISTS (SELECT 1 FROM public.templates WHERE id = rec.template_id AND routine_id IS NOT NULL) THEN
        new_id := gen_random_uuid();
        INSERT INTO public.templates (id, user_id, routine_id, name, color, icon, display_order, exercise_ids)
        SELECT new_id, user_id, rec.routine_ids[i], name, color, icon, display_order, exercise_ids
        FROM public.templates WHERE id = rec.template_id;

        -- Update routine_schedules to point to the clone
        UPDATE public.routine_schedules
        SET template_id = new_id
        WHERE routine_id = rec.routine_ids[i] AND template_id = rec.template_id;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- 3. Backfill exercise_ids from template_exercises
UPDATE public.templates t
SET exercise_ids = COALESCE((
  SELECT array_agg(te.exercise_id ORDER BY te.display_order)
  FROM public.template_exercises te
  WHERE te.template_id = t.id
), '{}');

-- 4. Make routine_id NOT NULL (all templates should have one now)
--    First handle any orphaned templates by assigning them to a default routine
DO $$
DECLARE
  orphan record;
  uid uuid;
  new_rid uuid;
BEGIN
  FOR orphan IN
    SELECT t.id, t.user_id FROM public.templates t WHERE t.routine_id IS NULL
  LOOP
    uid := orphan.user_id;
    -- Find or create a routine for this user
    SELECT id INTO new_rid FROM public.routines WHERE user_id = uid LIMIT 1;
    IF new_rid IS NULL THEN
      INSERT INTO public.routines (user_id, name, display_order)
      VALUES (uid, 'MY ROUTINE', 0)
      RETURNING id INTO new_rid;
    END IF;
    UPDATE public.templates SET routine_id = new_rid WHERE id = orphan.id;
  END LOOP;
END $$;

ALTER TABLE public.templates ALTER COLUMN routine_id SET NOT NULL;

-- 5. Add index on routine_id
CREATE INDEX IF NOT EXISTS templates_routine_id_idx ON public.templates (routine_id);

-- 6. Drop user_id from templates (derivable from routine → user)
ALTER TABLE public.templates DROP COLUMN user_id;

-- 7. Drop template_exercises table
DROP TABLE public.template_exercises CASCADE;

-- 8. Update RLS policies on templates
DROP POLICY IF EXISTS templates_delete_own ON public.templates;
DROP POLICY IF EXISTS templates_insert_own ON public.templates;
DROP POLICY IF EXISTS templates_select_all ON public.templates;
DROP POLICY IF EXISTS templates_select_own ON public.templates;
DROP POLICY IF EXISTS templates_update_own ON public.templates;

CREATE POLICY templates_select_all ON public.templates
  FOR SELECT TO authenticated USING (true);

CREATE POLICY templates_insert_own ON public.templates
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.routines r WHERE r.id = routine_id AND r.user_id = auth.uid()
  ));

CREATE POLICY templates_select_own ON public.templates
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.routines r WHERE r.id = routine_id AND r.user_id = auth.uid()
  ));

CREATE POLICY templates_update_own ON public.templates
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.routines r WHERE r.id = routine_id AND r.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.routines r WHERE r.id = routine_id AND r.user_id = auth.uid()
  ));

CREATE POLICY templates_delete_own ON public.templates
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.routines r WHERE r.id = routine_id AND r.user_id = auth.uid()
  ));

-- 9. Recreate create_template RPC (now takes routine_id)
CREATE OR REPLACE FUNCTION public.create_template(p_routine_id uuid, p_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  uid uuid := auth.uid();
  safe_name text;
  next_order integer;
  row public.templates;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  if not exists (
    select 1 from public.routines r
    where r.id = p_routine_id and r.user_id = uid
  ) then
    raise exception 'Routine not found';
  end if;

  safe_name := upper(trim(coalesce(p_name, '')));
  if char_length(safe_name) = 0 then
    safe_name := 'NEW TEMPLATE';
  end if;
  if char_length(safe_name) > 18 then
    safe_name := left(safe_name, 18);
  end if;

  select coalesce(max(t.display_order), -1) + 1
  into next_order
  from public.templates t
  where t.routine_id = p_routine_id;

  insert into public.templates (routine_id, name, color, icon, display_order, exercise_ids)
  values (p_routine_id, safe_name, 242, 1, next_order, '{}')
  returning * into row;

  return to_jsonb(row);
end;
$function$;

-- 10. Recreate save_template_exercises RPC (now updates exercise_ids + upserts exercises)
CREATE OR REPLACE FUNCTION public.save_template_exercises(p_template_id uuid, p_exercises jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  ex jsonb;
  v_ex_id uuid;
  v_ex_type text;
  v_ex_name text;
  v_target_sets smallint;
  v_target_reps smallint;
  v_target_minutes smallint;
  v_target_seconds smallint;
  v_rest_minutes smallint;
  v_rest_seconds smallint;
  v_increment real;
  v_current_weight real;
  saved_ids uuid[] := '{}';
  result jsonb := '[]'::jsonb;
  row public.exercises;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  if not exists (
    select 1 from public.templates t
    join public.routines r on r.id = t.routine_id
    where t.id = p_template_id and r.user_id = uid
  ) then
    raise exception 'Template not found';
  end if;

  if coalesce(jsonb_array_length(p_exercises), 0) = 0 then
    update public.templates set exercise_ids = '{}' where id = p_template_id;
    return '[]'::jsonb;
  end if;

  for ex in select * from jsonb_array_elements(p_exercises)
  loop
    v_ex_type := coalesce(ex->>'exercise_type', 'reps');
    if v_ex_type not in ('reps', 'time') then
      raise exception 'Invalid exercise type';
    end if;

    v_ex_name := upper(trim(coalesce(ex->>'name', 'EXERCISE')));
    if char_length(v_ex_name) = 0 then
      raise exception 'Exercise name required';
    end if;
    if char_length(v_ex_name) > 24 then
      v_ex_name := left(v_ex_name, 24);
    end if;

    v_target_sets := least(12, greatest(0, coalesce((ex->>'target_sets')::int, 0)));

    if v_ex_type = 'reps' then
      v_target_reps := least(999, greatest(1, coalesce((ex->>'target_reps')::int, 1)));
      v_target_minutes := null;
      v_target_seconds := null;
      v_increment := least(500::real, greatest(0::real, coalesce((ex->>'increment')::real, 0)));
      v_current_weight := case
        when ex->>'current_weight' is null or btrim(ex->>'current_weight') = '' then null
        else least(500::real, greatest(0::real, (ex->>'current_weight')::real))
      end;
    else
      v_target_reps := null;
      v_target_minutes := least(99, greatest(0, coalesce((ex->>'target_minutes')::int, 0)));
      v_target_seconds := least(59, greatest(0, coalesce((ex->>'target_seconds')::int, 0)));
      v_increment := least(1000::real, greatest(0::real, coalesce((ex->>'increment')::real, 0)));
      v_current_weight := null;
    end if;

    v_rest_minutes := least(99, greatest(0, coalesce((ex->>'rest_minutes')::int, 0)));
    v_rest_seconds := least(59, greatest(0, coalesce((ex->>'rest_seconds')::int, 0)));

    v_ex_id := null;
    begin
      if ex->>'id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         and not (ex->>'id') like 'temp-%' then
        v_ex_id := (ex->>'id')::uuid;
      end if;
    exception when others then
      v_ex_id := null;
    end;

    if v_ex_id is not null and exists (
      select 1 from public.exercises e
      where e.id = v_ex_id and e.user_id = uid
    ) then
      update public.exercises set
        name = v_ex_name,
        exercise_type = v_ex_type,
        target_sets = v_target_sets,
        target_reps = v_target_reps,
        target_minutes = v_target_minutes,
        target_seconds = v_target_seconds,
        rest_minutes = v_rest_minutes,
        rest_seconds = v_rest_seconds,
        increment = v_increment,
        current_weight = v_current_weight
      where id = v_ex_id and user_id = uid
      returning * into row;
    else
      insert into public.exercises (
        user_id, name, exercise_type, target_sets, target_reps,
        target_minutes, target_seconds, rest_minutes, rest_seconds, increment, current_weight
      ) values (
        uid, v_ex_name, v_ex_type, v_target_sets, v_target_reps,
        v_target_minutes, v_target_seconds, v_rest_minutes, v_rest_seconds, v_increment, v_current_weight
      )
      returning * into row;
      v_ex_id := row.id;
    end if;

    saved_ids := array_append(saved_ids, v_ex_id);

    result := result || jsonb_build_array(
      to_jsonb(row) || jsonb_build_object('display_order', jsonb_array_length(result))
    );
  end loop;

  -- Update template's exercise_ids array
  update public.templates set exercise_ids = saved_ids where id = p_template_id;

  return result;
end;
$function$;

-- 11. Recreate update_template_display_orders to work with routine-owned templates
CREATE OR REPLACE FUNCTION public.update_template_display_orders(p_orders jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  item jsonb;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  for item in select * from jsonb_array_elements(p_orders)
  loop
    update public.templates t
    set display_order = (item->>'display_order')::int
    where t.id = (item->>'id')::uuid
      and exists (
        select 1 from public.routines r
        where r.id = t.routine_id and r.user_id = uid
      );
  end loop;
end;
$function$;

-- 12. Update get_own_data_usage to count templates via routines
CREATE OR REPLACE FUNCTION public.get_own_data_usage()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  select jsonb_build_object(
    'templates',
      coalesce((select count(*)::int from public.templates t
        join public.routines r on r.id = t.routine_id
        where r.user_id = auth.uid()), 0),
    'exercises',
      coalesce((select count(*)::int from public.exercises where user_id = auth.uid()), 0),
    'schedule',
      coalesce((select count(*)::int from public.schedule where user_id = auth.uid()), 0),
    'workout_history',
      coalesce((select count(*)::int from public.workout_history where user_id = auth.uid()), 0),
    'tracked_stats',
      coalesce((select count(*)::int from public.tracked_stats where user_id = auth.uid()), 0),
    'stat_logs',
      coalesce((select count(*)::int from public.stat_logs where user_id = auth.uid()), 0),
    'routines',
      coalesce((select count(*)::int from public.routines where user_id = auth.uid()), 0),
    'estimated_bytes',
      (
        coalesce(
          (select sum(octet_length(row_to_json(t)::text))::bigint from public.templates t
            join public.routines r on r.id = t.routine_id where r.user_id = auth.uid()),
          0
        )
        + coalesce(
          (select sum(octet_length(row_to_json(e)::text))::bigint from public.exercises e where e.user_id = auth.uid()),
          0
        )
        + coalesce(
          (select sum(octet_length(row_to_json(s)::text))::bigint from public.schedule s where s.user_id = auth.uid()),
          0
        )
        + coalesce(
          (select sum(octet_length(row_to_json(w)::text))::bigint from public.workout_history w where w.user_id = auth.uid()),
          0
        )
        + coalesce(
          (select sum(octet_length(row_to_json(ts)::text))::bigint from public.tracked_stats ts where ts.user_id = auth.uid()),
          0
        )
        + coalesce(
          (select sum(octet_length(row_to_json(sl)::text))::bigint from public.stat_logs sl where sl.user_id = auth.uid()),
          0
        )
        + coalesce(
          (select sum(octet_length(row_to_json(p)::text))::bigint from public.exercise_personal_bests p where p.user_id = auth.uid()),
          0
        )
      )
  )
  where auth.uid() is not null;
$$;

-- 13. Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
