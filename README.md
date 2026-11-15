# MemeOS V1

A React + TypeScript application with a Cloudflare Worker API and Supabase database/storage.

## V1 scope

- Supabase authentication and user-isolated data.
- Monochrome dashboard and responsive application shell.
- Destination account and reference source management.
- Apify actor run initiation.
- Manual BRAT-style PNG creator and Supabase Storage upload.
- Central meme records and review queue.
- Scheduler and publishing history views.
- Basic analytics and system health.
- Cloudflare Worker API and Supabase SQL migration.

## Important implementation status

This repository is a V1 source-code build, not a pre-connected hosted service. It does not include private credentials or an already-authorized Instagram account.

**Credential-dependent / not yet live-verified:**
- Apify actor compatibility: configure an actor whose input accepts `usernames` and whose dataset output you normalize before production use.
- OCR ingestion and automated classification: browser OCR dependency is included in the package, but the current discovery route only starts the Apify run. Dataset polling, media download, OCR, classification and automated BRAT processing remain the next integration implementation.
- Meta OAuth and actual photo publishing: not yet implemented as a live flow. No account is claimed connected and no post is published.
- Scheduled publishing worker: schema and cron entry exist; the scheduled job runner and Meta publish implementation still need completion.
- Parent account relationship UI and assignment propagation: database tables and cycle prevention exist; management UI and propagation engine remain to be completed.
- Groq classification: secret slot is documented; no live call is made.
- Analytics: only publishing record counts are available; actual Meta insights are not yet synced.

These are intentionally disclosed rather than represented as working integrations.

## Requirements

- Node.js 20+
- A Supabase project
- A Cloudflare account for deployment
- Optional Apify, Groq and Meta developer credentials

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a Supabase project.

3. In Supabase SQL Editor, run:

   `supabase/migrations/0001_initial.sql`

4. Copy `.env.example` to `.env.local` and set:

   ```env
   VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
   VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
   ```

5. Start the frontend:

   ```bash
   npm run dev
   ```

6. Create an account using the sign-up link on the login screen.

## Cloudflare Worker setup

Set Worker secrets:

```bash
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put APIFY_API_TOKEN
npx wrangler secret put APIFY_ACTOR_ID
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put META_APP_ID
npx wrangler secret put META_APP_SECRET
npx wrangler secret put META_REDIRECT_URI
```

Set `SUPABASE_URL` in `wrangler.toml`, then:

```bash
npm run build
npx wrangler deploy
```

The Worker serves `dist/` at `/` and API endpoints at `/api/*`.

For local Worker testing, create `.dev.vars` (never commit it):

```env
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
APIFY_API_TOKEN=YOUR_APIFY_TOKEN
APIFY_ACTOR_ID=YOUR_ACTOR_ID
```

Then run:

```bash
npm run build
npm run worker:dev
```

## Supabase configuration

- Enable email/password authentication.
- Configure the site URL and allowed redirect URLs.
- Ensure the `meme-assets` bucket exists (the migration creates it).
- Keep the service-role key exclusively in Cloudflare Worker secrets.
- Never put the service-role key in a `VITE_` variable.

## Current API routes

- `GET /api/overview`
- `GET, POST /api/accounts`
- `PATCH /api/accounts/:id`
- `GET, POST /api/sources`
- `DELETE /api/sources/:id`
- `POST /api/discovery/run`
- `GET /api/memes`
- `POST /api/memes/manual`
- `POST /api/memes/:id/approve`
- `GET /api/schedule`
- `GET /api/publishing`
- `GET /api/analytics`
- `GET /api/health`
- `PATCH /api/settings`

All API routes require a valid Supabase access token. Worker database access uses the service role only after validating the user's token and applying the owner filter.

## Deployment from GitHub

1. Push this repository to GitHub.
2. Connect the repository to Cloudflare Workers Builds or deploy with Wrangler.
3. Set Worker variables and secrets.
4. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as build environment variables.
5. Deploy after the Supabase migration is applied.

## Security notes

- Never commit `.env.local`, `.dev.vars` or credentials.
- The public storage bucket is intended for generated shareable meme images. Do not upload private media.
- Review Meta's current official Instagram Graph API documentation and account eligibility before implementing production publishing.
- The Apify actor must be reviewed for its actual schema, legal terms, and Instagram access limitations.
