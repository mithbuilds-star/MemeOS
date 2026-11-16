-- MemeOS V1.3: processing controls and retry scheduling.
alter table public.user_settings add column if not exists auto_process_enabled boolean not null default true;
alter table public.jobs add column if not exists attempt_count integer not null default 0;
alter table public.jobs add column if not exists max_attempts integer not null default 5;
alter table public.jobs add column if not exists last_attempt_at timestamptz;
alter table public.jobs add column if not exists locked_until timestamptz;
create index if not exists idx_jobs_retry_due on public.jobs(status, next_retry_at) where status in ('queued','running');
create index if not exists idx_memes_processing_queue on public.memes(owner_id, processing_status, created_at) where processing_status in ('needs_ocr','ocr_complete','ready_for_asset');

-- Provider ciphertext must only be read by the service-role Worker, never by browser clients.
drop policy if exists owner_all on public.api_credentials;
revoke all on table public.api_credentials from anon, authenticated;

-- Bounded publishing retry metadata. The Worker only retries failures before publish is submitted;
-- an ambiguous publish response is held for manual reconciliation to avoid duplicate posts.
alter table public.account_meme_assignments add column if not exists publish_attempts integer not null default 0;
alter table public.account_meme_assignments add column if not exists last_publish_error text;
create index if not exists idx_assignments_retry_due on public.account_meme_assignments(status, scheduled_at) where status = 'scheduled';
