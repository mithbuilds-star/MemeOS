-- Ownership and lifecycle for server-side processing.
-- processing_token identifies the worker that holds a job; every later write must match it.
alter table public.memes add column if not exists processing_token uuid;
alter table public.memes add column if not exists processing_failed_at timestamptz;
-- Supports the stale-lease sweep and claim checks.
create index if not exists idx_memes_processing_lease
  on public.memes(processing_locked_until)
  where processing_status in ('needs_ocr','ocr_complete','ready_for_asset');
