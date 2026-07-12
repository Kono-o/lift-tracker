-- Default new templates to spectrum index 242 (#FFBF00 amber gold).
-- See src/lib/templateColor.ts DEFAULT_TEMPLATE_COLOR.

alter table public.templates alter column color set default 242;

create or replace function public.create_template(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  safe_name text;
  next_order integer;
  row public.templates;
begin
  if uid is null then
    raise exception 'Not authenticated';
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
  where t.user_id = uid;

  insert into public.templates (user_id, name, color, display_order)
  values (uid, safe_name, 242, next_order)
  returning * into row;

  return to_jsonb(row);
end;
$$;

revoke all on function public.create_template(text) from public;
grant execute on function public.create_template(text) to authenticated;
