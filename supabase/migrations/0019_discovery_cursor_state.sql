-- Per-account discovery state. Cursors stay on reference_accounts so every account
-- advances independently. Dedupe is already enforced by memes_owner_id_source_post_id_key
-- (unique owner_id + source_post_id), which the worker uses with ignore-duplicates inserts.
alter table public.reference_accounts
  add column if not exists discovery_upper_bound timestamptz,
  add column if not exists discovery_sweep_top timestamptz,
  add column if not exists backfill_pages integer not null default 0,
  add column if not exists backfill_stop_reason text;
