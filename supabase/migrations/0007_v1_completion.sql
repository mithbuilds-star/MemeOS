-- V1 completion: recurring discovery, actor-specific input, analytics snapshots and safe job leases.
alter table public.api_credentials add column if not exists actor_input jsonb not null default '{}'::jsonb;
alter table public.api_credentials add column if not exists cooldown_until timestamptz;
create index if not exists idx_api_credentials_cooldown on public.api_credentials(owner_id,provider,enabled,cooldown_until);

alter table public.user_settings add column if not exists discovery_interval_minutes integer not null default 60 check (discovery_interval_minutes in (15,30,60,120,360,720,1440));
alter table public.user_settings add column if not exists last_discovery_started_at timestamptz;
alter table public.user_settings add column if not exists discovery_lock_until timestamptz;
alter table public.user_settings add column if not exists last_analytics_sync_at timestamptz;

alter table public.publishing_history add column if not exists analytics_synced_at timestamptz;
alter table public.publishing_history add column if not exists analytics_sync_error text;

alter table public.analytics add column if not exists collected_on date not null default current_date;
alter table public.analytics add column if not exists meta_media_id text;
create unique index if not exists idx_analytics_media_metric_day
  on public.analytics(owner_id, meme_id, destination_account_id, metric_name, collected_on)
  where meme_id is not null and destination_account_id is not null;
create unique index if not exists idx_analytics_account_metric_day
  on public.analytics(owner_id, destination_account_id, metric_name, collected_on)
  where meme_id is null and destination_account_id is not null;

alter table public.account_meme_assignments add column if not exists publishing_locked_until timestamptz;
alter table public.account_meme_assignments add column if not exists publishing_started_at timestamptz;
create index if not exists idx_assignments_due_lease
  on public.account_meme_assignments(status, scheduled_at, publishing_locked_until)
  where status in ('scheduled','publishing');

alter table public.memes add column if not exists reel_render_next_retry_at timestamptz;
alter table public.memes add column if not exists reel_render_locked_until timestamptz;
create index if not exists idx_memes_reel_retry
  on public.memes(reel_status, reel_render_next_retry_at)
  where reel_status in ('waiting_for_song','renderer_not_configured','render_failed');
