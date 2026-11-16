# MemeOS roadmap

## V1.0 — application foundation
- React dashboard, sign-in, destination account and reference source management.
- Supabase-backed content library, approval queue, scheduler and publishing history views.
- In-app encrypted API Manager for multiple Apify and Groq keys.

## V1.1 — discovery and account graph
- Apify actor runs, polling, dataset retrieval, media import and deduplication.
- Per-key actor input JSON, source placeholders, independent destination discovery settings, source mappings, multiple parent accounts and inheritance.

## V1.2 — content intelligence and assets
- Workers AI vision OCR, Groq text-only suitability classification, BRAT PNG output, queue and assignment workflows.
- Native photo publishing and scheduling foundations.

## V1.3 — unattended processing
- Cloudflare Worker Cron Trigger processes discovery polling, OCR, classification and asset generation every minute.
- Persistent processing locks, retries, error state and manual requeue.
- Recurring discovery is configurable from 15 minutes to 24 hours. Closing the browser or signing out does not stop backend processing.
- Approval remains manual; publishing requires an approved assignment and configured Meta integration.

## V1.4 — Reels and song library
- `brat-canvas/video` creates progressive BRAT text-reveal MP4s; FFmpeg adds the user-configurable 0–5 second final-frame hold and selected audio track.
- The photo PNG is extracted from the literal final frame of the finished MP4.
- Private per-user song library, random selection with least-used bias, and audio mixed into Reel MP4s.
- Queue approval distinguishes photo posts from Reels; scheduled publishing uses the matching asset type.

## V1.5 — V1 completion
- Meta media analytics sync where available, with truthful unavailable states.
- Database-backed publishing leases and ambiguous-publish protection.
- Retry handling for Reel rendering, source-media URL validation and actor-specific Apify input.
- Build/deployment documentation and migration consolidation.

## Later (V2+)
- Richer account-level analytics, performance-based content ranking, scheduling recommendations, expanded media formats and additional provider adapters.

## Known integration boundaries
- Apify actors have different input/output schemas; actor-specific JSON input and adapters may be required.
- Workers AI OCR is model-based, not calibrated OCR confidence. Extracted text must be checked before approval.
- Instagram OAuth/publishing and analytics require a configured Meta app, eligible professional account, permissions and live testing.
- The linked `tanbaycu/BraText` repository documents text-to-image output, not an MP4 API. This build uses the separate MIT-licensed `brat-canvas` video module for progressive BRAT MP4 output.
