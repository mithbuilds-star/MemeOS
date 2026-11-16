-- V1.3.1: move OCR, classification and BRAT generation to the scheduled Worker.
alter table public.memes add column if not exists source_asset_path text;
alter table public.memes add column if not exists source_asset_url text;
alter table public.memes add column if not exists processing_attempts integer not null default 0;
alter table public.memes add column if not exists processing_next_retry_at timestamptz;
alter table public.memes add column if not exists processing_locked_until timestamptz;
alter table public.memes add column if not exists processing_error text;

-- Preserve the original discovered image before the generated BRAT PNG replaces the display asset.
update public.memes
set source_asset_path = coalesce(source_asset_path, asset_path),
    source_asset_url = coalesce(source_asset_url, asset_url)
where source_type = 'discovery' and asset_url is not null;

create index if not exists idx_memes_background_processing
on public.memes(processing_status, processing_next_retry_at, created_at)
where processing_status in ('needs_ocr','ocr_complete','ready_for_asset');
