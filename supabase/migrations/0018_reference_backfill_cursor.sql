alter table public.reference_accounts
  add column if not exists backfill_before timestamptz,
  add column if not exists backfill_complete boolean not null default false;
