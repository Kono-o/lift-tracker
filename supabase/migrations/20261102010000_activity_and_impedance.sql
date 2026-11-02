-- Activity level, plus impedance that says where it came from.
--
-- The staged capture protocol now produces a whole-body resistance in ohms, the byte
-- map that decoded it, and a heart rate. `impedance_raw` held undocumented 0xCF frame
-- bytes: the column stays (it is the only record of what those builds stored) but
-- nothing writes or reads it any more.
--
-- `captured_version` is the provenance gate the client distrusts legacy rows with. It
-- cannot be inferred from a timestamp — an app upgrade does not move the clock — so a
-- row has to declare it. Rows that do not keep their heart rate out of the UI.
--
-- `profiles.activity` feeds TDEE only. It is optional: a reading taken before one was
-- chosen has no daily-calorie target, and inventing a "moderate" default would put a
-- number on the screen that the user never agreed to.

alter table public.profiles add column activity text;
alter table public.body_readings add column impedance_ohms numeric(6,2);
alter table public.body_readings add column impedance_source text;
alter table public.body_readings add column captured_version smallint;

alter table public.profiles add constraint profiles_activity_check CHECK (activity is null or activity = any (array['sedentary'::text, 'light'::text, 'moderate'::text, 'high'::text, 'athlete'::text]));
-- Deliberately wider than the 150-1200 ohm band the client accepts: the client decides
-- what counts as a body measurement, this only stops a corrupt value being stored.
alter table public.body_readings add constraint body_readings_ohms_range CHECK (impedance_ohms is null or (impedance_ohms > 0::numeric AND impedance_ohms <= 5000::numeric));
alter table public.body_readings add constraint body_readings_impedance_source_length CHECK (impedance_source is null or char_length(impedance_source) <= 32);
alter table public.body_readings add constraint body_readings_captured_version_check CHECK (captured_version is null or (captured_version >= 1 AND captured_version <= 100));

-- -----------------------------------------------------------------------------
-- RPCs
-- -----------------------------------------------------------------------------

-- Replacing signatures, so the old ones go first: leaving both would make
-- `save_profile` ambiguous for PostgREST.
DROP FUNCTION IF EXISTS public.save_profile(p_sex text, p_date_of_birth date, p_height_cm numeric);
DROP FUNCTION IF EXISTS public.save_body_reading(p_id uuid, p_measured_at timestamp with time zone, p_weight_kg numeric, p_heart_rate smallint, p_impedance_raw numeric, p_source text, p_device_label text);

