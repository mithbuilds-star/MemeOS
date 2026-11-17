-- Support Meta Unified Login / System User Access Tokens.
-- Tokens are encrypted by the Worker before they are stored.
alter table public.instagram_accounts
  add column if not exists meta_access_token_enc text,
  add column if not exists meta_access_token_iv text,
  add column if not exists meta_token_type text,
  add column if not exists meta_api_host text;

-- Existing Instagram Login rows continue to use the Instagram Graph host.
update public.instagram_accounts
set meta_api_host = 'graph.instagram.com'
where meta_access_token_enc is not null and meta_api_host is null;
