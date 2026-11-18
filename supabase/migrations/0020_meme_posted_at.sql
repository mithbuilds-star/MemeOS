-- Store each discovered post's publish time so cursor windows can be checked against imported data.
alter table public.memes add column if not exists source_posted_at timestamptz;
create index if not exists idx_memes_source_posted_at on public.memes (owner_id, source_reference_account_id, source_posted_at);
