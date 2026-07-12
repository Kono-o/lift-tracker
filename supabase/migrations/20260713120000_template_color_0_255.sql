-- Expand templates.color from 0–4 palette index to 0–255 quantized spectrum index.
-- Existing 0–4 values remapped to approximate hues in the new grid.

alter table public.templates drop constraint if exists templates_color_range;

-- Map legacy 5-color palette into 16×4×4 HSV grid indices (see src/lib/templateColor.ts)
update public.templates set color = case color
  when 0 then 85   -- green
  when 1 then 69   -- lime
  when 2 then 117  -- sky
  when 3 then 149  -- purple
  when 4 then 5    -- pink/red
  else least(255, greatest(0, color))
end
where color between 0 and 4;

alter table public.templates
  add constraint templates_color_range check (color >= 0 and color <= 255);

comment on column public.templates.color is
  'Quantized HSV spectrum index 0–255 (16 hues × 4 sats × 4 vals). See app templateColor.ts';
