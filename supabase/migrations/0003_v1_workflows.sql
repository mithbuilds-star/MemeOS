-- V1 workflow completion: durable discovery state, assignment scheduling and account graph indexes.
create index if not exists idx_jobs_owner_type_created on public.jobs(owner_id, job_type, created_at desc);
create index if not exists idx_assignments_due on public.account_meme_assignments(status, scheduled_at) where scheduled_at is not null;
create index if not exists idx_assignments_destination on public.account_meme_assignments(owner_id, destination_account_id, approval_status);
create index if not exists idx_relationships_owner_parent on public.account_relationships(owner_id, parent_account_id);
create index if not exists idx_relationships_owner_child on public.account_relationships(owner_id, child_account_id);
create index if not exists idx_memes_owner_source on public.memes(owner_id, source_type, created_at desc);

alter table public.reference_accounts add column if not exists last_scrape_status text;
alter table public.jobs add column if not exists locked_at timestamptz;
alter table public.jobs add column if not exists next_retry_at timestamptz;
alter table public.jobs add column if not exists idempotency_key text;
create unique index if not exists idx_jobs_owner_idempotency on public.jobs(owner_id,idempotency_key) where idempotency_key is not null;

-- API credentials are private; only the Worker service role should read ciphertext.
-- The authenticated client receives metadata through the authenticated Worker API.
drop policy if exists owner_all on public.api_credentials;
create policy owner_all on public.api_credentials for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

alter table public.instagram_accounts add column if not exists meta_page_id text;
alter table public.instagram_accounts add column if not exists meta_access_token_enc text;
alter table public.instagram_accounts add column if not exists meta_access_token_iv text;
alter table public.instagram_accounts add column if not exists token_expires_at timestamptz;

create table if not exists public.meta_oauth_states (
  state text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  destination_account_id uuid not null references public.instagram_accounts(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.meta_oauth_states enable row level security;
-- No client policies: OAuth state is only read and written by the Worker service role.
