# MemeOS V1.5.0

A React + TypeScript application with a Cloudflare Worker API and Supabase database/storage. This source package is version 1.5.0.

## Product scope

MemeOS is a multi-account meme discovery, review, BRAT-style asset creation and Instagram photo/Reel publishing workspace. The source build contains the V1 workflows described below; provider setup and live integration verification are still required.

## V1.5.0 implementation status

This is a deployable source-code build, not a pre-connected hosted service. External integrations still require the owner's own credentials, Meta app approval/permissions, and real-account testing.

### Implemented in this build
- Supabase authentication and user-isolated records.
- In-app API Manager for multiple Apify and Groq keys, encrypted with AES-GCM; keys are never returned to the browser.
- Apify run initiation with enabled-key fallback, configurable per-key actor JSON input, dynamic source-user placeholders, run polling, dataset retrieval, flexible output normalization, duplicate detection, image download to Supabase Storage, and job history.
- Destination accounts, reference sources, account-specific source mappings, independent discovery toggles, multiple parent relationships, cycle prevention, and inheritance propagation for newly discovered items.
- Unattended backend OCR through Cloudflare Workers AI, Groq text-only classification using the in-app multi-key manager, and server-side BRAT MP4 rendering with the generated final frame extracted as the photo PNG. The scheduled Worker runs every five minutes; closing the dashboard does not stop processing.
- Central meme library, approval actions, per-account assignment API, recurring discovery (configurable from 15 minutes to 24 hours), scheduling CRUD, and persistent five-minute Worker cron execution.
- Meta Facebook Login OAuth callback, encrypted Page-token storage, destination connection status, and scheduled native-photo publishing through the Graph API.
- Publishing history, Meta media metrics synchronization where the connected account/API returns them, analytics sync button and periodic sync, health view, global pause, automatic queue processing controls, publishing leases, bounded retries and ambiguous-publish protection.

### Not yet verified / known boundaries
- The Apify actor is user-selected. Its dataset output must contain recognizable post ID, image URL, username, and/or caption fields. Per-key JSON input supports the selected actor schema and source placeholders. Actor-specific schemas may require an adapter.
- Background OCR uses Cloudflare Workers AI (Gemma 4 vision) and runs in the scheduled Worker. The image transcription has no calibrated confidence score, so it is explicitly marked as unscored and should be checked in the approval queue. Images with no readable text are held for manual review. Groq classification and the BRAT video/final-frame pipeline also run server-side. The dashboard does not need to remain open. Processing retries are bounded and persisted in the database.
- Groq classification uses a configured model identifier; model availability can change. Failed/low-confidence candidates remain reviewable.
- Meta OAuth and publishing code are implemented but cannot be claimed live-working until a Meta app is configured, permissions are granted, and a real professional Instagram account is connected and tested. Meta requires eligible professional accounts and supported permissions. No post is published without an approved scheduled assignment.
- Reel output is prepared by the separate Node/FFmpeg render service in `render-service/`, using the `brat-canvas` progressive BRAT video renderer. The 0–5 second end-frame hold defaults to 2 seconds and is added after the renderer output. Uploaded song-library tracks are selected randomly with least-used bias and mixed into the MP4. The PNG is extracted from the literal final frame of that finished MP4. Actual Meta Reel publishing still requires live integration verification and an eligible connected professional account.
- Meta insights availability varies by media type, account eligibility, permissions and API version. MemeOS records only numeric fields returned by Meta and leaves missing metrics unavailable.
- A full dependency-backed production build and live provider test could not be completed in this environment because npm dependency installation timed out. Static source parsing and Node syntax checks are performed for this source archive, but they are not a substitute for a full dependency-backed build or deployed integration test.

## Database migrations
Run all migrations in order in Supabase SQL Editor:
1. `supabase/migrations/0001_initial.sql`
2. `supabase/migrations/0002_api_manager.sql`
3. `supabase/migrations/0003_v1_workflows.sql`
4. `supabase/migrations/0004_v13_reliability.sql`
5. `supabase/migrations/0005_server_side_automation.sql`
6. `supabase/migrations/0006_video_song_library.sql`
7. `supabase/migrations/0007_v1_completion.sql`

## Cloudflare runtime
The Worker serves the built React app and `/api/*` endpoints. It uses Supabase for authentication, database and storage. Provider keys are entered inside MemeOS Settings → API Manager; do not put individual Apify or Groq keys in Worker environment settings. The `AI` Workers AI binding provides server-side OCR. A five-minute Cron Trigger runs discovery polling, unattended OCR/classification/asset generation, and approved scheduled publishing. The separate `render-service/` Node container performs FFmpeg MP4 rendering because Cloudflare Workers are not a suitable place to run FFmpeg.

