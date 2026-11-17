-- Terminal processing items are discarded from the active pipeline after three attempts.
-- Preserve their meme rows and media; this only changes processing lifecycle state.
update public.memes
set
  processing_status = 'discarded',
  reel_status = case
    when reel_status in ('render_failed', 'rendering') then 'discarded'
    else reel_status
  end
where processing_status in ('failed', 'processing_failed')
  and coalesce(processing_attempts, 0) >= 3;

-- Discarded items are excluded by the Worker claim and Reel scheduler queries.
