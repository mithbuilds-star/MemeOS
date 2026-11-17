alter table public.api_credentials
  add column if not exists usage_snapshot jsonb,
  add column if not exists usage_refreshed_at timestamptz;

alter table public.user_settings
  add column if not exists last_usage_refresh_date date;
