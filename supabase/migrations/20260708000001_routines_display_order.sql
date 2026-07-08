-- =============================================================================
-- Add display_order to routines table for drag-to-reorder
-- =============================================================================

do $$ begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'routines' and column_name = 'display_order'
  ) then
    alter table public.routines add column display_order int not null default 0;
    -- Set initial order based on created_at for existing rows
    update public.routines r
      set display_order = rn.seq
      from (
        select id, row_number() over (partition by user_id order by created_at) - 1 as seq
        from public.routines
      ) rn
      where r.id = rn.id;
  end if;
end $$;

create index if not exists routines_display_order_idx on public.routines (user_id, display_order);
