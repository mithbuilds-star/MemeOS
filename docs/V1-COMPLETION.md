# MemeOS V1 completion status

This archive is the V1.5 source-complete candidate. It contains the V1 product workflows; it is not a deployed or production-certified instance.

## Implemented in source

- React dashboard, Supabase authentication, accounts and reference-source management.
- Per-destination discovery toggles, source mapping, multiple parent links, cycle protection and transitive inheritance.
- In-app multi-key Apify/Groq API Manager. Keys are encrypted server-side, never returned to the browser, and provider 429 responses trigger a cooldown before reuse.
- Per-key Apify Actor ID and JSON input, including `{{usernames}}`, `{{profile_urls}}`, and `{{start_urls}}` placeholders.
- Recurring discovery and persistent Apify run polling through the every-minute Worker Cron Trigger.
- Server-side Workers AI OCR, Groq text-only suitability classification, editable extracted text and manual-review handling.
- BRAT progressive MP4 generation through `brat-canvas/video`; the final-frame photo PNG is derived from the completed MP4 and fitted into a 4:5 canvas without cropping the text content.
- Song library upload, preview, enable/disable/delete, least-used-biased random selection and audio mixing into Reels.
- 0–5 second final-frame freeze setting (default 2 seconds).
- Per-account approval, approval reset after text edits, scheduling, Meta OAuth, photo publishing, Reel publishing, publishing history and Meta media analytics sync where available.
- Persistent job leases, retries, crash recovery, global pause and health reporting.

## Verification performed in this build environment

- TypeScript/TSX source parsing: passed.
- Render service JavaScript syntax check: passed.
- JSON and Wrangler TOML parsing: passed.
- FFmpeg smoke test for final-frame hold and 4:5 poster fitting: passed (1080×1920 Reel, 1080×1350 photo asset).
- ZIP integrity: checked after packaging.

## Not verified here

- Full dependency-backed `npm run build`: npm registry DNS resolution failed (`EAI_AGAIN`), so dependencies could not be installed in this environment.
- Actual `brat-canvas` package execution inside the render-service container.
- Supabase migrations against a live project.
- The exact Apify actor input/output contract selected by the user.
- Live Meta OAuth, publishing and insights. These require the user's Meta app, eligible professional Instagram accounts and granted permissions.

## Renderer naming note

The previously referenced `tanbaycu/BraText` repository documents image generation rather than an MP4 API. To provide the agreed progressive BRAT MP4 workflow, this build uses the separate `brat-canvas` video module and FFmpeg. It does not claim to call an MP4 endpoint from that BraText repository.

## Deployment state

Nothing has been deployed and no Supabase project has been configured. The database migrations and deployment notes are included for later setup.
