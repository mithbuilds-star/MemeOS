-- Marks accounts whose feed has been re-anchored against existing imports.
alter table public.reference_accounts add column if not exists reanchored_at timestamptz;
