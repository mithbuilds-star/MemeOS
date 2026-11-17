alter table public.user_settings
  add column if not exists auto_post_enabled boolean not null default false,
  add column if not exists posts_per_day integer not null default 3;

alter table public.user_settings
  drop constraint if exists user_settings_posts_per_day_check;

alter table public.user_settings
  add constraint user_settings_posts_per_day_check
  check (posts_per_day between 1 and 10);

alter table public.account_meme_assignments
  add column if not exists auto_scheduled boolean not null default false;
