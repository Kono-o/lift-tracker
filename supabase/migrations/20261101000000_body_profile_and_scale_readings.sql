-- Body profile + scale readings.
--
-- `profiles` is a NEW table rather than columns on `usernames`: usernames is
-- world-readable to every signed-in user (`usernames_select_all ... using (true)`)
-- because avatars/routine lists need it, so sex / date of birth / height can never
-- live there — or inside its `preferences` jsonb, which is read by the same policy.
--
-- `body_readings` is a NEW table rather than more `stat_logs`: stat_logs is keyed
-- (user_id, stat_id, log_date), so it cannot hold two weigh-ins on the same day and
-- has nowhere to put time, heart rate, provenance, or the profile the numbers were
-- derived from.
--
-- Metrics (body fat, water, BMR, muscle mass) are NOT stored. Each row keeps the
-- raw measurement plus the `profile_snapshot` in force at capture time, and the
-- client derives the numbers from those two — one implementation of the formulas
-- instead of a SQL copy that can drift, and history stays pinned to the age/height
-- it was measured with while still benefiting from a corrected formula.

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------

create table public.profiles (
  user_id uuid not null,
  sex text,
  date_of_birth date,
  height_cm numeric(5,2),
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table public.body_readings (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  measured_at timestamp with time zone not null,
  weight_kg numeric(6,3) not null,
  heart_rate smallint,
  impedance_raw numeric(8,2),
  source text default 'manual' not null,
  device_label text,
  profile_snapshot jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

-- -----------------------------------------------------------------------------
-- Constraints
-- -----------------------------------------------------------------------------

alter table public.profiles add constraint profiles_pkey PRIMARY KEY (user_id);
alter table public.body_readings add constraint body_readings_pkey PRIMARY KEY (id);

alter table public.profiles add constraint profiles_sex_check CHECK (sex is null or sex = any (array['male'::text, 'female'::text, 'other'::text]));
alter table public.profiles add constraint profiles_dob_floor CHECK (date_of_birth is null or date_of_birth >= '1900-01-01'::date);
alter table public.profiles add constraint profiles_height_range CHECK (height_cm is null or (height_cm >= 30::numeric AND height_cm <= 280::numeric));
alter table public.body_readings add constraint body_readings_weight_range CHECK (weight_kg > 0::numeric AND weight_kg <= 500::numeric);
alter table public.body_readings add constraint body_readings_hr_range CHECK (heart_rate is null or (heart_rate >= 20 AND heart_rate <= 260));
alter table public.body_readings add constraint body_readings_impedance_range CHECK (impedance_raw is null or (impedance_raw >= 0::numeric AND impedance_raw <= 100000::numeric));
alter table public.body_readings add constraint body_readings_source_check CHECK (source = any (array['scale'::text, 'manual'::text]));
alter table public.body_readings add constraint body_readings_snapshot_check CHECK (jsonb_typeof(profile_snapshot) = 'object'::text);
alter table public.body_readings add constraint body_readings_label_length CHECK (device_label is null or char_length(device_label) <= 40);

alter table public.profiles add constraint profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.body_readings add constraint body_readings_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------

CREATE INDEX body_readings_user_measured_idx ON public.body_readings USING btree (user_id, measured_at DESC);

-- -----------------------------------------------------------------------------
-- RPCs
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.save_profile(p_sex text, p_date_of_birth date, p_height_cm numeric)
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
  -- Floor/ceiling checks that depend on the clock live here, not in a CHECK
  -- constraint: a volatile CHECK expression can invalidate existing rows later.
  if p_date_of_birth is not null and p_date_of_birth > current_date then
    raise exception 'Date of birth cannot be in the future';
  end if;
  if p_height_cm is not null and (p_height_cm < 30 or p_height_cm > 280) then
    raise exception 'Height must be between 30 and 280 cm';
  end if;

  insert into public.profiles (user_id, sex, date_of_birth, height_cm, created_at, updated_at)
  values (uid, p_sex, p_date_of_birth, p_height_cm, now(), now())
  on conflict (user_id) do update
    set sex = excluded.sex,
        date_of_birth = excluded.date_of_birth,
        height_cm = excluded.height_cm,
        updated_at = now()
  returning * into row;

  return to_jsonb(row);
end;
$function$;

CREATE OR REPLACE FUNCTION public.save_body_reading(p_id uuid, p_measured_at timestamp with time zone, p_weight_kg numeric, p_heart_rate smallint, p_impedance_raw numeric, p_source text, p_device_label text)
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
  if p_impedance_raw is not null and (p_impedance_raw < 0 or p_impedance_raw > 100000) then
    raise exception 'Impedance out of range';
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
      (user_id, measured_at, weight_kg, heart_rate, impedance_raw, source, device_label, profile_snapshot, created_at, updated_at)
    values (
      uid,
      v_at,
      p_weight_kg,
      p_heart_rate,
      p_impedance_raw,
      coalesce(p_source, 'manual'),
      v_label,
      coalesce(
        (select jsonb_build_object(
                   'sex', pr.sex,
                   'date_of_birth', pr.date_of_birth,
                   'height_cm', pr.height_cm)
           from public.profiles pr
          where pr.user_id = uid),
        '{}'::jsonb),
      now(),
      now())
    returning * into row;
  else
    -- profile_snapshot deliberately not refreshed: a correction to an old
    -- weigh-in must not be re-derived against today's age.
    update public.body_readings
       set measured_at = v_at,
           weight_kg = p_weight_kg,
           heart_rate = p_heart_rate,
           impedance_raw = p_impedance_raw,
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
-- Row level security
-- -----------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.body_readings enable row level security;

create policy "profiles_delete_own" on public.profiles as permissive for delete to authenticated using (user_id = ( SELECT auth.uid() AS uid));
create policy "profiles_select_own" on public.profiles as permissive for select to authenticated using (user_id = ( SELECT auth.uid() AS uid));
create policy "body_readings_delete_own" on public.body_readings as permissive for delete to authenticated using (user_id = ( SELECT auth.uid() AS uid));
create policy "body_readings_select_own" on public.body_readings as permissive for select to authenticated using (user_id = ( SELECT auth.uid() AS uid));

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

-- Writes go through SECURITY DEFINER RPCs so dynamic validation (DOB/timestamps)
-- cannot be bypassed with a direct PostgREST insert or update.
revoke all on table public.profiles from anon, authenticated;
revoke all on table public.body_readings from anon, authenticated;
grant select, delete on table public.profiles to authenticated;
grant all on table public.profiles to service_role;
grant select, delete on table public.body_readings to authenticated;
grant all on table public.body_readings to service_role;

revoke all on function public.save_profile(p_sex text, p_date_of_birth date, p_height_cm numeric) from public, anon, authenticated;
grant execute on function public.save_profile(p_sex text, p_date_of_birth date, p_height_cm numeric) to authenticated, service_role;
revoke all on function public.save_body_reading(p_id uuid, p_measured_at timestamp with time zone, p_weight_kg numeric, p_heart_rate smallint, p_impedance_raw numeric, p_source text, p_device_label text) from public, anon, authenticated;
grant execute on function public.save_body_reading(p_id uuid, p_measured_at timestamp with time zone, p_weight_kg numeric, p_heart_rate smallint, p_impedance_raw numeric, p_source text, p_device_label text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Account deletion + storage accounting must know about the new tables
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.delete_all_accounts()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
begin
  delete from public.exercise_personal_bests;
  delete from public.exercises;
  delete from public.workout_history;
  delete from public.stat_logs;
  delete from public.tracked_stats;
  delete from public.body_readings;
  delete from public.profiles;
  delete from public.routine_bookmarks;
  delete from public.routines; -- cascades templates + routine_schedules
  delete from public.schedule;
  delete from public.usernames;
  delete from auth.users;
end;
$function$;

CREATE OR REPLACE FUNCTION public.delete_own_account()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  delete from public.exercise_personal_bests where user_id = uid;
  delete from public.exercises where user_id = uid;
  delete from public.workout_history where user_id = uid;
  delete from public.stat_logs where user_id = uid;
  delete from public.tracked_stats where user_id = uid;
  delete from public.body_readings where user_id = uid;
  delete from public.profiles where user_id = uid;
  delete from public.routine_bookmarks where user_id = uid;
  delete from public.routines where user_id = uid;
  delete from public.schedule where user_id = uid;
  delete from public.usernames where user_id = uid;

  delete from auth.users where id = uid;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_own_data_usage()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'templates',
      coalesce((select count(*)::int from public.templates t join public.routines r on r.id = t.routine_id where r.user_id = auth.uid()), 0),
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
    'body_readings',
      coalesce((select count(*)::int from public.body_readings where user_id = auth.uid()), 0),
    'routines',
      coalesce((select count(*)::int from public.routines where user_id = auth.uid()), 0),
    'estimated_bytes',
      (
        coalesce(
          (select sum(octet_length(row_to_json(t)::text))::bigint from public.templates t join public.routines r on r.id = t.routine_id where r.user_id = auth.uid()),
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
        + coalesce(
          (select sum(octet_length(row_to_json(br)::text))::bigint from public.body_readings br where br.user_id = auth.uid()),
          0
        )
      )
  )
  where auth.uid() is not null;
$function$;

notify pgrst, 'reload schema';
