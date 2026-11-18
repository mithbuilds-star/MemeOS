-- Marks accounts whose existing (undated) posts have been dated from a one-off Apify pull.
alter table public.reference_accounts add column if not exists legacy_dated_at timestamptz;
