alter table public.memes add column if not exists output_format text check (output_format in ('photo','reel'));
