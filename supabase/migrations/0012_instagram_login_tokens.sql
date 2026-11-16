alter table public.instagram_accounts add column if not exists meta_user_id text;
alter table public.instagram_accounts add column if not exists meta_token_expires_at timestamptz;
alter table public.instagram_accounts add column if not exists meta_token_refreshed_at timestamptz;
alter table public.instagram_accounts add column if not exists meta_token_refresh_error text;
alter table public.instagram_accounts add column if not exists profile_picture_url text;