## Requirements

- Node.js 20+
- A Supabase project
- A Cloudflare account for deployment
- Optional Apify, Groq and Meta developer credentials
- Separate Node 20 render service with FFmpeg and `brat-canvas` for MP4 generation
- Cloudflare Workers AI enabled for server-side OCR

## Local setup

1. Install dependencies: `npm install`.
2. Create a Supabase project.
3. In Supabase SQL Editor, run all seven migrations in order (see Database migrations above).
4. Copy `.env.example` to `.env.local` and set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
5. Start the frontend with `npm run dev`.
6. Create an account using the sign-up link on the login screen.

## Cloudflare Worker setup

Set the following infrastructure secrets once:

```bash
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put CREDENTIALS_ENCRYPTION_KEY
```

`CREDENTIALS_ENCRYPTION_KEY` must be a base64-encoded 32-byte key. Generate one with:

```bash
openssl rand -base64 32
```

Paste the generated value when Wrangler prompts for the secret. Keep it private and back it up securely: losing it makes previously stored provider keys impossible to decrypt. Do not rotate it without first migrating/re-encrypting stored keys.

Set `SUPABASE_URL` in `wrangler.toml`, then run:

```bash
npm run build
npx wrangler deploy
```

The Worker serves `dist/` at `/` and API endpoints at `/api/*`. Its Cron Trigger processes pending memes every five minutes even when no user has the dashboard open. The AI binding is configured in `wrangler.toml`; no OCR key is stored in the browser. Reel rendering is delegated to the separately deployed `render-service/` container.

For local Worker testing, create `.dev.vars` (never commit it):

```env
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
CREDENTIALS_ENCRYPTION_KEY=YOUR_BASE64_32_BYTE_KEY
```

Then run `npm run build` and `npm run worker:dev`.

## In-app API Manager

After signing into MemeOS, open **Settings → API Manager**.

- Add as many Apify keys as needed. Give each a label and supply its Apify Actor ID.
- Add as many Groq keys as needed. Give each a label.
- Test each key, enable/disable it, and delete it.
- Provider secrets are encrypted by the Worker and only masked hints are returned to the frontend.
- Apify discovery tries enabled keys in least-recently-used order and moves on after errors/rate limits. Each key can store its own actor ID and actor input JSON.
- Multiple keys do not necessarily mean multiple quotas: keys belonging to the same provider account/organization may share quota.

Only the encryption key and Supabase service-role key remain Worker secrets. Individual Apify and Groq keys are entered inside the logged-in MemeOS app, not in Cloudflare settings.

## Supabase configuration

- Enable email/password authentication.
- Configure the site URL and allowed redirect URLs.
- Ensure the `meme-assets` bucket exists (migration 0001 creates it).
- Keep the service-role key exclusively in Cloudflare Worker secrets.
- Never put the service-role key or provider API keys in a `VITE_` variable.

## Current API routes

- `GET /api/overview`
- `GET, POST /api/accounts`
- `PATCH /api/accounts/:id`
- `GET, POST /api/sources`
- `DELETE /api/sources/:id`
- `GET, POST /api/api-credentials`
- `PATCH, DELETE /api/api-credentials/:id`
- `POST /api/api-credentials/:id/test`
- `POST /api/discovery/run`
- `GET /api/discovery/jobs` and `POST /api/discovery/jobs/:id/poll`
- `GET, POST /api/destination-sources` and `DELETE /api/destination-sources/:id`
- `GET, POST /api/relationships` and `DELETE /api/relationships/:id`
- `GET /api/assignments` and `PATCH /api/assignments/:id`
- `POST /api/analytics/sync`
- `GET /api/memes`
- `POST /api/memes/manual`
- `PATCH /api/memes/:id`
- `POST /api/memes/:id/process`
- `POST /api/memes/:id/approve`
- `GET /api/schedule`
- `GET /api/publishing`
- `GET /api/analytics`
- `GET /api/health`
- `PATCH /api/settings`

All API routes require a valid Supabase access token. The Worker validates the user token and applies the owner filter to all credential operations. Database access uses the service role only on the backend.

## Deployment from GitHub

1. Push this repository to GitHub.
2. Connect the repository to Cloudflare Workers Builds or deploy with Wrangler.
3. Set the two infrastructure secrets above.
4. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as build environment variables.
5. Apply all seven Supabase migrations in order.
6. Deploy. Then sign in and add provider keys in Settings → API Manager.

## Security notes

