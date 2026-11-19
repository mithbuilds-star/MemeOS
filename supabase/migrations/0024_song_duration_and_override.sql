-- Song length, so the renderer can pick a song that covers the Reel.
alter table public.song_library add column if not exists duration_seconds numeric(8,2);
-- A song chosen by hand in the approval queue; used once for the next render, then cleared.
alter table public.memes add column if not exists reel_song_override uuid;
