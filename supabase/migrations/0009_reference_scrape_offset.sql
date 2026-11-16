alter table public.reference_accounts add column if not exists scraped_offset integer not null default 0;
