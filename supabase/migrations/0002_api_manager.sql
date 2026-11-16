create table if not exists public.api_credentials (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('apify','groq')),
  label text not null,
  encrypted_secret text not null,
  encryption_iv text not null,
  key_hint text,
  actor_id text,
  enabled boolean not null default true,
  status text not null default 'untested',
  last_tested_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_api_credentials_owner_provider on public.api_credentials(owner_id, provider, enabled, last_used_at);
alter table public.api_credentials enable row level security;
drop policy if exists owner_all on public.api_credentials;
create policy owner_all on public.api_credentials for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
