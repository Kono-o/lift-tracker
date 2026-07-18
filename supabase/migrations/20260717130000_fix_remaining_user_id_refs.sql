-- Fix remaining functions that still reference templates.user_id
-- (dropped by 20260717120000_templates_routine_owned.sql)
-- Also references template_exercises which was also dropped.

-- 1. Drop the old single-arg create_template overload (references user_id on templates)
DROP FUNCTION IF EXISTS public.create_template(p_name text);

-- 2. Fix assign_schedule_days: template ownership check via routines join,
--    and remove template_exercises existence check (table was dropped; exercises
--    are now stored as exercise_ids array on the template itself).
CREATE OR REPLACE FUNCTION public.assign_schedule_days(p_assignments jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  uid uuid := auth.uid();
  item jsonb;
  v_day_of_week smallint;
  v_template_id uuid;
  row public.schedule;
  rows jsonb := '[]'::jsonb;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF coalesce(jsonb_array_length(p_assignments), 0) = 0 THEN
    RETURN '[]'::jsonb;
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(p_assignments)
  LOOP
    v_day_of_week := (item->>'day_of_week')::smallint;
    IF v_day_of_week < 0 OR v_day_of_week > 6 THEN
      RAISE EXCEPTION 'Invalid day_of_week';
    END IF;

    v_template_id := NULL;
    IF item->>'template_id' IS NOT NULL AND btrim(item->>'template_id') <> '' THEN
      v_template_id := (item->>'template_id')::uuid;
      IF NOT EXISTS (
        SELECT 1 FROM public.templates t
        JOIN public.routines r ON r.id = t.routine_id
        WHERE t.id = v_template_id AND r.user_id = uid
      ) THEN
        RAISE EXCEPTION 'Template not found';
      END IF;
      IF (
        SELECT count(*) FROM public.templates t WHERE t.id = v_template_id
      ) = 0 THEN
        RAISE EXCEPTION 'Template not found';
      END IF;
    END IF;

    INSERT INTO public.schedule (user_id, day_of_week, template_id, updated_at)
    VALUES (uid, v_day_of_week, v_template_id, now())
    ON CONFLICT (user_id, day_of_week) DO UPDATE SET
      template_id = excluded.template_id,
      updated_at = now()
    RETURNING * INTO row;

    rows := rows || jsonb_build_array(to_jsonb(row));
  END LOOP;

  RETURN rows;
END;
$function$;

-- 3. Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
