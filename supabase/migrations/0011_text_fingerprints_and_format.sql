-- Every extracted text is recorded (as a SHA-256 of its normalised form) so a repeat is detected
-- against all earlier memes, whatever their status.
create table if not exists public.meme_text_fingerprints (
  owner_id uuid not null,
  fingerprint text not null,
  meme_id uuid not null references public.memes(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_id, fingerprint)
);
create index if not exists idx_text_fingerprints_meme on public.meme_text_fingerprints(meme_id);
alter table public.meme_text_fingerprints enable row level security;
drop policy if exists owner_all on public.meme_text_fingerprints;
create policy owner_all on public.meme_text_fingerprints for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Backfill from memes that already have text. Same normalisation as the Worker:
-- trim, collapse whitespace, lower-case, then SHA-256 (UTF-8).
insert into public.meme_text_fingerprints (owner_id, fingerprint, meme_id)
select distinct on (owner_id, fp) owner_id, fp, id
from (
  select owner_id, id, created_at,
    encode(sha256(convert_to(
      lower(regexp_replace(regexp_replace(extracted_text, '\s+', ' ', 'g'), '^ | $', '', 'g'))
    , 'UTF8')), 'hex') as fp
  from public.memes
  where extracted_text is not null and btrim(extracted_text) <> ''
) s
order by owner_id, fp, created_at
on conflict (owner_id, fingerprint) do nothing;
