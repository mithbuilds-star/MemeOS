-- V1.4: song library and configurable Reel end-frame hold.
alter table public.user_settings add column if not exists video_freeze_seconds numeric(2,1) not null default 2.0 check (video_freeze_seconds >= 0 and video_freeze_seconds <= 5);
alter table public.memes add column if not exists reel_asset_path text;
alter table public.memes add column if not exists reel_asset_url text;
alter table public.memes add column if not exists reel_status text not null default 'not_started';
alter table public.memes add column if not exists reel_song_id uuid;
alter table public.account_meme_assignments add column if not exists publish_format text not null default 'photo' check (publish_format in ('photo','reel'));

create table if not exists public.song_library (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete cascade,
 title text not null, original_filename text not null, storage_path text not null unique,
 mime_type text not null, file_size bigint not null default 0,
 is_active boolean not null default true, times_used integer not null default 0,
 last_used_at timestamptz, created_at timestamptz not null default now()
);
alter table public.song_library enable row level security;
drop policy if exists song_library_owner_all on public.song_library;
create policy song_library_owner_all on public.song_library for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create index if not exists idx_song_library_owner_active_recent on public.song_library(owner_id,is_active,last_used_at);

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('song-library','song-library',false,31457280,array['audio/mpeg','audio/mp4','audio/aac','audio/wav','audio/x-wav','audio/ogg','audio/webm','audio/flac'])
on conflict (id) do update set public=false,file_size_limit=31457280,allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists song_library_owner_upload on storage.objects;
create policy song_library_owner_upload on storage.objects for insert to authenticated with check (bucket_id='song-library' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists song_library_owner_read on storage.objects;
create policy song_library_owner_read on storage.objects for select to authenticated using (bucket_id='song-library' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists song_library_owner_delete on storage.objects;
create policy song_library_owner_delete on storage.objects for delete to authenticated using (bucket_id='song-library' and (storage.foldername(name))[1]=auth.uid()::text);

-- Allow generated MP4s in the existing generated-media bucket.
update storage.buckets set file_size_limit=104857600, allowed_mime_types=array['image/png','image/jpeg','image/webp','video/mp4'] where id='meme-assets';