- Never commit `.env.local`, `.dev.vars` or credentials.
- The public storage bucket is intended for generated shareable meme images. Do not upload private media.
- Keep `CREDENTIALS_ENCRYPTION_KEY` private and backed up. It is the encryption root for all provider keys stored by this app.
- Review Meta's current official Instagram Graph API documentation and account eligibility before implementing production publishing.
- The Apify actor must be reviewed for its actual schema, legal terms, and Instagram access limitations.


## V1.5 background processing and Reel behavior

- Enable **Automatic content processing** in Settings (enabled by default).
- The Cloudflare Worker Cron Trigger runs every five minutes. OCR, Groq classification and BRAT MP4/final-frame rendering run on the backend; the dashboard does not need to be open and the user does not need to stay signed in.
- OCR uses Cloudflare Workers AI Gemma 4 vision. The model does not provide a calibrated OCR confidence score in this workflow, so MemeOS does not invent one; extracted text is explicitly marked as unscored for human verification.
- Candidates with no readable text are held for manual review. Groq only classifies text already extracted from the image and never rewrites the joke.
- Processing locks, attempts, errors and retry times are persisted. Retries are bounded to five attempts with exponential backoff. A failed item can be requeued from the Approval Queue.
- Global pause stops background processing. Disabling automatic content processing pauses OCR/classification/generation while preserving pending items.
- The system does not auto-approve or publish discovered memes. A person must approve each destination assignment before scheduling.

## Reliability behavior

- Apify polling retries transient failures with bounded exponential backoff and a maximum attempt count. Terminal Apify run states are not retried.
- Instagram publishing retries only failures that occur before the `media_publish` request is submitted. If the response to that request is ambiguous, the assignment is moved to `needs_review` rather than automatically retried, preventing accidental duplicate posts. Check the Instagram account before taking manual action.
- The API credentials table is no longer granted to browser roles by the V1.3 migration; credentials are accessed through the authenticated Worker API.


## Song library and Reels (V1.5)

- Apply migrations `0006_video_song_library.sql` and `0007_v1_completion.sql` after migrations 0001–0005.
- In the app, open **Song Library** and upload audio files you have rights to use. Files are private per user and capped at 30 MB each.
- Settings includes **Reel final-frame freeze**, from 0 to 5 seconds in 0.5-second increments, default 2 seconds. It also includes the recurring discovery interval. The renderer adds this hold after the progressive word reveal and keeps the final frame unchanged.
- The renderer calls `bratVid` from `brat-canvas/video` to create a progressive word-reveal MP4, then FFmpeg adds the configured 0–5 second final-frame hold and mixes one enabled library track. The photo PNG is derived from the finished MP4 final frame, fitted into a 4:5 canvas with the same green background (no text content is cropped) for feed-photo compatibility; Reels use the full 9:16 MP4.
- `render-service/` is a separate Node 20 + FFmpeg service using `brat-canvas`. Build it from its Dockerfile and protect `/render` with a shared token. Set the renderer service `SUPABASE_URL` so it only accepts signed audio URLs from the configured private song bucket. The Cloudflare Worker must be configured with the renderer URL/token before background Reel rendering can run.
- Renderer clarification: the linked `tanbaycu/BraText` repository documents image export, not an MP4 API. To meet the MP4 workflow, this build uses the MIT-licensed `brat-canvas` video module for progressive BRAT text rendering and FFmpeg for the final-frame hold/audio mux. This is not a direct MP4 call to the `tanbaycu/BraText` repository.
- Only upload audio you own or are licensed to use.

### Render service local check

```bash
cd render-service
npm install
RENDER_SERVICE_TOKEN=local-test npm start
```

Health check: `GET /health`. Authenticated render: `POST /render` with `x-render-token`, JSON `{ "text": "your text", "freeze_seconds": 2, "audio_url": "https://...signed-audio-url..." }`.


## V1.5 completion additions

- Recurring discovery starts automatically for owners with at least one enabled destination account, an enabled source and an enabled Apify key. The default interval is 60 minutes and can be changed in Settings.
- Apify credentials store a per-key Actor ID and actor input JSON. Supported source placeholders: `{{usernames}}`, `{{profile_urls}}`, and `{{start_urls}}`. Review the chosen actor's own input schema before relying on unattended runs.
- Analytics sync reads the published media fields Meta returns and attempts the `reach` media insight. It stores daily snapshots and does not synthesize unavailable metrics.
- Scheduled publishing uses a database lease. If a worker crashes after a publish attempt begins, the assignment is moved to `needs_review` after lease expiry instead of blindly publishing again.
- Groq classification uses `openai/gpt-oss-20b`; the previous `llama-3.3-70b-versatile` model was deprecated for developer-tier use on 2026-08-16.
