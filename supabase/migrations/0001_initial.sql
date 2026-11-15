create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  preferences jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.instagram_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  instagram_account_id text,
  username text not null,
  display_name text,
  account_type text,
  connection_status text not null default 'not_connected',
  token_expires_at timestamptz,
  discovery_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, username)
);

create table if not exists public.reference_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  username text not null,
  instagram_profile_id text,
  enabled boolean not null default true,
  last_scraped_at timestamptz,
  last_scrape_status text,
  created_at timestamptz not null default now(),
  unique(owner_id, username)
);

create table if not exists public.account_relationships (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  parent_account_id uuid not null references public.instagram_accounts(id) on delete cascade,
  child_account_id uuid not null references public.instagram_accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  check(parent_account_id <> child_account_id),
  unique(parent_account_id, child_account_id)
);

create table if not exists public.destination_sources (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  destination_account_id uuid not null references public.instagram_accounts(id) on delete cascade,
  reference_account_id uuid not null references public.reference_accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(destination_account_id, reference_account_id)
);

create table if not exists public.memes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  source_type text not null default 'discovery',
  source_reference_account_id uuid references public.reference_accounts(id) on delete set null,
  source_post_id text,
  source_permalink text,
  source_username text,
  original_caption text,
  extracted_text text,
  ocr_confidence numeric,
  classification text not null default 'needs_review',
  classification_reason text,
  processing_status text not null default 'pending',
  original_post_type text,
  asset_path text,
  asset_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, source_post_id)
);

create table if not exists public.meme_assets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  meme_id uuid not null references public.memes(id) on delete cascade,
  asset_type text not null default 'png',
  storage_path text not null,
  width integer,
  height integer,
  generation_settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.account_meme_assignments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  meme_id uuid not null references public.memes(id) on delete cascade,
  destination_account_id uuid not null references public.instagram_accounts(id) on delete cascade,
  assignment_source text not null default 'manual',
  approval_status text not null default 'pending' check(approval_status in ('pending','approved','rejected')),
  rejection_reason text,
  scheduled_at timestamptz,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  unique(meme_id, destination_account_id)
);

create table if not exists public.publishing_history (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  meme_id uuid references public.memes(id) on delete set null,
  destination_account_id uuid references public.instagram_accounts(id) on delete set null,
  meta_media_id text,
  permalink text,
  status text not null default 'pending',
  error_message text,
  published_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  job_type text not null,
  related_entity_id uuid,
  status text not null default 'queued',
  retry_count integer not null default 0,
  provider_run_id text,
  metadata jsonb not null default '{}'::jsonb,
  last_error text,
  scheduled_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.user_settings (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  global_paused boolean not null default false,
  timezone text not null default 'Asia/Kolkata',
  preferences jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.integration_settings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  status text not null default 'not_configured',
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique(owner_id, provider)
);

create table if not exists public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.analytics (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  meme_id uuid references public.memes(id) on delete cascade,
  destination_account_id uuid references public.instagram_accounts(id) on delete cascade,
  metric_name text not null,
  metric_value numeric,
  source text not null default 'meta',
  collected_at timestamptz not null default now()
);

create index if not exists idx_memes_owner_created on public.memes(owner_id, created_at desc);
create index if not exists idx_assignments_owner_status on public.account_meme_assignments(owner_id, approval_status);
create index if not exists idx_jobs_status_schedule on public.jobs(status, scheduled_at);
create index if not exists idx_sources_owner_enabled on public.reference_accounts(owner_id, enabled);
create index if not exists idx_publish_owner_created on public.publishing_history(owner_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.instagram_accounts enable row level security;
alter table public.reference_accounts enable row level security;
alter table public.account_relationships enable row level security;
alter table public.destination_sources enable row level security;
alter table public.memes enable row level security;
alter table public.meme_assets enable row level security;
alter table public.account_meme_assignments enable row level security;
alter table public.publishing_history enable row level security;
alter table public.jobs enable row level security;
alter table public.user_settings enable row level security;
alter table public.integration_settings enable row level security;
alter table public.activity_logs enable row level security;
alter table public.analytics enable row level security;

do $$
declare t text;
begin
  foreach t in array array['profiles','instagram_accounts','reference_accounts','account_relationships','destination_sources','memes','meme_assets','account_meme_assignments','publishing_history','jobs','user_settings','integration_settings','activity_logs','analytics']
  loop
    execute format('drop policy if exists owner_all on public.%I', t);
    execute format('create policy owner_all on public.%I for all using (owner_id = auth.uid()) with check (owner_id = auth.uid())', t);
  end loop;
end $$;

create or replace function public.prevent_account_cycle()
returns trigger language plpgsql as $$
begin
  if exists (
    with recursive descendants(id) as (
      select child_account_id from public.account_relationships where parent_account_id = new.child_account_id
      union
      select ar.child_account_id from public.account_relationships ar join descendants d on ar.parent_account_id = d.id
    )
    select 1 from descendants where id = new.parent_account_id
  ) then raise exception 'Account relationship would create a cycle'; end if;
  return new;
end $$;

drop trigger if exists account_relationship_cycle on public.account_relationships;
create trigger account_relationship_cycle before insert or update on public.account_relationships
for each row execute function public.prevent_account_cycle();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('meme-assets','meme-assets',true,10485760,array['image/png','image/jpeg','image/webp'])
on conflict (id) do nothing;

drop policy if exists "owner can upload meme assets" on storage.objects;
create policy "owner can upload meme assets" on storage.objects for insert to authenticated
with check (bucket_id = 'meme-assets' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "owner can update meme assets" on storage.objects;
create policy "owner can update meme assets" on storage.objects for update to authenticated
using (bucket_id = 'meme-assets' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "owner can delete meme assets" on storage.objects;
create policy "owner can delete meme assets" on storage.objects for delete to authenticated
using (bucket_id = 'meme-assets' and (storage.foldername(name))[1] = auth.uid()::text);
