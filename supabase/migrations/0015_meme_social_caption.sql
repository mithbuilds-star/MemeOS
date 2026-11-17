-- Store the short AI-generated / editable Instagram caption on each meme.
alter table public.memes
  add column if not exists social_caption text;

alter table public.memes
  add constraint memes_social_caption_max_length
  check (social_caption is null or char_length(social_caption) <= 80);