CREATE OR REPLACE FUNCTION public.save_profile(p_sex text, p_date_of_birth date, p_height_cm numeric, p_activity text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  row public.profiles;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  if p_sex is not null and p_sex <> all (array['male','female','other']) then
    raise exception 'Invalid sex';
  end if;
  if p_activity is not null and p_activity <> all (array['sedentary','light','moderate','high','athlete']) then
    raise exception 'Invalid activity level';
  end if;
  -- Floor/ceiling checks that depend on the clock live here, not in a CHECK
  -- constraint: a volatile CHECK expression can invalidate existing rows later.
  if p_date_of_birth is not null and p_date_of_birth > current_date then
    raise exception 'Date of birth cannot be in the future';
  end if;
  if p_height_cm is not null and (p_height_cm < 30 or p_height_cm > 280) then
    raise exception 'Height must be between 30 and 280 cm';
  end if;

  insert into public.profiles (user_id, sex, date_of_birth, height_cm, activity, created_at, updated_at)
  values (uid, p_sex, p_date_of_birth, p_height_cm, p_activity, now(), now())
  on conflict (user_id) do update
    set sex = excluded.sex,
        date_of_birth = excluded.date_of_birth,
        height_cm = excluded.height_cm,
        activity = excluded.activity,
        updated_at = now()
  returning * into row;

  return to_jsonb(row);
end;
$function$;

CREATE OR REPLACE FUNCTION public.save_body_reading(p_id uuid, p_measured_at timestamp with time zone, p_weight_kg numeric, p_heart_rate smallint, p_impedance_ohms numeric, p_impedance_source text, p_captured_version smallint, p_source text, p_device_label text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  row public.body_readings;
  v_at timestamp with time zone;
  v_label text;
  v_ohms numeric;
  v_hypothesis text;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;
  if p_weight_kg is null or p_weight_kg <= 0 or p_weight_kg > 500 then
    raise exception 'Weight must be between 0 and 500 kg';
  end if;
  if p_source is not null and p_source <> all (array['scale','manual']) then
    raise exception 'Invalid source';
  end if;
  if p_heart_rate is not null and (p_heart_rate < 20 or p_heart_rate > 260) then
    raise exception 'Heart rate must be between 20 and 260 bpm';
  end if;
  if p_impedance_ohms is not null and (p_impedance_ohms <= 0 or p_impedance_ohms > 5000) then
    raise exception 'Impedance out of range';
  end if;

  -- A resistance and the byte map that produced it travel together or not at all:
  -- a hypothesis with no value behind it would let a later reader re-derive numbers
  -- from a measurement that was never taken.
  v_ohms := p_impedance_ohms;
  if v_ohms is null then
    v_hypothesis := null;
  else
    v_hypothesis := nullif(btrim(coalesce(p_impedance_source, '')), '');
    if char_length(v_hypothesis) > 32 then
      v_hypothesis := left(v_hypothesis, 32);
    end if;
  end if;

  v_at := coalesce(p_measured_at, now());
  -- A phone with a wrong clock should not make a reading unreachable forever.
  if v_at > now() + interval '1 day' then
    v_at := now();
  end if;
  v_label := nullif(btrim(coalesce(p_device_label, '')), '');
  if char_length(v_label) > 40 then
    v_label := left(v_label, 40);
  end if;

  if p_id is null then
    insert into public.body_readings
      (user_id, measured_at, weight_kg, heart_rate, impedance_ohms, impedance_source, captured_version, source, device_label, profile_snapshot, created_at, updated_at)
    values (
      uid,
      v_at,
      p_weight_kg,
      p_heart_rate,
      v_ohms,
      v_hypothesis,
      p_captured_version,
      coalesce(p_source, 'manual'),
      v_label,
      coalesce(
        (select jsonb_build_object(
                   'sex', pr.sex,
                   'date_of_birth', pr.date_of_birth,
                   'height_cm', pr.height_cm,
                   'activity', pr.activity)
           from public.profiles pr
          where pr.user_id = uid),
        '{}'::jsonb),
      now(),
      now())
    returning * into row;
  else
    -- profile_snapshot deliberately not refreshed: a correction to an old
    -- weigh-in must not be re-derived against today's age.
    -- captured_version is coalesced rather than assigned: correcting a field on an
    -- old row is not evidence that the row stopped being trustworthy, and silently
    -- dropping it would erase a pulse the user can still see.
    update public.body_readings
       set measured_at = v_at,
           weight_kg = p_weight_kg,
           heart_rate = p_heart_rate,
           impedance_ohms = v_ohms,
           impedance_source = v_hypothesis,
           captured_version = coalesce(p_captured_version, captured_version),
           source = coalesce(p_source, source),
           device_label = v_label,
           updated_at = now()
     where id = p_id and user_id = uid
     returning * into row;
    if not found then
      raise exception 'Reading not found';
    end if;
  end if;

  return to_jsonb(row);
end;
$function$;

-- -----------------------------------------------------------------------------
-- Grants (the dropped signatures took their grants with them)
-- -----------------------------------------------------------------------------

revoke all on function public.save_profile(p_sex text, p_date_of_birth date, p_height_cm numeric, p_activity text) from public, anon, authenticated;
grant execute on function public.save_profile(p_sex text, p_date_of_birth date, p_height_cm numeric, p_activity text) to authenticated, service_role;
revoke all on function public.save_body_reading(p_id uuid, p_measured_at timestamp with time zone, p_weight_kg numeric, p_heart_rate smallint, p_impedance_ohms numeric, p_impedance_source text, p_captured_version smallint, p_source text, p_device_label text) from public, anon, authenticated;
grant execute on function public.save_body_reading(p_id uuid, p_measured_at timestamp with time zone, p_weight_kg numeric, p_heart_rate smallint, p_impedance_ohms numeric, p_impedance_source text, p_captured_version smallint, p_source text, p_device_label text) to authenticated, service_role;

notify pgrst, 'reload schema';
