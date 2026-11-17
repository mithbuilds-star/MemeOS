-- Persistent retry streaks for the MemeOS processing pipeline.
alter table public.memes
  add column if not exists processing_consecutive_errors integer not null default 0,
  add column if not exists processing_same_error_count integer not null default 0,
  add column if not exists processing_last_error_key text;

-- Historical attempt totals are not consecutive failures. Seed only one error when an old row still has an error message.
update public.memes
set processing_consecutive_errors = case when processing_error is null then 0 else 1 end,
    processing_same_error_count = case when processing_error is null then 0 else 1 end,
    processing_last_error_key = case when processing_error is null then null else lower(regexp_replace(trim(processing_error), '[[:space:]]+', ' ', 'g')) end;

-- Remove invalid approval cards without deleting the underlying meme or assignment history.
update public.account_meme_assignments a
set approval_status = 'rejected',
    status = 'rejected',
    scheduled_at = null,
    publishing_locked_until = null,
    publishing_started_at = null,
    rejection_reason = 'Automatically closed because the source meme is rejected or discarded.'
from public.memes m
where a.meme_id = m.id
  and a.approval_status = 'pending'
  and m.processing_status in ('rejected', 'discarded', 'media_unavailable', 'low_confidence');
