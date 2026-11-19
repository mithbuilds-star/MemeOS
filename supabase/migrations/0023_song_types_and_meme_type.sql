-- Song types: each song lists the moods/types it fits (for example sad, funny, sarcasm).
-- A meme gets one type when its Reel renders; that type is stored, not shown in the app.
alter table public.song_library add column if not exists types text[] not null default '{}';
alter table public.memes add column if not exists meme_type text;
create index if not exists idx_song_library_types on public.song_library using gin (types);
