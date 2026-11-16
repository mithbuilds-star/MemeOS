# MemeOS deployment guide (Cloudflare Worker + Supabase + GitHub Actions renderer)

There is no separate render server any more. Videos are rendered by a GitHub Actions job
(`.github/workflows/render-meme.yml`, code in `render/`). The Cloudflare Worker serves the app and
triggers renders.

## 1. Supabase
1. Project ref: `brlqdwnpoamvfuhdpdtx` (set in `wrangler.toml`).
2. Make sure migrations 0001–0007 are applied (SQL Editor, in order).
3. Auth → Sign In / Providers → enable Email. Turn on Leaked Password Protection.
4. Storage: the `meme-assets` and `song-library` buckets must exist (migrations create them).
5. Keys: Project Settings → API Keys. Copy:
   - the **publishable** key (`sb_publishable_...`) — goes to the Worker as a variable
   - the **secret** key (`sb_secret_...`) — goes to the Worker AND to GitHub as secrets

## 2. Cloudflare Worker
Variables (Worker → Settings → Variables, or `wrangler.toml` `[vars]`):

| Name | Value | Where |
|---|---|---|
| `SUPABASE_URL` | `https://brlqdwnpoamvfuhdpdtx.supabase.co` | `wrangler.toml` |
| `SUPABASE_PUBLISHABLE_KEY` | your publishable key | Worker variable |
| `APP_ENV` | `production` | `wrangler.toml` |
| `META_GRAPH_VERSION` | `v27.0` | `wrangler.toml` |
| `GITHUB_REPO` | `mithbuilds-star/MemeOS` | `wrangler.toml` |

Secrets (Worker → Settings → Variables and Secrets → Add → type **Secret**, or `npx wrangler secret put NAME`):

| Name | Value |
|---|---|
| `SUPABASE_SECRET_KEY` | the Supabase **secret** key |
| `CREDENTIALS_ENCRYPTION_KEY` | base64 32-byte key: `openssl rand -base64 32`. Keep a backup — losing it makes stored API keys unreadable. |
| `GITHUB_TOKEN` | a GitHub fine-grained token (see step 3) |

Remove any old Worker variables that no longer exist: `RENDER_SERVICE_URL`, `RENDER_SERVICE_TOKEN`,
`RENDER_API_KEY`, `RENDER_OWNER_ID`, `RENDER_SERVICE_ID`.

Deploy:
```bash
npm install
npm run build
npx wrangler deploy
```
If Cloudflare Workers Builds is connected to this repo, a push to `main` deploys automatically.
Cloudflare's Cron Trigger (`*/5 * * * *`) runs the background work every five minutes.

## 3. GitHub Actions renderer
1. **Repo must be public** (or have Actions minutes). Public repos get free standard runners (7 GB RAM).
2. Settings → Secrets and variables → Actions → **New repository secret**:
   - `SUPABASE_URL` = `https://brlqdwnpoamvfuhdpdtx.supabase.co`
   - `SUPABASE_SECRET_KEY` = the Supabase secret key
3. Create the token the Worker uses to start renders:
   GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token
   - Repository access: *Only select repositories* → `MemeOS`
   - Permissions → Repository → **Actions: Read and write**; **Contents: Read-only**; **Metadata: Read-only**
   - Copy the token and save it as the Worker secret `GITHUB_TOKEN` (step 2).
4. Actions tab → make sure Actions are enabled for the repo.
5. Test it: Actions → **render-meme** → **Run workflow** — you need real values for `meme_id`, `owner_id`, `text`.
   A green run means the renderer works. A red run shows the error in its logs.

## 4. Render service (retire it)
The old Render web service is no longer used. Render dashboard → memeos → Settings → **Delete web service**
(or suspend it so it stops restarting). The repo no longer has `render-service/`.

## 5. First-run checklist
- Open the app → sign in.
- Settings → API Manager: add your Apify and Groq keys, enable them, test them.
- Run discovery, then open **Pipeline**:
  - *Renderer* should show `github_actions`.
  - *Progress* bars should move.
  - *Running now* shows items being processed; *Queued* shows items waiting for the next cron tick.
  - *Render runs* links to the GitHub Actions run history.
- If an item fails, the error shows in *Stuck and failed items*. Use **Retry** or **Retry all stuck items**.

## Troubleshooting
- **Renderer shows "not_configured":** `GITHUB_TOKEN` or `GITHUB_REPO` is missing on the Worker. Add them and redeploy.
- **"GitHub render dispatch failed (401/403)":** the token is wrong or lacks *Actions: Read and write* on the repo.
- **"GitHub render dispatch failed (404)":** `GITHUB_REPO` is wrong, or `.github/workflows/render-meme.yml` isn't on `main`.
- **Run fails with "Missing SUPABASE_URL" or a Supabase 401:** the GitHub secrets are missing or wrong.
- **Run fails with "Database update failed (4xx)":** check the `memes` table name and that migrations are applied.
- **Items stuck on "rendering":** the job failed or timed out. They retry automatically after 30 minutes, or click **Retry**.
