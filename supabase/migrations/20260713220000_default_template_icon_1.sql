-- Default new templates to icon 1 (Weight) instead of 0 (Dna).
-- Existing rows are left unchanged.

alter table public.templates alter column icon set default 1;

comment on column public.templates.icon is
  'Lucide icon index 0–31 (default 1 = Weight; see src/lib/itemIcons.ts)';
