alter table public.instagram_accounts
  add column if not exists posting_enabled boolean not null default true;
